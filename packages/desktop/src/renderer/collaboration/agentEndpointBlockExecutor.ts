import type {
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  RemoteBlockExecutionReadModel
} from "@planweave-ai/runtime";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteHumanExecutionActionCommand } from "@planweave-ai/collaboration-protocol/remote-run";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { bridge } from "../bridge";
import type { AgentEndpointBlockSelection } from "./agentEndpointRunPlan";
import type { OwnerFleetRemoteDispatchApi } from "./ownerFleetRemoteDispatch";
import {
  type LocalAutoRunObserver,
  runClaimBusLocalAutoRunUnit,
  waitForClaimBusLocalAutoRunUnit
} from "./agentEndpointScopeRun";
import { buildRemoteActionIdentity } from "./remoteRunViewModels";
import { waitForRemoteOperationTerminal } from "./remoteTaskEndpointRun";

type GraphTask = DesktopGraphViewModel["tasks"][number];
type GraphBlock = GraphTask["blocks"][number];
type RemoteOperationsApi = Pick<
  PlanWeaveCollaborationApi,
  | "dispatchCollaborationRemoteOperation"
  | "observeCollaborationRemoteOperation"
  | "executeCollaborationRemoteOperationAction"
  | "onCollaborationObserverSignal"
>;

type RemoteDispatchSurface = {
  dispatch(command: {
    schemaVersion: "remote-run/v3";
    projectId: string;
    canvasId: string;
    blockRef: string;
    agentEndpointId: string;
    idempotencyKey: string;
    expectedResponsibilityRevision: number;
    expectedReviewerRevision: number;
    executionTargetRevision: number;
    contentRevision: string;
    graphFingerprint: string;
  }): Promise<RemoteOperationObservation>;
  observe(input: { operationId: string }): Promise<RemoteOperationObservation>;
  executeAction(input: {
    operationId: string;
    action: RemoteHumanExecutionActionCommand;
  }): Promise<unknown>;
  onObserverSignal?: RemoteOperationsApi["onCollaborationObserverSignal"];
  fallbackRefreshMs?: number;
};

export type RemoteOperationControl = {
  observation: RemoteOperationObservation;
  observe: () => Promise<RemoteOperationObservation>;
  executeAction: (action: RemoteHumanExecutionActionCommand) => Promise<unknown>;
};

const OWNER_FLEET_FALLBACK_REFRESH_MS = 1_000;

function collaborationRemoteDispatchSurface(api: RemoteOperationsApi): RemoteDispatchSurface {
  return {
    dispatch: (command) => api.dispatchCollaborationRemoteOperation(command),
    observe: (input) => api.observeCollaborationRemoteOperation(input),
    executeAction: (input) => api.executeCollaborationRemoteOperationAction(input),
    onObserverSignal: api.onCollaborationObserverSignal
  };
}

function ownerFleetRemoteDispatchSurface(api: OwnerFleetRemoteDispatchApi): RemoteDispatchSurface {
  return {
    dispatch: (command) => api.dispatchOwnerFleetRemoteOperation({ command }),
    observe: (input) => api.observeOwnerFleetRemoteOperation(input),
    executeAction: (input) => api.executeOwnerFleetRemoteOperationAction(input),
    fallbackRefreshMs: OWNER_FLEET_FALLBACK_REFRESH_MS
  };
}

function trackRemoteDispatchSurface(
  api: RemoteDispatchSurface,
  onRemoteOperation?: (control: RemoteOperationControl) => void | Promise<void>
): RemoteDispatchSurface {
  if (!onRemoteOperation) return api;
  const track = async (observation: RemoteOperationObservation) => {
    await onRemoteOperation({
      observation,
      observe: () => api.observe({ operationId: observation.operationId }),
      executeAction: (action) => api.executeAction({ operationId: observation.operationId, action })
    });
    return observation;
  };
  return {
    ...api,
    dispatch: async (command) => track(await api.dispatch(command)),
    observe: async (observeInput) => track(await api.observe(observeInput))
  };
}

/** Live remote-ownership binding for a block (read-model), not a renderer graph snapshot. */
export type ResolveLiveRemoteBinding = (
  blockRef: string
) => Promise<RemoteBlockExecutionReadModel | null>;

const TERMINAL_OPERATION_STATES = new Set<RemoteOperationObservation["state"]>([
  "completed",
  "failed",
  "cancelled"
]);

function nonTerminalOperationId(execution: RemoteBlockExecutionReadModel | null): string | null {
  if (!execution || execution.phase === "terminal") return null;
  return execution.identity.operationId;
}

function isInterruptedObservation(observation: RemoteOperationObservation): boolean {
  return (
    observation.state === "interrupted" ||
    observation.attempt.status === "interrupted" ||
    observation.runtime.status === "interrupted" ||
    Boolean(observation.runtime.interruption)
  );
}

function interruptionResumable(observation: RemoteOperationObservation): boolean {
  const interruption = observation.runtime.interruption;
  return Boolean(interruption?.resumable && interruption.recovery);
}

/**
 * After Host reconnect / partial claim, a non-terminal operation still owns the block.
 * A fresh dispatch collides with that ownership (human_remote_operation_conflict).
 * Recover the same operation via resume/retry when interrupted; otherwise keep waiting
 * on the existing operation (do not mint a second dispatch).
 */
async function recoverExistingRemoteOperation(input: {
  api: RemoteDispatchSurface;
  observation: RemoteOperationObservation;
  createId: () => string;
}): Promise<RemoteOperationObservation> {
  let observation = input.observation;
  if (TERMINAL_OPERATION_STATES.has(observation.state)) {
    return observation;
  }
  if (!isInterruptedObservation(observation)) {
    return observation;
  }
  if (!observation.attempt.leaseId) {
    throw new Error(
      `remote_agent_block_interrupted_missing_lease:${observation.blockRef}:${observation.operationId}`
    );
  }

  const suffix = input.createId();
  if (interruptionResumable(observation)) {
    const action = buildRemoteActionIdentity({
      observation,
      kind: "resume_same_session",
      actionId: `action-resume-${suffix}`,
      reason: "Resume remote attempt after Agent Host reconnection."
    });
    await input.api.executeAction({
      operationId: observation.operationId,
      action
    });
  } else {
    const action = buildRemoteActionIdentity({
      observation,
      kind: "retry_new_attempt",
      actionId: `action-retry-${suffix}`,
      reason: "Retry remote attempt after Agent Host reconnection.",
      newDispatchId: `dispatch-retry-${suffix}`,
      newExecutionAttemptId: `attempt-retry-${suffix}`
    });
    await input.api.executeAction({
      operationId: observation.operationId,
      action
    });
  }

  observation = await input.api.observe({
    operationId: observation.operationId
  });
  if (isInterruptedObservation(observation) && !TERMINAL_OPERATION_STATES.has(observation.state)) {
    throw new Error(
      `remote_agent_block_recovery_still_interrupted:${observation.blockRef}:${observation.operationId}`
    );
  }
  return observation;
}

async function waitForRemoteCompletion(input: {
  api: RemoteDispatchSurface;
  observation: RemoteOperationObservation;
  blockRef: string;
  signal?: AbortSignal;
  waitForRemoteTerminal: typeof waitForRemoteOperationTerminal;
}): Promise<void> {
  const terminal = await input.waitForRemoteTerminal({
    api: {
      observeCollaborationRemoteOperation: (observeInput) => input.api.observe(observeInput),
      onCollaborationObserverSignal: input.api.onObserverSignal ?? (() => () => undefined)
    },
    initial: input.observation,
    signal: input.signal,
    ...(input.api.fallbackRefreshMs === undefined
      ? {}
      : { fallbackRefreshMs: input.api.fallbackRefreshMs })
  });
  if (terminal.state === "completed") return;
  if (terminal.failure) {
    throw new Error(`${terminal.failure.message} (${terminal.failure.code})`);
  }
  throw new Error(`remote_agent_block_${terminal.state}:${input.blockRef}`);
}

export function createAgentEndpointBlockExecutor(input: {
  activeProjectId: string;
  canvasId: string;
  selectionByBlockRef: ReadonlyMap<string, AgentEndpointBlockSelection>;
  collaborationController?: {
    ensureWorkAuthority: (workItem: WorkItemRef) => Promise<{
      revisions: {
        responsibilityRevision: number;
        reviewerRevision: number;
        executionTargetRevision: number;
      };
    } | null>;
  } | null;
  api?: RemoteOperationsApi | null;
  ownerFleetApi?: OwnerFleetRemoteDispatchApi | null;
  resolveRemoteWorkAuthority?: (workItem: WorkItemRef) => Promise<{
    revisions: {
      responsibilityRevision: number;
      reviewerRevision: number;
      executionTargetRevision: number;
    };
  } | null>;
  resolveRemoteContentAuthority?: () => Promise<{
    contentRevision: string;
    graphFingerprint: string;
  } | null>;
  /**
   * Authority for existing-operation recovery: live remoteExecution read-model for the block.
   * Must not be derived from the renderer graph snapshot captured at run start (C3).
   */
  resolveLiveRemoteBinding: ResolveLiveRemoteBinding;
  createId: () => string;
  startLocal: (
    scope: DesktopAutoRunScope,
    options?: { stepLimit?: number }
  ) => Promise<DesktopAutoRunState | null | undefined>;
  /** Required so step-limit paused runs release the workspace for the next claim-bus unit. */
  stopLocal: (runId: string) => Promise<unknown>;
  localAutoRunApi?: LocalAutoRunObserver | null;
  waitForLocalUnit?: typeof waitForClaimBusLocalAutoRunUnit;
  waitForRemoteTerminal?: typeof waitForRemoteOperationTerminal;
  onRemoteOperation?: (control: RemoteOperationControl) => void | Promise<void>;
}): (task: GraphTask, block: GraphBlock, signal?: AbortSignal) => Promise<void> {
  const waitForRemoteTerminal = input.waitForRemoteTerminal ?? waitForRemoteOperationTerminal;
  const baseRemoteDispatch =
    input.ownerFleetApi !== undefined && input.ownerFleetApi !== null
      ? ownerFleetRemoteDispatchSurface(input.ownerFleetApi)
      : input.api
        ? collaborationRemoteDispatchSurface(input.api)
        : null;
  const remoteDispatch = baseRemoteDispatch
    ? trackRemoteDispatchSurface(baseRemoteDispatch, input.onRemoteOperation)
    : null;

  const executeLocal = async (selection: AgentEndpointBlockSelection, signal?: AbortSignal) => {
    const localApi = input.localAutoRunApi === undefined ? bridge : input.localAutoRunApi;
    if (!localApi) throw new Error("desktop_bridge_unavailable");
    // Real Auto Run ends stepLimit:1 as paused + "Step limit reached."; release via stopLocal.
    await runClaimBusLocalAutoRunUnit({
      scope: { kind: "block", blockRef: selection.block.ref },
      startLocal: input.startLocal,
      stopLocal: input.stopLocal,
      api: localApi,
      unitLabel: selection.block.ref,
      signal,
      waitForUnit: input.waitForLocalUnit
    });
  };

  const executeRemote = async (selection: AgentEndpointBlockSelection, signal?: AbortSignal) => {
    if (!remoteDispatch) throw new Error("owner_fleet_dispatch_unavailable");
    // Live binding only — selection.block.remoteExecution is a stale run-start snapshot for UI.
    const liveBinding = await input.resolveLiveRemoteBinding(selection.block.ref);
    const existingOperationId = nonTerminalOperationId(liveBinding);

    if (existingOperationId) {
      let observation = await remoteDispatch.observe({
        operationId: existingOperationId
      });
      observation = await recoverExistingRemoteOperation({
        api: remoteDispatch,
        observation,
        createId: input.createId
      });
      if (observation.state === "completed") return;
      if (TERMINAL_OPERATION_STATES.has(observation.state)) {
        if (observation.failure) {
          throw new Error(`${observation.failure.message} (${observation.failure.code})`);
        }
        throw new Error(`remote_agent_block_${observation.state}:${selection.block.ref}`);
      }
      await waitForRemoteCompletion({
        api: remoteDispatch,
        observation,
        blockRef: selection.block.ref,
        signal,
        waitForRemoteTerminal
      });
      return;
    }

    const remoteEndpointId = selection.endpoint.remoteEndpointId;
    if (!remoteEndpointId) throw new Error("owner_fleet_endpoint_unavailable");
    const workItem = {
      kind: "block" as const,
      canvasId: input.canvasId,
      blockRef: selection.block.ref
    };
    const authority =
      (await input.resolveRemoteWorkAuthority?.(workItem)) ??
      (input.collaborationController
        ? await input.collaborationController.ensureWorkAuthority(workItem)
        : null);
    if (!authority) throw new Error("work_authority_unavailable");
    const contentAuthority = await input.resolveRemoteContentAuthority?.();
    if (!contentAuthority) throw new Error("remote_content_authority_unavailable");
    const dispatched = await remoteDispatch.dispatch({
      schemaVersion: "remote-run/v3",
      projectId: input.activeProjectId,
      canvasId: input.canvasId,
      blockRef: selection.block.ref,
      agentEndpointId: remoteEndpointId,
      idempotencyKey: `desktop-dispatch-${input.createId()}`,
      expectedResponsibilityRevision: authority.revisions.responsibilityRevision,
      expectedReviewerRevision: authority.revisions.reviewerRevision,
      executionTargetRevision: authority.revisions.executionTargetRevision,
      ...contentAuthority
    });
    await waitForRemoteCompletion({
      api: remoteDispatch,
      observation: dispatched,
      blockRef: selection.block.ref,
      signal,
      waitForRemoteTerminal
    });
  };

  const adapters = { local: executeLocal, remote: executeRemote };
  return async (_task, block, signal) => {
    const selection = input.selectionByBlockRef.get(block.ref);
    if (!selection) throw new Error(`agent_endpoint_selection_missing:${block.ref}`);
    // Implementation and review both follow the Task Endpoint selection (local Auto Run or remote Host).
    await adapters[selection.endpoint.source](selection, signal);
  };
}

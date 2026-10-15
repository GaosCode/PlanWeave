import { createWorkspaceScopeCancellation } from "../collaboration/workspaceScopeCancellation";
import {
  restoreWorkspaceScopeCancellation,
  type ActiveEndpointScopeRun,
  type EndpointScopeCancellationState,
  type WorkspaceScopeSession,
  type WorkspaceAgentEndpointScopeLifecycle
} from "../collaboration/workspaceScopeCancellationRecovery";
export type { EndpointScopeCancellationState } from "../collaboration/workspaceScopeCancellationRecovery";
import type {
  ClaimResult,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { RemoteCollaborationCanvasBindingInput } from "../../shared/collaboration";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";
import type { DesktopUiSettings } from "../../shared/desktopSettings";
import {
  bridge,
  collaborationBridge,
  desktopCanvasReference,
  workspaceExecutionBridge
} from "../bridge";
import type { CanvasLocator } from "../../shared/canvasLocator";
import type {
  DesktopWorkspaceExecutionStartInput,
  PlanWeaveWorkspaceExecutionApi
} from "../../shared/workspaceExecution";
import { projectWorkspaceExecutionTimeline } from "@planweave-ai/runtime/browser";
import {
  createAgentEndpointRunPlan,
  type AgentEndpointBlockSelection
} from "../collaboration/agentEndpointRunPlan";
import { createLocalAgentEndpointBlockExecutor } from "../collaboration/localAgentEndpointBlockExecutor";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import { createRemoteEndpointDispatchGate } from "../collaboration/remoteEndpointDispatchGate";
import { runWorkspaceRemoteScopeFromAvailability } from "../collaboration/workspaceRemoteScopeScheduler";
import {
  type LocalAutoRunObserver,
  runClaimBusLocalAutoRunUnit,
  waitForClaimBusLocalAutoRunUnit,
  waitForLocalAutoRunTerminal
} from "../collaboration/agentEndpointScopeRun";
import { runClaimBusScope } from "../collaboration/claimBusScheduler";
import type { CollaborationRuntimeAvailabilityView } from "../collaboration/runtimeAvailabilityView";
import {
  collaborationRuntimeStartAllowed,
  collaborationRuntimeUnavailableCode
} from "../collaboration/runtimeAvailabilityView";

import {
  workspaceExecutionPollingKey,
  workspaceExecutionSuccessPollDelay
} from "../task-workspace/workspaceExecutionPollingCadence";

function waitForWorkspaceCollaborationSignal(input: {
  api?: Pick<PlanWeaveCollaborationApi, "onCollaborationObserverSignal"> | null;
  signal?: AbortSignal;
  fallbackRefreshMs: number;
  matches: (signal: CollaborationObserverSignal) => boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const cancel = () => {
      cleanup();
      reject(new Error("workspace_remote_scope_cancelled"));
    };
    if (input.signal?.aborted) {
      cancel();
      return;
    }
    if (input.api) {
      unsubscribe = input.api.onCollaborationObserverSignal((signal) => {
        if (input.matches(signal)) finish();
      });
    }
    if (settled) {
      unsubscribe?.();
      return;
    }
    timer = setTimeout(finish, input.fallbackRefreshMs);
    input.signal?.addEventListener("abort", cancel, { once: true });
  });
}

function waitForWorkspaceRuntimeProjectionChange(input: {
  api: Pick<PlanWeaveCollaborationApi, "onCollaborationObserverSignal">;
  binding: RemoteCollaborationCanvasBindingInput;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
}): Promise<void> {
  return waitForWorkspaceCollaborationSignal({
    api: input.api,
    signal: input.signal,
    fallbackRefreshMs: input.fallbackRefreshMs ?? 1_000,
    matches: (signal) => {
      if (!("projectId" in signal)) return false;
      if (signal.projectId !== input.binding.projectId) return false;
      if (signal.type === "human.observer.catchup_required") return true;
      return (
        signal.type === "human.observer.event" &&
        signal.event.kind === "runtime" &&
        signal.event.canvasId === input.binding.canvasId
      );
    }
  });
}

function createDispatchId(): string {
  return crypto.randomUUID();
}

function waitForWorkspaceExecutionFollow(input: {
  signal: AbortSignal;
  api?: Pick<PlanWeaveCollaborationApi, "onCollaborationObserverSignal"> | null;
  binding?: RemoteCollaborationCanvasBindingInput | null;
  pollingKey: string;
  noProgressCount: number;
}): Promise<void> {
  const binding = input.binding;
  return waitForWorkspaceCollaborationSignal({
    api: binding ? input.api : null,
    signal: input.signal,
    fallbackRefreshMs: workspaceExecutionSuccessPollDelay(input.noProgressCount, input.pollingKey),
    matches: (signal) => {
      if (!("projectId" in signal)) return false;
      if (!binding || signal.projectId !== binding.projectId) return false;
      if (signal.type === "human.observer.catchup_required") return true;
      if (signal.type !== "human.observer.event") return false;
      if (signal.event.kind === "runtime" && signal.event.canvasId === binding.canvasId) {
        return true;
      }
      if (signal.event.kind === "remote_run") {
        const canvasId = signal.event.workItem?.canvasId ?? signal.event.canvasId;
        return canvasId === undefined || canvasId === binding.canvasId;
      }
      return false;
    }
  });
}

type GraphTask = DesktopGraphViewModel["tasks"][number];

type WorkspaceAgentEndpointRunInput = {
  activeProjectId: string | null;
  agentEndpoints: readonly AvailableAgentEndpoint[];
  collaborationController: object | null;
  canvasBinding?: RemoteCollaborationCanvasBindingInput | null;
  canvasLocator?: CanvasLocator | null;
  graph: DesktopGraphViewModel | null;
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  operatorProfileId?: string | null;
  humanPrincipalId?: string | null;
  runtimeAvailability: CollaborationRuntimeAvailabilityView;
  workspaceRuntimeAuthorityKey?: string | null;
  setError: (message: string | null) => void;
  api?: Pick<
    PlanWeaveCollaborationApi,
    "onCollaborationObserverSignal" | "readCollaborationCanvasBindingRuntimeAvailability"
  > | null;
  createId?: () => string;
  localAutoRunApi?: LocalAutoRunObserver | null;
  waitForLocalTerminal?: typeof waitForLocalAutoRunTerminal;
  waitForLocalUnit?: typeof waitForClaimBusLocalAutoRunUnit;
  workspaceExecutionApi?: PlanWeaveWorkspaceExecutionApi | null;
  /** Injectable stop for claim-bus one-unit release (defaults to bridge.stopAutoRun). */
  stopLocal?: (runId: string, expectedStatePath: string) => Promise<unknown>;
  /**
   * Injectable dry-run claim preview (defaults to desktop bridge.previewClaimNext).
   * Used by claim-bus coordinated scopes only.
   */
  previewClaimNext?: (
    ref: DesktopCanvasReference,
    scope: DesktopAutoRunScope
  ) => Promise<ClaimResult>;
};

export type LocalAutoRunScopeStarter = (
  scope: DesktopAutoRunScope,
  options?: { stepLimit?: number }
) => Promise<DesktopAutoRunState | null | undefined>;

export type WorkspaceAgentEndpointScopeStarter = (
  scope: DesktopAutoRunScope,
  startLocal: LocalAutoRunScopeStarter,
  lifecycle?: WorkspaceAgentEndpointScopeLifecycle
) => Promise<void>;

export type WorkspaceAgentEndpointScopeController = WorkspaceAgentEndpointScopeStarter & {
  stop: () => Promise<void>;
  cancellation: EndpointScopeCancellationState | null;
};

function scopeTaskIds(
  plan:
    | { kind: "coordinated_scope"; tasks: readonly GraphTask[] }
    | { kind: "coordinated_block"; selection: { task: GraphTask } }
): readonly string[] {
  if (plan.kind === "coordinated_block") return [plan.selection.task.taskId];
  return plan.tasks.map((task) => task.taskId);
}

export function useWorkspaceAgentEndpointRun(
  input: WorkspaceAgentEndpointRunInput
): WorkspaceAgentEndpointScopeController {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const executionApi =
    input.workspaceExecutionApi === undefined
      ? workspaceExecutionBridge
      : input.workspaceExecutionApi;
  const createId = input.createId ?? createDispatchId;
  const activeEndpointScopeRun = useRef<ActiveEndpointScopeRun | null>(null);
  const retainedRuns = useRef(new Map<string, ActiveEndpointScopeRun>());
  const [cancellation, setCancellation] = useState<EndpointScopeCancellationState | null>(null);
  const executionScopeIdentity = input.canvasBinding
    ? (input.workspaceRuntimeAuthorityKey ??
      `${input.canvasBinding.workspaceId}:${input.canvasBinding.projectId}:${input.canvasBinding.canvasId}`)
    : JSON.stringify([
        input.selectedProject?.rootPath ?? null,
        input.selectedProject?.workspaceRoot ?? null,
        input.selectedCanvasId
      ]);
  const previousExecutionScopeIdentity = useRef(executionScopeIdentity);
  const activeExecutionScopeIdentity = useRef(executionScopeIdentity);
  const executionRequestEpoch = useRef(0);
  activeExecutionScopeIdentity.current = executionScopeIdentity;

  const publishCancellation = useCallback((run: ActiveEndpointScopeRun) => {
    if (!run.controller.signal.aborted) return;
    if (
      run.settled &&
      run.workspaceSessions.size === 0 &&
      run.pendingWorkspaceStarts.size === 0 &&
      run.workspaceStarts.size === 0
    ) {
      if (retainedRuns.current.get(run.scopeIdentity) !== run) return;
      retainedRuns.current.delete(run.scopeIdentity);
      if (activeEndpointScopeRun.current === run) activeEndpointScopeRun.current = null;
      if (activeExecutionScopeIdentity.current === run.scopeIdentity) setCancellation(null);
      if (!run.failed) run.lifecycle?.onCancelled?.();
      return;
    }
    const sessions: EndpointScopeCancellationState["sessions"] = [
      ...run.workspaceSessions.entries()
    ].map(([blockRef, session]) => ({
      blockRef,
      sessionId: session.sessionId,
      status: run.cancellationRequests.has(session.sessionId)
        ? "in_flight"
        : session.error
          ? "failed"
          : "pending",
      error: session.error
    }));
    sessions.push(
      ...[...run.workspaceStarts.values()].map((start) => ({
        blockRef: start.input.blockRef,
        sessionId: start.startRequestId,
        status: run.cancellationRequests.has(start.startRequestId)
          ? ("in_flight" as const)
          : start.error
            ? ("failed" as const)
            : ("pending" as const),
        error: start.error
      }))
    );
    const state: EndpointScopeCancellationState = {
      scopeIdentity: run.scopeIdentity,
      phase: sessions.some((session) => session.status === "failed") ? "failed" : "cancelling",
      sessions
    };
    if (activeExecutionScopeIdentity.current === run.scopeIdentity) setCancellation(state);
    run.lifecycle?.onCancellationChanged?.(state);
  }, []);

  const { cancelSession: cancelWorkspaceSession, abortRun } = useMemo(
    () =>
      createWorkspaceScopeCancellation({
        api: executionApi,
        createId,
        publish: publishCancellation
      }),
    [createId, executionApi, publishCancellation]
  );
  const abortRunRef = useRef(abortRun);
  abortRunRef.current = abortRun;

  useEffect(() => {
    if (previousExecutionScopeIdentity.current !== executionScopeIdentity) {
      previousExecutionScopeIdentity.current = executionScopeIdentity;
      executionRequestEpoch.current += 1;
      if (activeEndpointScopeRun.current) void abortRunRef.current(activeEndpointScopeRun.current);
      activeEndpointScopeRun.current = retainedRuns.current.get(executionScopeIdentity) ?? null;
      setCancellation(null);
      if (activeEndpointScopeRun.current) publishCancellation(activeEndpointScopeRun.current);
    }
  }, [executionScopeIdentity, publishCancellation]);

  useEffect(
    () => () => {
      if (activeEndpointScopeRun.current) void abortRunRef.current(activeEndpointScopeRun.current);
    },
    []
  );

  const recoveryLocator =
    input.canvasLocator?.kind === "workspace"
      ? input.canvasLocator
      : input.canvasLocator &&
          input.selectedProject &&
          input.operatorProfileId &&
          input.humanPrincipalId &&
          input.graph
        ? {
            kind: "owner_canvas" as const,
            operatorProfileId: input.operatorProfileId,
            humanPrincipalId: input.humanPrincipalId,
            projectRoot: input.selectedProject.rootPath,
            projectId: input.graph.projectId,
            canvasId: input.canvasLocator.canvasId
          }
        : null;
  const recoveryPending = useRef(new Map<string, Promise<void>>());
  const recoveryUnconfirmed = useRef(new Set<string>());
  const recoveryInput = useRef({ executionApi, recoveryLocator, executionScopeIdentity });
  recoveryInput.current = { executionApi, recoveryLocator, executionScopeIdentity };
  const recoverCancellation = useCallback(async () => {
    const { executionApi: currentApi, recoveryLocator: locator } = recoveryInput.current;
    if (
      !currentApi ||
      !locator ||
      recoveryInput.current.executionScopeIdentity !== executionScopeIdentity ||
      retainedRuns.current.has(executionScopeIdentity)
    )
      return;
    const pending = recoveryPending.current.get(executionScopeIdentity);
    if (pending) return pending;
    const recovery = Promise.resolve().then(async () => {
      recoveryUnconfirmed.current.add(executionScopeIdentity);
      if (activeExecutionScopeIdentity.current === executionScopeIdentity)
        setCancellation({
          scopeIdentity: executionScopeIdentity,
          phase: "recovering",
          sessions: []
        });
      try {
        const recovered = await currentApi.recoverWorkspaceExecutionCancellations({ locator });
        recoveryUnconfirmed.current.delete(executionScopeIdentity);
        if (retainedRuns.current.has(executionScopeIdentity)) return;
        const run = restoreWorkspaceScopeCancellation({
          recovered,
          locator,
          scopeIdentity: executionScopeIdentity
        });
        if (run) {
          retainedRuns.current.set(executionScopeIdentity, run);
          if (activeExecutionScopeIdentity.current === executionScopeIdentity)
            activeEndpointScopeRun.current = run;
          publishCancellation(run);
        } else if (activeExecutionScopeIdentity.current === executionScopeIdentity)
          setCancellation(null);
      } catch (error) {
        if (activeExecutionScopeIdentity.current === executionScopeIdentity) {
          setCancellation({ scopeIdentity: executionScopeIdentity, phase: "failed", sessions: [] });
          input.setError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        recoveryPending.current.delete(executionScopeIdentity);
      }
    });
    recoveryPending.current.set(executionScopeIdentity, recovery);
    return recovery;
  }, [executionScopeIdentity, input.setError, publishCancellation]);
  const recoveryCallback = useRef(recoverCancellation);
  recoveryCallback.current = recoverCancellation;
  const recoveryLocatorKey = JSON.stringify(recoveryLocator);
  useEffect(() => {
    if (
      activeExecutionScopeIdentity.current !== executionScopeIdentity ||
      JSON.stringify(recoveryInput.current.recoveryLocator) !== recoveryLocatorKey
    )
      return;
    void recoveryCallback.current().catch(() => undefined);
  }, [executionScopeIdentity, recoveryLocatorKey]);

  const startScope = useCallback(
    async (
      scope: DesktopAutoRunScope,
      startLocal: LocalAutoRunScopeStarter,
      lifecycle?: WorkspaceAgentEndpointScopeLifecycle
    ) => {
      await recoveryPending.current.get(executionScopeIdentity);
      if (activeExecutionScopeIdentity.current !== executionScopeIdentity) return;
      if (!input.graph || !input.selectedCanvasId) return;
      const remoteBinding = input.canvasBinding ?? null;
      const remoteCanvasOnly = !input.selectedProject && remoteBinding !== null;
      const endpoints = remoteCanvasOnly
        ? input.agentEndpoints.filter((endpoint) => endpoint.source === "remote")
        : input.agentEndpoints;
      const plan = createAgentEndpointRunPlan({
        graph: input.graph,
        scope,
        endpoints,
        preferences: input.preferences,
        project: input.selectedProject,
        remoteCanvas: input.canvasBinding,
        canvasId: input.selectedCanvasId
      });
      if (plan.kind === "noop") return;
      if (plan.kind === "rejected") {
        input.setError(plan.reason);
        return;
      }
      if (remoteCanvasOnly && remoteBinding.canvasId !== input.selectedCanvasId) {
        input.setError("collaboration_canvas_binding_scope_mismatch");
        return;
      }
      if (plan.kind === "local_scope") {
        if (remoteCanvasOnly) {
          input.setError("content_local_canvas_binding_required");
          return;
        }
        await startLocal(plan.scope);
        return;
      }
      const usesRemoteEndpoint =
        plan.kind === "coordinated_block"
          ? plan.selection.endpoint.source === "remote"
          : [...plan.selectionByBlockRef.values()].some(
              (selection) => selection.endpoint.source === "remote"
            );
      const usesWorkspaceRuntime = remoteBinding !== null;
      if (usesWorkspaceRuntime && !collaborationRuntimeStartAllowed(input.runtimeAvailability)) {
        const message =
          collaborationRuntimeUnavailableCode(input.runtimeAvailability) ??
          "collaboration_runtime_unavailable";
        input.setError(message);
        lifecycle?.onFailed(message);
        return;
      }
      if (usesRemoteEndpoint && (!executionApi || !input.canvasLocator)) {
        input.setError("workspace_execution_bridge_unavailable");
        return;
      }
      if (
        !input.selectedProject &&
        (!remoteCanvasOnly ||
          (plan.kind === "coordinated_block"
            ? plan.selection.endpoint.source !== "remote"
            : [...plan.selectionByBlockRef.values()].some(
                (selection) => selection.endpoint.source !== "remote"
              )))
      ) {
        input.setError("content_local_canvas_binding_required");
        return;
      }
      if (
        !usesRemoteEndpoint &&
        (!input.activeProjectId || !input.selectedProject || !input.collaborationController || !api)
      ) {
        input.setError("collaboration_project_unavailable");
        return;
      }
      if (
        recoveryUnconfirmed.current.has(executionScopeIdentity) ||
        retainedRuns.current.has(executionScopeIdentity)
      ) {
        input.setError("agent_endpoint_scope_run_already_active");
        return;
      }

      const selectedProject = input.selectedProject;
      const selectedCanvasId = input.selectedCanvasId;
      const graphProjectId = input.graph.projectId;
      const canvasRef = selectedProject
        ? desktopCanvasReference(selectedProject, selectedCanvasId)
        : null;
      const executionProjectId =
        input.canvasBinding?.kind === "remote"
          ? input.canvasBinding.projectId
          : (input.activeProjectId ?? selectedProject?.projectId);
      if (!executionProjectId) {
        input.setError("collaboration_project_unavailable");
        return;
      }

      const controller = new AbortController();
      const activeRun: ActiveEndpointScopeRun = {
        scopeIdentity: executionScopeIdentity,
        lifecycle,
        settled: false,
        failed: false,
        cancellationRequests: new Map(),
        controller,
        pendingWorkspaceStarts: new Set(),
        workspaceStarts: new Map(),
        workspaceSessions: new Map()
      };
      const requestEpoch = executionRequestEpoch.current;
      const requestScopeIdentity = executionScopeIdentity;
      const requestIsCurrent = () =>
        !(
          controller.signal.aborted ||
          executionRequestEpoch.current !== requestEpoch ||
          activeExecutionScopeIdentity.current !== requestScopeIdentity ||
          activeEndpointScopeRun.current !== activeRun
        );
      const assertCurrentRequest = () => {
        if (!requestIsCurrent()) {
          throw new Error("workspace_remote_scope_cancelled");
        }
      };
      activeEndpointScopeRun.current = activeRun;
      retainedRuns.current.set(executionScopeIdentity, activeRun);
      const completeLifecycle = () => {
        if (controller.signal.aborted) throw new Error("workspace_remote_scope_cancelled");
        lifecycle?.onCompleted();
      };
      const remoteDispatchGate = createRemoteEndpointDispatchGate();
      lifecycle?.onStarted();
      const stopLocal =
        input.stopLocal ??
        (async (runId: string, expectedStatePath: string) => {
          if (!bridge) throw new Error("desktop_bridge_unavailable");
          return bridge.stopAutoRun(runId, expectedStatePath);
        });
      const previewClaimNext =
        input.previewClaimNext ??
        ((ref: DesktopCanvasReference, claimScope: DesktopAutoRunScope) => {
          if (!bridge) throw new Error("desktop_bridge_unavailable");
          return bridge.previewClaimNext(ref, claimScope);
        });

      try {
        const selectionByBlockRef =
          plan.kind === "coordinated_block"
            ? new Map([[plan.selection.block.ref, plan.selection]])
            : plan.selectionByBlockRef;
        const executeWorkspaceSelection = async (
          selection: AgentEndpointBlockSelection,
          signal: AbortSignal
        ) => {
          if (!executionApi || !input.canvasLocator) {
            throw new Error("workspace_execution_bridge_unavailable");
          }
          const endpointId = selection.endpoint.remoteEndpointId;
          const agentId = selection.endpoint.agentId;
          if (!endpointId || !agentId) {
            throw new Error(`agent_endpoint_selection_missing:${selection.block.ref}`);
          }
          const effectiveExecutor = {
            name: selection.endpoint.executorName,
            agentId
          };
          let startInput: DesktopWorkspaceExecutionStartInput;
          if (input.canvasLocator.kind === "workspace") {
            startInput = {
              locator: input.canvasLocator,
              blockRef: selection.block.ref,
              agentEndpointId: endpointId,
              effectiveExecutor
            };
          } else {
            if (!input.selectedProject || !input.operatorProfileId || !input.humanPrincipalId) {
              throw new Error("owner_canvas_execution_authority_unavailable");
            }
            startInput = {
              locator: {
                kind: "owner_canvas",
                operatorProfileId: input.operatorProfileId,
                humanPrincipalId: input.humanPrincipalId,
                projectRoot: input.selectedProject.rootPath,
                projectId: graphProjectId,
                canvasId: input.canvasLocator.canvasId
              },
              blockRef: selection.block.ref,
              agentEndpointId: endpointId,
              effectiveExecutor
            };
          }
          const startRequestId = createId();
          startInput = { ...startInput, startRequestId };
          activeRun.workspaceStarts.set(startRequestId, {
            input: startInput,
            startRequestId,
            actionId: null,
            reason: "Desktop Auto Run stop requested.",
            error: null
          });
          const startSettlement = executionApi.startWorkspaceExecution(startInput).then(
            async (view) => {
              activeRun.workspaceStarts.delete(startRequestId);
              const session: WorkspaceScopeSession = {
                input: startInput,
                sessionId: view.session.sessionId,
                handle: view.handle,
                actionId: null,
                reason: "Desktop Auto Run stop requested.",
                error: null
              };
              activeRun.workspaceSessions.set(selection.block.ref, session);
              if (!requestIsCurrent()) {
                await cancelWorkspaceSession(activeRun, selection.block.ref, session);
                return { kind: "cancelled" as const };
              }
              return { kind: "started" as const, view };
            },
            (error: unknown) => {
              throw error;
            }
          );
          const pendingStart = startSettlement.then(() => undefined);
          void pendingStart.catch(() => undefined);
          activeRun.pendingWorkspaceStarts.add(pendingStart);
          let settlement: Awaited<typeof startSettlement>;
          try {
            settlement = await startSettlement;
          } finally {
            activeRun.pendingWorkspaceStarts.delete(pendingStart);
          }
          if (settlement.kind === "cancelled") {
            throw new Error("workspace_remote_scope_cancelled");
          }
          let view = settlement.view;
          const sessionId = view.session.sessionId;
          const events = [...view.events];
          let confirmedTerminal = false;
          let noProgressCount = 0;
          try {
            for (;;) {
              if (signal.aborted) throw new Error("workspace_remote_scope_cancelled");
              const timeline = projectWorkspaceExecutionTimeline(events);
              confirmedTerminal =
                Boolean(timeline.terminalOutcome) ||
                ["completed", "failed", "stopped"].includes(view.session.phase);
              if (timeline.terminalOutcome === "completed") return;
              if (timeline.terminalOutcome === "cancelled") {
                controller.abort();
                throw new Error("workspace_remote_scope_cancelled");
              }
              if (timeline.terminalOutcome) {
                throw new Error(
                  view.session.error ??
                    `remote_agent_block_${timeline.terminalOutcome}:${selection.block.ref}`
                );
              }
              if (view.session.phase === "failed" || view.session.phase === "stopped") {
                throw new Error(
                  view.session.error ??
                    `remote_agent_block_${view.session.phase}:${selection.block.ref}`
                );
              }
              if (view.events.some((event) => event.type === "action_required")) {
                throw new Error(`remote_agent_block_action_required:${selection.block.ref}`);
              }
              await waitForWorkspaceExecutionFollow({
                signal,
                api,
                binding: input.canvasBinding?.kind === "remote" ? input.canvasBinding : null,
                pollingKey: workspaceExecutionPollingKey(sessionId, selection.block.ref),
                noProgressCount
              });
              view = await executionApi.followWorkspaceExecution({ ...startInput, sessionId });
              assertCurrentRequest();
              const session = activeRun.workspaceSessions.get(selection.block.ref);
              if (session && !session.actionId) session.handle = view.handle;
              events.push(...view.events);
              noProgressCount = view.events.length > 0 ? 0 : noProgressCount + 1;
            }
          } finally {
            if (confirmedTerminal) {
              activeRun.workspaceSessions.delete(selection.block.ref);
            }
          }
        };
        const executeLocalBlock = async (
          selection: AgentEndpointBlockSelection,
          signal?: AbortSignal
        ) => {
          if (!selectedProject) throw new Error("content_local_canvas_binding_required");
          await createLocalAgentEndpointBlockExecutor({
            workspaceRoot: selectedProject.workspaceRoot,
            startLocal,
            stopLocal,
            localAutoRunApi: input.localAutoRunApi,
            waitForLocalUnit: input.waitForLocalUnit
          })(selection, signal);
        };

        const executeSelectionByRef = async (ref: string, signal?: AbortSignal) => {
          const selection = selectionByBlockRef.get(ref);
          if (!selection) throw new Error(`agent_endpoint_selection_missing:${ref}`);
          if (selection.endpoint.source === "remote") {
            if (!signal) throw new Error("workspace_execution_abort_signal_required");
            await executeWorkspaceSelection(selection, signal);
            return;
          }
          await executeLocalBlock(selection, signal);
        };

        if (remoteCanvasOnly) {
          if (plan.kind === "coordinated_block") {
            await executeSelectionByRef(plan.selection.block.ref, controller.signal);
          } else {
            if (!api || !remoteBinding) {
              throw new Error("collaboration_runtime_availability_unavailable");
            }
            await runWorkspaceRemoteScopeFromAvailability({
              graph: input.graph,
              scope,
              binding: remoteBinding,
              readAvailability: () =>
                api.readCollaborationCanvasBindingRuntimeAvailability(remoteBinding),
              execute: executeSelectionByRef,
              waitForStatusChange: (signal) =>
                waitForWorkspaceRuntimeProjectionChange({ api, binding: remoteBinding, signal }),
              signal: controller.signal
            });
          }
          completeLifecycle();
          return;
        }

        if (!canvasRef || !selectedProject) {
          throw new Error("content_local_canvas_binding_required");
        }

        const executeClaimUnit = async (ref: string, signal?: AbortSignal) => {
          const selection = selectionByBlockRef.get(ref);
          if (!selection) throw new Error(`agent_endpoint_selection_missing:${ref}`);
          if (selection.endpoint.source === "local") {
            await executeLocalBlock(selection, signal);
            return;
          }
          if (!signal) throw new Error("workspace_execution_abort_signal_required");
          await remoteDispatchGate.run({
            endpointId: selection.endpoint.remoteEndpointId ?? selection.endpoint.id,
            execute: () => executeWorkspaceSelection(selection, signal),
            signal
          });
        };

        const taskIds = new Set(scopeTaskIds(plan));
        const scopedBlockRefs =
          scope.kind === "block"
            ? [scope.blockRef]
            : input.graph.tasks
                .filter((task) => taskIds.has(task.taskId))
                .flatMap((task) => task.blocks.map((block) => block.ref));

        const isBlockSatisfied = async (blockRef: string): Promise<boolean> => {
          if (!bridge) throw new Error("desktop_bridge_unavailable");
          const detail = await bridge.getBlockDetail(canvasRef, blockRef);
          return detail.status === "completed";
        };

        const isScopeSatisfied = async (options?: { refresh?: boolean }) => {
          const check = async () => {
            for (const blockRef of scopedBlockRefs) {
              if (!(await isBlockSatisfied(blockRef))) return false;
            }
            return true;
          };
          if (await check()) return true;
          if (options?.refresh) return check();
          return false;
        };

        await runClaimBusScope({
          scope,
          preview: {
            previewNext: (claimScope) => previewClaimNext(canvasRef, claimScope)
          },
          route: {
            routeForBlock: (ref) => {
              const selection = selectionByBlockRef.get(ref);
              if (!selection) throw new Error(`agent_endpoint_selection_missing:${ref}`);
              return selection.endpoint.source === "remote" ? "remote" : "local";
            }
          },
          localBlock: { execute: executeClaimUnit },
          remoteBlock: { execute: executeClaimUnit },
          feedback: {
            execute: async (claim, signal) => {
              const localApi = input.localAutoRunApi === undefined ? bridge : input.localAutoRunApi;
              if (!localApi) throw new Error("desktop_bridge_unavailable");
              // One claim unit only; real stepLimit ends paused and must be stopped.
              await runClaimBusLocalAutoRunUnit({
                scope: { kind: "task", taskId: claim.taskId },
                startLocal,
                stopLocal,
                api: localApi,
                workspaceRoot: selectedProject.workspaceRoot,
                unitLabel: `feedback:${claim.feedbackId}`,
                signal,
                waitForUnit: input.waitForLocalUnit
              });
            }
          },
          completion: {
            isSatisfied: async (options) => {
              if (!usesWorkspaceRuntime) {
                return isScopeSatisfied(options);
              }
              const readAvailability = async () => {
                if (!api) throw new Error("collaboration_runtime_availability_unavailable");
                if (!remoteBinding) {
                  throw new Error("collaboration_runtime_availability_unavailable");
                }
                const availability =
                  await api.readCollaborationCanvasBindingRuntimeAvailability(remoteBinding);
                if (!availability) {
                  throw new Error("collaboration_runtime_availability_unavailable");
                }
                return availability;
              };

              // refresh: dedicated re-read so claim-none idle cannot use a lagging projection.
              // Authority stays on collaboration runtime status (not local Auto Run state).
              let availability = await readAvailability();
              if (options?.refresh) {
                availability = await readAvailability();
              }
              if (availability.state.kind === "uninitialized") {
                if (availability.execution.kind === "unavailable") {
                  throw new Error(`collaboration_runtime_${availability.execution.reason}`);
                }
                return false;
              }
              const status = availability.state.status;

              if (scope.kind === "block") {
                const row = status.blocks.find((block) => block.ref === scope.blockRef);
                if (!row) {
                  throw new Error(
                    `collaboration_runtime_block_status_unavailable:${scope.blockRef}`
                  );
                }
                return row.status === "completed";
              }

              for (const taskId of taskIds) {
                if (!status.tasks.some((task) => task.taskId === taskId)) {
                  throw new Error(`collaboration_runtime_task_status_unavailable:${taskId}`);
                }
              }
              return status.tasks
                .filter((task) => taskIds.has(task.taskId))
                .every((task) => task.status === "implemented");
            }
          },
          signal: controller.signal
        });
        completeLifecycle();
      } catch (caught) {
        const cancelled = controller.signal.aborted;
        const message = caught instanceof Error ? caught.message : String(caught);
        if (cancelled) {
          return;
        }
        activeRun.failed = true;
        if (activeExecutionScopeIdentity.current === activeRun.scopeIdentity) {
          input.setError(message);
          lifecycle?.onFailed(message);
        }
      } finally {
        activeRun.settled = true;
        if (controller.signal.aborted || activeRun.failed) void abortRun(activeRun);
        if (
          activeRun.workspaceSessions.size ||
          activeRun.pendingWorkspaceStarts.size ||
          activeRun.workspaceStarts.size
        ) {
          publishCancellation(activeRun);
        } else if (controller.signal.aborted) {
          publishCancellation(activeRun);
        } else {
          retainedRuns.current.delete(activeRun.scopeIdentity);
          if (activeEndpointScopeRun.current === activeRun) activeEndpointScopeRun.current = null;
        }
      }
    },
    [
      api,
      executionScopeIdentity,
      input.activeProjectId,
      input.agentEndpoints,
      input.collaborationController,
      input.canvasBinding,
      input.canvasLocator,
      input.graph,
      input.localAutoRunApi,
      input.operatorProfileId,
      input.humanPrincipalId,
      input.preferences,
      input.previewClaimNext,
      input.selectedCanvasId,
      input.selectedProject,
      input.runtimeAvailability,
      input.setError,
      input.stopLocal,
      input.waitForLocalUnit,
      cancelWorkspaceSession,
      createId,
      abortRun,
      publishCancellation,
      executionApi
    ]
  );

  const stop = useCallback(async () => {
    if (!retainedRuns.current.has(executionScopeIdentity)) await recoverCancellation();
    const activeRun = retainedRuns.current.get(executionScopeIdentity);
    if (!activeRun) return;
    activeRun.failed = false;
    const results = await abortRun(activeRun, true);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "workspace_remote_scope_cancel_failed"
      );
    }
    publishCancellation(activeRun);
  }, [abortRun, executionScopeIdentity, publishCancellation, recoverCancellation]);

  return useMemo(
    () => Object.assign(startScope, { stop, cancellation }),
    [startScope, stop, cancellation]
  );
}

import type {
  ClaimResult,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { useCallback, useEffect, useRef } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { DesktopUiSettings } from "../../shared/desktopSettings";
import {
  bridge,
  collaborationBridge,
  desktopCanvasReference,
  operatorControlBridge
} from "../bridge";
import {
  createAgentEndpointBlockExecutor,
  type ResolveLiveRemoteBinding
} from "../collaboration/agentEndpointBlockExecutor";
import { createOwnerFleetRemoteDispatchApi } from "../collaboration/ownerFleetRemoteDispatch";
import { createAgentEndpointRunPlan } from "../collaboration/agentEndpointRunPlan";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import { createRemoteEndpointDispatchGate } from "../collaboration/remoteEndpointDispatchGate";
import {
  type LocalAutoRunObserver,
  runClaimBusLocalAutoRunUnit,
  waitForClaimBusLocalAutoRunUnit,
  waitForLocalAutoRunTerminal
} from "../collaboration/agentEndpointScopeRun";
import { runClaimBusScope } from "../collaboration/claimBusScheduler";
import { waitForRemoteOperationTerminal } from "../collaboration/remoteTaskEndpointRun";
import type { CollaborationRuntimeAvailabilityView } from "../collaboration/runtimeAvailabilityView";
import {
  collaborationRuntimeOperationsAllowed,
  collaborationRuntimeUnavailableCode
} from "../collaboration/runtimeAvailabilityView";

const OWNER_FLEET_TERMINAL_OPERATION_STATES = new Set<RemoteOperationObservation["state"]>([
  "completed",
  "failed",
  "cancelled"
]);

function createDispatchId(): string {
  return crypto.randomUUID();
}

function wrapOwnerFleetApiForOperationTracking(
  api: ReturnType<typeof createOwnerFleetRemoteDispatchApi>,
  operationsByBlockRef: Map<string, string>
): ReturnType<typeof createOwnerFleetRemoteDispatchApi> {
  return {
    ...api,
    dispatchOwnerFleetRemoteOperation: async (dispatchInput) => {
      const observation = await api.dispatchOwnerFleetRemoteOperation(dispatchInput);
      operationsByBlockRef.set(dispatchInput.command.blockRef, observation.operationId);
      return observation;
    }
  };
}

type GraphTask = DesktopGraphViewModel["tasks"][number];

type WorkspaceAgentEndpointRunInput = {
  activeProjectId: string | null;
  agentEndpoints: readonly AvailableAgentEndpoint[];
  collaborationController: {
    ensureWorkAuthority: (workItem: WorkItemRef) => Promise<{
      revisions: { responsibilityRevision: number; reviewerRevision: number };
    } | null>;
  } | null;
  graph: DesktopGraphViewModel | null;
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  operatorProfileId?: string | null;
  ownerFleetDispatchEnabled?: boolean;
  runtimeAvailability: CollaborationRuntimeAvailabilityView;
  setError: (message: string | null) => void;
  api?: Pick<
    PlanWeaveCollaborationApi,
    | "dispatchCollaborationRemoteOperation"
    | "observeCollaborationRemoteOperation"
    | "executeCollaborationRemoteOperationAction"
    | "onCollaborationObserverSignal"
    | "readCollaborationCanvasRuntimeAvailability"
  > | null;
  createId?: () => string;
  localAutoRunApi?: LocalAutoRunObserver | null;
  waitForLocalTerminal?: typeof waitForLocalAutoRunTerminal;
  waitForLocalUnit?: typeof waitForClaimBusLocalAutoRunUnit;
  waitForTerminal?: typeof waitForRemoteOperationTerminal;
  /** Injectable stop for claim-bus one-unit release (defaults to bridge.stopAutoRun). */
  stopLocal?: (runId: string) => Promise<unknown>;
  /**
   * Injectable dry-run claim preview (defaults to desktop bridge.previewClaimNext).
   * Used by claim-bus coordinated scopes only.
   */
  previewClaimNext?: (
    ref: DesktopCanvasReference,
    scope: DesktopAutoRunScope
  ) => Promise<ClaimResult>;
  /**
   * Live remoteExecution binding for existing-operation recovery (defaults to getBlockDetail).
   * Must not use the renderer graph snapshot from run start.
   */
  resolveLiveRemoteBinding?: ResolveLiveRemoteBinding;
};

export type LocalAutoRunScopeStarter = (
  scope: DesktopAutoRunScope,
  options?: { stepLimit?: number }
) => Promise<DesktopAutoRunState | null | undefined>;

export type WorkspaceAgentEndpointScopeStarter = (
  scope: DesktopAutoRunScope,
  startLocal: LocalAutoRunScopeStarter,
  lifecycle?: {
    onStarted: () => void;
    onCompleted: () => void;
    onFailed: (message: string) => void;
  }
) => Promise<void>;

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
): WorkspaceAgentEndpointScopeStarter {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const createId = input.createId ?? createDispatchId;
  const activeEndpointScopeRun = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeEndpointScopeRun.current?.abort();
    },
    []
  );

  return useCallback(
    async (scope: DesktopAutoRunScope, startLocal: LocalAutoRunScopeStarter, lifecycle) => {
      if (!collaborationRuntimeOperationsAllowed(input.runtimeAvailability)) {
        const message =
          collaborationRuntimeUnavailableCode(input.runtimeAvailability) ??
          "collaboration_runtime_unavailable";
        input.setError(message);
        lifecycle?.onFailed(message);
        return;
      }
      if (!input.graph || !input.selectedCanvasId) return;
      const plan = createAgentEndpointRunPlan({
        graph: input.graph,
        scope,
        endpoints: input.agentEndpoints,
        preferences: input.preferences,
        project: input.selectedProject,
        canvasId: input.selectedCanvasId
      });
      if (plan.kind === "noop") return;
      if (plan.kind === "rejected") {
        input.setError(plan.reason);
        return;
      }
      if (plan.kind === "local_scope") {
        await startLocal(plan.scope);
        return;
      }
      const usesRemoteEndpoint =
        plan.kind === "coordinated_block"
          ? plan.selection.endpoint.source === "remote"
          : [...plan.selectionByBlockRef.values()].some(
              (selection) => selection.endpoint.source === "remote"
            );
      const ownerFleetReady =
        Boolean(input.ownerFleetDispatchEnabled) &&
        Boolean(input.operatorProfileId) &&
        Boolean(operatorControlBridge);
      const usesOwnerFleetDispatch = usesRemoteEndpoint && ownerFleetReady;
      const collaborationReady = Boolean(
        input.collaborationController && api && input.activeProjectId
      );
      if (usesRemoteEndpoint && !usesOwnerFleetDispatch && !collaborationReady) {
        input.setError("owner_fleet_dispatch_unavailable");
        return;
      }
      if (!usesRemoteEndpoint && !input.selectedProject) return;
      if (usesRemoteEndpoint && !input.selectedProject) {
        input.setError("owner_fleet_project_unavailable");
        return;
      }
      if (
        !usesRemoteEndpoint &&
        (!input.activeProjectId || !input.selectedProject || !input.collaborationController || !api)
      ) {
        input.setError("collaboration_project_unavailable");
        return;
      }
      if (activeEndpointScopeRun.current) {
        input.setError("agent_endpoint_scope_run_already_active");
        return;
      }

      const controller = new AbortController();
      activeEndpointScopeRun.current = controller;
      const ownerFleetOperationsByBlockRef = new Map<string, string>();
      const remoteDispatchGate = createRemoteEndpointDispatchGate();
      lifecycle?.onStarted();
      const selectedProject = input.selectedProject;
      if (!selectedProject) {
        input.setError("owner_fleet_project_unavailable");
        return;
      }
      const selectedCanvasId = input.selectedCanvasId;
      const canvasRef = desktopCanvasReference(selectedProject, selectedCanvasId);
      const stopLocal =
        input.stopLocal ??
        (async (runId: string) => {
          if (!bridge) throw new Error("desktop_bridge_unavailable");
          return bridge.stopAutoRun(runId);
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
        const resolveLiveRemoteBinding: ResolveLiveRemoteBinding =
          input.resolveLiveRemoteBinding ??
          (async (blockRef) => {
            if (!bridge) throw new Error("desktop_bridge_unavailable");
            const detail = await bridge.getBlockDetail(canvasRef, blockRef);
            return detail.remoteExecution;
          });
        const ownerFleetApi =
          usesOwnerFleetDispatch && input.operatorProfileId
            ? wrapOwnerFleetApiForOperationTracking(
                createOwnerFleetRemoteDispatchApi({
                  operatorProfileId: input.operatorProfileId,
                  fleetApi: operatorControlBridge!
                }),
                ownerFleetOperationsByBlockRef
              )
            : null;
        const executeBlock = createAgentEndpointBlockExecutor({
          activeProjectId: usesOwnerFleetDispatch
            ? selectedProject.projectId
            : (input.activeProjectId ?? selectedProject.projectId),
          canvasId: selectedCanvasId,
          selectionByBlockRef,
          collaborationController: input.collaborationController,
          api: usesOwnerFleetDispatch ? null : api,
          ownerFleetApi,
          resolveRemoteWorkAuthority: usesOwnerFleetDispatch
            ? async () => ({ revisions: { responsibilityRevision: 0, reviewerRevision: 0 } })
            : undefined,
          resolveLiveRemoteBinding,
          createId,
          startLocal,
          stopLocal,
          localAutoRunApi: input.localAutoRunApi,
          waitForLocalUnit: input.waitForLocalUnit,
          waitForRemoteTerminal: input.waitForTerminal
        });

        const executeClaimUnit = async (ref: string, signal?: AbortSignal) => {
          const selection = selectionByBlockRef.get(ref);
          if (!selection) throw new Error(`agent_endpoint_selection_missing:${ref}`);
          if (selection.endpoint.source === "local") {
            await executeBlock(selection.task, selection.block, signal);
            return;
          }
          const endpointId = selection.endpoint.remoteEndpointId;
          if (!endpointId) throw new Error(`agent_endpoint_selection_missing:${ref}`);
          await remoteDispatchGate.run({
            endpointId,
            execute: () => executeBlock(selection.task, selection.block, signal),
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

        const isOwnerFleetBlockSatisfied = async (blockRef: string): Promise<boolean> => {
          const selection = selectionByBlockRef.get(blockRef);
          if (selection?.endpoint.source === "remote") {
            const operationId = ownerFleetOperationsByBlockRef.get(blockRef);
            if (operationId && ownerFleetApi) {
              const observation = await ownerFleetApi.observeOwnerFleetRemoteOperation({
                operationId
              });
              if (observation.state === "completed") return true;
              if (OWNER_FLEET_TERMINAL_OPERATION_STATES.has(observation.state)) return false;
            }
          }
          if (!bridge) throw new Error("desktop_bridge_unavailable");
          const detail = await bridge.getBlockDetail(canvasRef, blockRef);
          return detail.status === "completed";
        };

        const isOwnerFleetScopeSatisfied = async (options?: { refresh?: boolean }) => {
          const check = async () => {
            for (const blockRef of scopedBlockRefs) {
              if (!(await isOwnerFleetBlockSatisfied(blockRef))) return false;
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
                unitLabel: `feedback:${claim.feedbackId}`,
                signal,
                waitForUnit: input.waitForLocalUnit
              });
            }
          },
          completion: {
            isSatisfied: async (options) => {
              if (usesOwnerFleetDispatch) {
                return isOwnerFleetScopeSatisfied(options);
              }
              const readStatus = async () => {
                if (!api) throw new Error("collaboration_runtime_availability_unavailable");
                const availability = await api.readCollaborationCanvasRuntimeAvailability({
                  localProjectId: selectedProject.projectId,
                  canvasId: selectedCanvasId
                });
                if (!availability) {
                  throw new Error("collaboration_runtime_availability_unavailable");
                }
                if (availability.kind === "unavailable") {
                  throw new Error(`collaboration_runtime_${availability.reason}`);
                }
                return availability.status;
              };

              // refresh: dedicated re-read so claim-none idle cannot use a lagging projection.
              // Authority stays on collaboration runtime status (not local Auto Run state).
              let status = await readStatus();
              if (options?.refresh) {
                status = await readStatus();
              }

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
        lifecycle?.onCompleted();
      } catch (caught) {
        controller.abort();
        const message = caught instanceof Error ? caught.message : String(caught);
        input.setError(message);
        lifecycle?.onFailed(message);
      } finally {
        if (activeEndpointScopeRun.current === controller) activeEndpointScopeRun.current = null;
      }
    },
    [
      api,
      createId,
      input.activeProjectId,
      input.agentEndpoints,
      input.collaborationController,
      input.graph,
      input.localAutoRunApi,
      input.preferences,
      input.previewClaimNext,
      input.resolveLiveRemoteBinding,
      input.selectedCanvasId,
      input.selectedProject,
      input.operatorProfileId,
      input.ownerFleetDispatchEnabled,
      input.runtimeAvailability,
      input.setError,
      input.stopLocal,
      input.waitForLocalUnit,
      input.waitForTerminal
    ]
  );
}

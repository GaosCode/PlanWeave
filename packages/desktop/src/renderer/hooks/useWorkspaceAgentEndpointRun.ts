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
import type { RemoteCollaborationCanvasBindingInput } from "../../shared/collaboration";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";
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
import { runWorkspaceRemoteScopeFromAvailability } from "../collaboration/workspaceRemoteScopeScheduler";
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

function waitForWorkspaceRuntimeProjectionChange(input: {
  api: Pick<PlanWeaveCollaborationApi, "onCollaborationObserverSignal">;
  binding: RemoteCollaborationCanvasBindingInput;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
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
    const matchesRuntimeScope = (signal: CollaborationObserverSignal) => {
      if (signal.projectId !== input.binding.projectId) return false;
      if (signal.type === "human.observer.catchup_required") return true;
      return (
        signal.type === "human.observer.event" &&
        signal.event.kind === "runtime" &&
        signal.event.canvasId === input.binding.canvasId
      );
    };
    unsubscribe = input.api.onCollaborationObserverSignal((signal) => {
      if (matchesRuntimeScope(signal)) finish();
    });
    if (settled) {
      unsubscribe();
      return;
    }
    timer = setTimeout(finish, input.fallbackRefreshMs ?? 1_000);

    if (input.signal?.aborted) {
      cancel();
      return;
    }
    input.signal?.addEventListener("abort", cancel, { once: true });
  });
}

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
  canvasBinding?: RemoteCollaborationCanvasBindingInput | null;
  graph: DesktopGraphViewModel | null;
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  operatorProfileId?: string | null;
  ownerFleetDispatchEnabled?: boolean;
  runtimeAvailability: CollaborationRuntimeAvailabilityView;
  workspaceRuntimeAuthorityKey?: string | null;
  ensureWorkspaceRuntimeInitialized?: () => Promise<void>;
  setError: (message: string | null) => void;
  api?: Pick<
    PlanWeaveCollaborationApi,
    | "dispatchCollaborationRemoteOperation"
    | "observeCollaborationRemoteOperation"
    | "executeCollaborationRemoteOperationAction"
    | "onCollaborationObserverSignal"
    | "readCollaborationCanvasBindingRuntimeAvailability"
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

type WorkspaceAgentEndpointScopeLifecycle = {
  onStarted: () => void;
  onCompleted: () => void;
  onFailed: (message: string) => void;
  onCancelled?: () => void;
};

export type WorkspaceAgentEndpointScopeStarter = (
  scope: DesktopAutoRunScope,
  startLocal: LocalAutoRunScopeStarter,
  lifecycle?: WorkspaceAgentEndpointScopeLifecycle
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
  const executionScopeIdentity = input.canvasBinding
    ? (input.workspaceRuntimeAuthorityKey ??
      `${input.canvasBinding.workspaceId}:${input.canvasBinding.projectId}:${input.canvasBinding.canvasId}`)
    : `${input.selectedProject?.rootPath ?? "no-project"}:${input.selectedCanvasId ?? "no-canvas"}`;
  const previousExecutionScopeIdentity = useRef(executionScopeIdentity);
  const activeExecutionScopeIdentity = useRef(executionScopeIdentity);
  activeExecutionScopeIdentity.current = executionScopeIdentity;

  useEffect(() => {
    if (previousExecutionScopeIdentity.current !== executionScopeIdentity) {
      previousExecutionScopeIdentity.current = executionScopeIdentity;
      activeEndpointScopeRun.current?.abort();
    }
  }, [executionScopeIdentity]);

  useEffect(
    () => () => {
      activeEndpointScopeRun.current?.abort();
    },
    []
  );

  const startScope = useCallback(
    async (
      scope: DesktopAutoRunScope,
      startLocal: LocalAutoRunScopeStarter,
      lifecycle?: WorkspaceAgentEndpointScopeLifecycle
    ) => {
      if (!input.graph || !input.selectedCanvasId) return;
      const requestedExecutionScopeIdentity = executionScopeIdentity;
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
      let workspaceRuntimePrepared = false;
      if (remoteBinding && input.ensureWorkspaceRuntimeInitialized) {
        try {
          await input.ensureWorkspaceRuntimeInitialized();
        } catch (caught) {
          if (activeExecutionScopeIdentity.current !== requestedExecutionScopeIdentity) return;
          const message = caught instanceof Error ? caught.message : String(caught);
          input.setError(message);
          lifecycle?.onFailed(message);
          return;
        }
        if (activeExecutionScopeIdentity.current !== requestedExecutionScopeIdentity) return;
        workspaceRuntimePrepared = true;
      }
      if (plan.kind === "local_scope") {
        if (remoteCanvasOnly) {
          input.setError("content_local_canvas_binding_required");
          return;
        }
        await startLocal(plan.scope);
        return;
      }
      if (
        !workspaceRuntimePrepared &&
        !collaborationRuntimeOperationsAllowed(input.runtimeAvailability)
      ) {
        const message =
          collaborationRuntimeUnavailableCode(input.runtimeAvailability) ??
          "collaboration_runtime_unavailable";
        input.setError(message);
        lifecycle?.onFailed(message);
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
      const usesOwnerFleetDispatch =
        remoteBinding === null && usesRemoteEndpoint && ownerFleetReady;
      const collaborationReady = Boolean(
        input.collaborationController && api && input.activeProjectId
      );
      if (usesRemoteEndpoint && !usesOwnerFleetDispatch && !collaborationReady) {
        input.setError("owner_fleet_dispatch_unavailable");
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
      if (activeEndpointScopeRun.current) {
        input.setError("agent_endpoint_scope_run_already_active");
        return;
      }

      const selectedProject = input.selectedProject;
      const selectedCanvasId = input.selectedCanvasId;
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
      activeEndpointScopeRun.current = controller;
      const completeLifecycle = () => {
        if (controller.signal.aborted) throw new Error("workspace_remote_scope_cancelled");
        lifecycle?.onCompleted();
      };
      const ownerFleetOperationsByBlockRef = new Map<string, string>();
      const remoteDispatchGate = createRemoteEndpointDispatchGate();
      lifecycle?.onStarted();
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
            if (!bridge || !canvasRef) return null;
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
          activeProjectId: executionProjectId,
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

        const executeSelectionByRef = async (ref: string, signal?: AbortSignal) => {
          const selection = selectionByBlockRef.get(ref);
          if (!selection) throw new Error(`agent_endpoint_selection_missing:${ref}`);
          await executeBlock(selection.task, selection.block, signal);
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
                if (!remoteBinding) {
                  throw new Error("collaboration_runtime_availability_unavailable");
                }
                const availability =
                  await api.readCollaborationCanvasBindingRuntimeAvailability(remoteBinding);
                if (!availability) {
                  throw new Error("collaboration_runtime_availability_unavailable");
                }
                if (availability.state.kind === "uninitialized") {
                  throw new Error("collaboration_runtime_state_uninitialized");
                }
                return availability.state.status;
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
        completeLifecycle();
      } catch (caught) {
        const cancelled = controller.signal.aborted;
        if (!cancelled) controller.abort();
        const message = caught instanceof Error ? caught.message : String(caught);
        if (cancelled) {
          lifecycle?.onCancelled?.();
          return;
        }
        input.setError(message);
        lifecycle?.onFailed(message);
      } finally {
        if (activeEndpointScopeRun.current === controller) activeEndpointScopeRun.current = null;
      }
    },
    [
      api,
      createId,
      executionScopeIdentity,
      input.activeProjectId,
      input.agentEndpoints,
      input.collaborationController,
      input.canvasBinding,
      input.graph,
      input.ensureWorkspaceRuntimeInitialized,
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

  return startScope;
}

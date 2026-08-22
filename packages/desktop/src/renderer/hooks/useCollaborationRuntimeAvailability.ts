import { useEffect, useMemo, useState } from "react";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type {
  CollaborationCanvasBindingInput,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";
import { collaborationBridge } from "../bridge";
import type { CollaborationRuntimeAvailabilityView } from "../collaboration/runtimeAvailabilityView";

export const COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS = 3_000;

export type CollaborationRuntimeAvailabilityBridge = Pick<
  PlanWeaveCollaborationApi,
  "readCollaborationCanvasBindingRuntimeAvailability" | "resolveCollaborationCanvasBindingScope"
> &
  Partial<
    Pick<
      PlanWeaveCollaborationApi,
      "onCollaborationObserverSignal" | "onCollaborationStatusChanged"
    >
  >;

type ResolvedCanvasIdentity = {
  profileId: string;
  bindingIdentity: string;
  remoteWorkspaceId: CanvasRuntimeStatusProjection["scope"]["workspaceId"];
  remoteProjectId: string;
  remoteCanvasId: string;
};

type RemoteCanvasBinding = Extract<CollaborationCanvasBindingInput, { kind: "remote" }>;

type RemoteAvailabilityState =
  | { kind: "checking" }
  | {
      kind: "ready";
      identity: ResolvedCanvasIdentity;
      availability: CanvasRuntimeAvailability;
    }
  | { kind: "error"; message: string };

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function sameRuntimeScope(
  left: CanvasRuntimeStatusProjection["scope"],
  right: CanvasRuntimeStatusProjection["scope"]
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

function matchesResolvedCanvas(
  status: CanvasRuntimeStatusProjection,
  identity: ResolvedCanvasIdentity
): boolean {
  return (
    status.scope.workspaceId === identity.remoteWorkspaceId &&
    status.scope.projectId === identity.remoteProjectId &&
    status.scope.canvasId === identity.remoteCanvasId
  );
}

function runtimeRevision(availability: CanvasRuntimeAvailability): number {
  return availability.state.kind === "initialized" ? availability.state.runtimeRevision : 0;
}

function observerTransportAvailable(status: CollaborationStatus, profileId: string): boolean {
  return (
    status.activeProfileId === profileId &&
    status.session.phase === "connected" &&
    (status.session.detail === "observer:connected" ||
      status.session.detail === "observer:catching_up")
  );
}

function hasExactRuntimeIdentity(
  graph: DesktopGraphViewModel,
  status: CanvasRuntimeStatusProjection
): boolean {
  const taskIds = graph.tasks.map((task) => task.taskId);
  const blockRefs = graph.tasks.flatMap((task) => task.blocks.map((block) => block.ref));
  const statusTaskIds = new Set(status.tasks.map((task) => task.taskId));
  const statusBlockRefs = new Set(status.blocks.map((block) => block.ref));
  return (
    taskIds.length === status.tasks.length &&
    blockRefs.length === status.blocks.length &&
    taskIds.every((taskId) => statusTaskIds.has(taskId)) &&
    blockRefs.every((ref) => statusBlockRefs.has(ref))
  );
}

export function failClosedCollaborationRuntimeDispatchability(
  graph: DesktopGraphViewModel
): DesktopGraphViewModel {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => ({
      ...task,
      blocks: task.blocks.map((block) => ({ ...block, dispatchable: false })),
      blockPreview: task.blockPreview.map((block) => ({ ...block, dispatchable: false }))
    }))
  };
}

export function mergeAvailableCollaborationRuntimeStatus(
  graph: DesktopGraphViewModel,
  status: CanvasRuntimeStatusProjection,
  expectedScope: CanvasRuntimeStatusProjection["scope"]
): DesktopGraphViewModel {
  if (!sameRuntimeScope(status.scope, expectedScope) || !hasExactRuntimeIdentity(graph, status)) {
    return failClosedCollaborationRuntimeDispatchability(graph);
  }
  const contentMatchesRuntime = status.packageFingerprint === graph.packageFingerprint;
  const taskStatuses = new Map(status.tasks.map((task) => [task.taskId, task]));
  const blockStatuses = new Map(status.blocks.map((block) => [block.ref, block]));
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const remoteTask = taskStatuses.get(task.taskId);
      if (!remoteTask) throw new Error(`collaboration_runtime_task_status_missing:${task.taskId}`);
      const mergeBlocks = (blocks: typeof task.blocks) =>
        blocks.map((block) => {
          const remoteBlock = blockStatuses.get(block.ref);
          if (!remoteBlock) {
            throw new Error(`collaboration_runtime_block_status_missing:${block.ref}`);
          }
          return {
            ...block,
            status: remoteBlock.status,
            exceptionReason: remoteBlock.blockedReason ?? remoteBlock.divergenceReason ?? null,
            dispatchable: contentMatchesRuntime && remoteBlock.dispatchable
          };
        });
      const blocks = mergeBlocks(task.blocks);
      return {
        ...task,
        status: remoteTask.status,
        blocks,
        blockPreview: mergeBlocks(task.blockPreview),
        exceptions: blocks.flatMap((block) => {
          if (
            !block.exceptionReason ||
            (block.status !== "blocked" && block.status !== "diverged")
          ) {
            return [];
          }
          return [{ ref: block.ref, reason: block.exceptionReason, source: block.status }];
        })
      };
    })
  };
}

export function useCollaborationRuntimeAvailability(input: {
  enabled: boolean;
  sessionConnected: boolean;
  profileId: string | null;
  activeProjectId: string | null;
  binding: CollaborationCanvasBindingInput | null;
  graph: DesktopGraphViewModel | null;
  refreshRevision?: number;
  api?: CollaborationRuntimeAvailabilityBridge | null;
}): {
  graph: DesktopGraphViewModel | null;
  availability: CollaborationRuntimeAvailabilityView;
  authoritativeRuntime: CanvasRuntimeAvailability | null;
} {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const bindingKind = input.binding?.kind ?? null;
  const bindingWorkspaceId = input.binding?.kind === "remote" ? input.binding.workspaceId : null;
  const bindingProjectId =
    input.binding?.kind === "local"
      ? input.binding.localProjectId
      : (input.binding?.projectId ?? null);
  const bindingCanvasId = input.binding?.canvasId ?? null;
  const binding = useMemo<RemoteCanvasBinding | null>(
    () =>
      bindingKind === "remote" && bindingWorkspaceId && bindingProjectId && bindingCanvasId
        ? {
            kind: "remote",
            workspaceId: bindingWorkspaceId,
            projectId: bindingProjectId,
            canvasId: bindingCanvasId
          }
        : null,
    [bindingCanvasId, bindingKind, bindingProjectId, bindingWorkspaceId]
  );
  const bindingIdentity = binding ? JSON.stringify(binding) : null;
  const graphPackageFingerprint = input.graph?.packageFingerprint ?? null;
  const [remoteState, setRemoteState] = useState<RemoteAvailabilityState>({ kind: "checking" });

  // refreshRevision is an external invalidation signal; its value is intentionally not read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing it must restart the authoritative read.
  useEffect(() => {
    if (!input.enabled || !input.sessionConnected) return undefined;
    if (
      !api ||
      !input.profileId ||
      !input.activeProjectId ||
      !binding ||
      !graphPackageFingerprint
    ) {
      setRemoteState({ kind: "error", message: "collaboration_runtime_scope_unavailable" });
      return undefined;
    }
    const profileId = input.profileId;
    const activeProjectId = input.activeProjectId;
    let active = true;
    let inFlight = false;
    let inFlightRevision = 0;
    let pendingRevision = 0;
    let pendingRefresh = true;
    let invalidationVersion = 0;
    let runtimeHighWater = 0;
    let observerAvailable = false;
    let recovering = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let identity: ResolvedCanvasIdentity | null = null;
    setRemoteState({ kind: "checking" });

    const stopFallbackPolling = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    const requestRefresh = (options: { revision?: number; recovery?: boolean } = {}) => {
      if (!active) return;
      const revision = options.revision ?? 0;
      if (revision > Math.max(runtimeHighWater, pendingRevision, inFlightRevision)) {
        pendingRevision = revision;
        invalidationVersion += 1;
      }
      if (options.recovery && (!recovering || (!inFlight && !pendingRefresh))) {
        recovering = true;
        pendingRefresh = true;
        invalidationVersion += 1;
      }
      void refresh();
    };

    const startFallbackPolling = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        pendingRefresh = true;
        invalidationVersion += 1;
        void refresh();
      }, COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS);
    };

    const updateFallbackPolling = () => {
      if (observerAvailable && !recovering) stopFallbackPolling();
      else startFallbackPolling();
    };

    const refresh = async () => {
      if (!active || inFlight || !identity) return;
      const targetRevision = pendingRevision;
      const forceRefresh = pendingRefresh;
      if (!forceRefresh && targetRevision <= runtimeHighWater) return;
      const currentIdentity = identity;
      const refreshVersion = invalidationVersion;
      inFlight = true;
      inFlightRevision = targetRevision;
      pendingRefresh = false;
      try {
        const next = await api.readCollaborationCanvasBindingRuntimeAvailability(binding);
        if (!active) return;
        if (!next) {
          setRemoteState({ kind: "error", message: "collaboration_runtime_availability_missing" });
        } else if (
          next.state.kind === "initialized" &&
          !matchesResolvedCanvas(next.state.status, currentIdentity)
        ) {
          setRemoteState({ kind: "error", message: "collaboration_runtime_scope_mismatch" });
        } else if (
          next.execution.kind === "available" &&
          !matchesResolvedCanvas(next.execution.status, currentIdentity)
        ) {
          setRemoteState({ kind: "error", message: "collaboration_runtime_scope_mismatch" });
        } else {
          const authoritativeRevision = runtimeRevision(next);
          runtimeHighWater = Math.max(runtimeHighWater, authoritativeRevision);
          if (pendingRevision <= runtimeHighWater) pendingRevision = 0;
          setRemoteState({ kind: "ready", identity: currentIdentity, availability: next });
          if (
            recovering &&
            authoritativeRevision >= targetRevision &&
            refreshVersion === invalidationVersion
          ) {
            recovering = false;
          } else if (authoritativeRevision < targetRevision) {
            recovering = true;
          }
        }
      } catch (caught) {
        if (active) {
          recovering = true;
          setRemoteState({ kind: "error", message: errorMessage(caught) });
        }
      } finally {
        inFlight = false;
        inFlightRevision = 0;
        updateFallbackPolling();
        if (active && invalidationVersion !== refreshVersion) {
          void refresh();
        }
      }
    };

    const handleObserverSignal = (signal: CollaborationObserverSignal) => {
      if (
        signal.profileId !== profileId ||
        signal.projectId !== activeProjectId ||
        binding.projectId !== activeProjectId
      ) {
        return;
      }
      if (signal.type === "human.observer.cursor") {
        observerAvailable = true;
        recovering = false;
        updateFallbackPolling();
        return;
      }
      if (signal.type === "human.observer.catchup_required") {
        observerAvailable = true;
        requestRefresh({ recovery: true });
        updateFallbackPolling();
        return;
      }
      if (
        signal.event.kind !== "runtime" ||
        signal.event.canvasId !== binding.canvasId ||
        signal.event.runtimeRevision === undefined
      ) {
        return;
      }
      observerAvailable = true;
      requestRefresh({ revision: signal.event.runtimeRevision });
      updateFallbackPolling();
    };

    const unsubscribeObserver = api.onCollaborationObserverSignal?.(handleObserverSignal);
    const unsubscribeStatus = api.onCollaborationStatusChanged?.((status) => {
      observerAvailable = observerTransportAvailable(status, profileId);
      updateFallbackPolling();
    });

    void api
      .resolveCollaborationCanvasBindingScope(binding)
      .then((resolved) => {
        if (!active) return;
        if (
          !resolved ||
          resolved.workspaceId !== binding.workspaceId ||
          resolved.projectId !== activeProjectId ||
          resolved.canvasId !== binding.canvasId
        ) {
          setRemoteState({ kind: "error", message: "collaboration_runtime_scope_unavailable" });
          return;
        }
        identity = {
          profileId,
          bindingIdentity: JSON.stringify(binding),
          remoteWorkspaceId: resolved.workspaceId,
          remoteProjectId: resolved.projectId,
          remoteCanvasId: resolved.canvasId
        };
        void refresh();
      })
      .catch((caught: unknown) => {
        if (active) setRemoteState({ kind: "error", message: errorMessage(caught) });
      });
    updateFallbackPolling();
    return () => {
      active = false;
      stopFallbackPolling();
      unsubscribeObserver?.();
      unsubscribeStatus?.();
    };
  }, [
    api,
    input.activeProjectId,
    input.enabled,
    graphPackageFingerprint,
    binding,
    input.profileId,
    input.refreshRevision,
    input.sessionConnected
  ]);

  const currentReadyState =
    remoteState.kind === "ready" &&
    input.profileId &&
    bindingIdentity &&
    input.activeProjectId &&
    remoteState.identity.profileId === input.profileId &&
    remoteState.identity.bindingIdentity === bindingIdentity &&
    remoteState.identity.remoteProjectId === input.activeProjectId
      ? remoteState
      : null;

  return useMemo(() => {
    const availability: CollaborationRuntimeAvailabilityView = !input.enabled
      ? { kind: "not_applicable" }
      : !input.sessionConnected
        ? { kind: "server_disconnected" }
        : remoteState.kind === "ready" && !currentReadyState
          ? { kind: "checking" }
          : remoteState.kind === "ready" && currentReadyState
            ? currentReadyState.availability.state.kind === "uninitialized"
              ? { kind: "state_uninitialized" }
              : currentReadyState.availability.execution.kind === "available"
                ? { kind: "available" }
                : {
                    kind: "unavailable",
                    reason: currentReadyState.availability.execution.reason,
                    statusKnown: true
                  }
            : remoteState.kind === "checking" || remoteState.kind === "error"
              ? remoteState
              : { kind: "checking" };
    const graph = input.graph
      ? availability.kind === "not_applicable"
        ? input.graph
        : currentReadyState?.availability.state.kind === "initialized"
          ? (() => {
              const merged = mergeAvailableCollaborationRuntimeStatus(
                input.graph,
                currentReadyState.availability.state.status,
                {
                  workspaceId: currentReadyState.identity.remoteWorkspaceId,
                  projectId: currentReadyState.identity.remoteProjectId,
                  canvasId: currentReadyState.identity.remoteCanvasId
                }
              );
              return availability.kind === "available"
                ? merged
                : failClosedCollaborationRuntimeDispatchability(merged);
            })()
          : failClosedCollaborationRuntimeDispatchability(input.graph)
      : null;
    return {
      graph,
      availability,
      authoritativeRuntime: currentReadyState?.availability ?? null
    };
  }, [currentReadyState, input.enabled, input.graph, input.sessionConnected, remoteState]);
}

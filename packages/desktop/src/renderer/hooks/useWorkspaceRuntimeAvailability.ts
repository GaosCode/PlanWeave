import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type {
  CollaborationStatus,
  PlanWeaveCollaborationApi,
  RemoteCollaborationCanvasBindingInput
} from "../../shared/collaboration";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";
import { collaborationBridge } from "../bridge";
import type { CollaborationRuntimeAvailabilityView } from "../collaboration/runtimeAvailabilityView";

export const COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS = 3_000;

export type WorkspaceRuntimeAvailabilityBridge = Pick<
  PlanWeaveCollaborationApi,
  "getCollaborationStatus" | "readCollaborationCanvasBindingRuntimeAvailability"
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

function workspaceRuntimeAvailabilitySeedKey(
  profileId: string | null,
  binding: RemoteCollaborationCanvasBindingInput | null,
  availability: CanvasRuntimeAvailability | null | undefined
): string | null {
  if (!availability) return null;
  return JSON.stringify({
    profileId,
    binding,
    state:
      availability.state.kind === "initialized"
        ? {
            kind: "initialized",
            revision: availability.state.runtimeRevision,
            capturedAt: availability.state.status.capturedAt
          }
        : { kind: "uninitialized" },
    execution:
      availability.execution.kind === "available"
        ? {
            kind: "available",
            sourceRevision: availability.execution.sourceRevision,
            capturedAt: availability.execution.status.capturedAt
          }
        : availability.execution
  });
}

function commitRemoteAvailability(
  current: RemoteAvailabilityState,
  identity: ResolvedCanvasIdentity,
  availability: CanvasRuntimeAvailability,
  source: "server" | "accepted"
): RemoteAvailabilityState {
  if (
    current.kind !== "ready" ||
    current.identity.profileId !== identity.profileId ||
    current.identity.bindingIdentity !== identity.bindingIdentity
  ) {
    return { kind: "ready", identity, availability };
  }
  const currentRevision = runtimeRevision(current.availability);
  const nextRevision = runtimeRevision(availability);
  if (
    currentRevision > nextRevision ||
    (source === "accepted" && currentRevision === nextRevision)
  ) {
    return current;
  }
  return { kind: "ready", identity, availability };
}

type ObserverTransportHealth = "connected" | "catching_up" | "unavailable";

function observerTransportHealth(
  status: CollaborationStatus,
  profileId: string
): ObserverTransportHealth {
  if (
    status.activeProfileId !== profileId ||
    status.session.activeProfileId !== profileId ||
    status.session.phase !== "connected"
  ) {
    return "unavailable";
  }
  if (status.session.detail === "observer:connected") return "connected";
  if (status.session.detail?.startsWith("observer:catching_up:") === true) {
    return "catching_up";
  }
  return "unavailable";
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

export function useWorkspaceRuntimeAvailability(input: {
  enabled: boolean;
  sessionConnected: boolean;
  profileId: string | null;
  activeProjectId: string | null;
  binding: RemoteCollaborationCanvasBindingInput | null;
  graph: DesktopGraphViewModel | null;
  initialRuntimeAvailability?: CanvasRuntimeAvailability | null;
  refreshRevision?: number;
  api?: WorkspaceRuntimeAvailabilityBridge | null;
}): {
  graph: DesktopGraphViewModel | null;
  availability: CollaborationRuntimeAvailabilityView;
  authoritativeRuntime: CanvasRuntimeAvailability | null;
  applyAcceptedRuntimeProjection: (availability: CanvasRuntimeAvailability) => void;
} {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const bindingWorkspaceId = input.binding?.workspaceId ?? null;
  const bindingProjectId = input.binding?.projectId ?? null;
  const bindingCanvasId = input.binding?.canvasId ?? null;
  const binding = useMemo<RemoteCollaborationCanvasBindingInput | null>(
    () =>
      bindingWorkspaceId && bindingProjectId && bindingCanvasId
        ? {
            kind: "remote",
            workspaceId: bindingWorkspaceId,
            projectId: bindingProjectId,
            canvasId: bindingCanvasId
          }
        : null,
    [bindingCanvasId, bindingProjectId, bindingWorkspaceId]
  );
  const bindingIdentity = binding ? JSON.stringify(binding) : null;
  const graphPackageFingerprint = input.graph?.packageFingerprint ?? null;
  const initialRuntimeAvailabilityKey = workspaceRuntimeAvailabilitySeedKey(
    input.profileId,
    binding,
    input.initialRuntimeAvailability
  );
  const consumedInitialRuntimeAvailabilityKeyRef = useRef<string | null>(null);
  const initialRuntimeAvailabilityRef = useRef<{
    key: string | null;
    value: CanvasRuntimeAvailability | null;
  }>({ key: null, value: null });
  if (initialRuntimeAvailabilityKey === null) {
    consumedInitialRuntimeAvailabilityKeyRef.current = null;
  }
  if (initialRuntimeAvailabilityRef.current.key !== initialRuntimeAvailabilityKey) {
    initialRuntimeAvailabilityRef.current = {
      key: initialRuntimeAvailabilityKey,
      value: input.initialRuntimeAvailability ?? null
    };
  }
  const [remoteState, setRemoteState] = useState<RemoteAvailabilityState>({ kind: "checking" });

  // refreshRevision is an external invalidation signal; its value is intentionally not read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing it must restart the authoritative read.
  useEffect(() => {
    if (!input.enabled || !input.sessionConnected) return undefined;
    if (!api || !input.profileId || !input.activeProjectId || !binding) {
      setRemoteState({ kind: "error", message: "collaboration_runtime_scope_unavailable" });
      return undefined;
    }
    if (!graphPackageFingerprint) {
      setRemoteState({ kind: "checking" });
      return undefined;
    }
    const profileId = input.profileId;
    const activeProjectId = input.activeProjectId;
    const initialRuntimeAvailability =
      initialRuntimeAvailabilityKey !== null &&
      consumedInitialRuntimeAvailabilityKeyRef.current !== initialRuntimeAvailabilityKey &&
      initialRuntimeAvailabilityRef.current.key === initialRuntimeAvailabilityKey
        ? initialRuntimeAvailabilityRef.current.value
        : null;
    if (initialRuntimeAvailability) {
      consumedInitialRuntimeAvailabilityKeyRef.current = initialRuntimeAvailabilityKey;
    }
    let active = true;
    let inFlight = false;
    let inFlightRevision = 0;
    let pendingRevision = 0;
    let pendingRefresh = initialRuntimeAvailability === null;
    let invalidationVersion = 0;
    let runtimeHighWater = initialRuntimeAvailability
      ? runtimeRevision(initialRuntimeAvailability)
      : 0;
    let observerAvailable: boolean | null = null;
    let observerStatusVersion = 0;
    let recovering = false;
    let executionUnavailable = initialRuntimeAvailability?.execution.kind === "unavailable";
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const identity: ResolvedCanvasIdentity = {
      profileId,
      bindingIdentity: JSON.stringify(binding),
      remoteWorkspaceId: binding.workspaceId,
      remoteProjectId: binding.projectId,
      remoteCanvasId: binding.canvasId
    };
    setRemoteState((current) => {
      if (initialRuntimeAvailability) {
        return commitRemoteAvailability(current, identity, initialRuntimeAvailability, "server");
      }
      if (
        current.kind === "ready" &&
        current.identity.profileId === identity.profileId &&
        current.identity.bindingIdentity === identity.bindingIdentity
      ) {
        return current;
      }
      return { kind: "checking" };
    });

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
      if (recovering || observerAvailable === false || executionUnavailable) {
        startFallbackPolling();
      } else stopFallbackPolling();
    };

    const markObserverTransportAvailable = () => {
      observerAvailable = true;
      if (recovering || pendingRevision > runtimeHighWater) {
        requestRefresh({ recovery: true });
      }
      updateFallbackPolling();
    };

    const applyObserverStatus = (status: CollaborationStatus) => {
      const health = observerTransportHealth(status, profileId);
      if (health === "connected") {
        markObserverTransportAvailable();
      } else if (health === "catching_up") {
        observerAvailable = true;
        requestRefresh({ recovery: true });
        updateFallbackPolling();
      } else {
        observerAvailable = false;
        updateFallbackPolling();
      }
    };

    const refresh = async () => {
      if (!active || inFlight) return;
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
          if (invalidationVersion !== refreshVersion) return;
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
          executionUnavailable = next.execution.kind === "unavailable";
          const authoritativeRevision = runtimeRevision(next);
          const requiredRevision = Math.max(targetRevision, pendingRevision);
          if (
            invalidationVersion !== refreshVersion &&
            (pendingRefresh || authoritativeRevision < pendingRevision)
          ) {
            return;
          }
          runtimeHighWater = Math.max(runtimeHighWater, authoritativeRevision);
          if (pendingRevision <= runtimeHighWater) pendingRevision = 0;
          setRemoteState((current) =>
            commitRemoteAvailability(current, currentIdentity, next, "server")
          );
          if (recovering && !pendingRefresh && authoritativeRevision >= requiredRevision) {
            recovering = false;
          } else if (authoritativeRevision < requiredRevision) {
            recovering = true;
          }
        }
      } catch (caught) {
        if (active && invalidationVersion === refreshVersion) {
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
      observerStatusVersion += 1;
      if (signal.type === "human.observer.cursor") {
        markObserverTransportAvailable();
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
      observerStatusVersion += 1;
      applyObserverStatus(status);
    });
    const initialObserverStatusVersion = observerStatusVersion;
    void api
      .getCollaborationStatus()
      .then((status) => {
        if (!active || observerStatusVersion !== initialObserverStatusVersion) return;
        applyObserverStatus(status);
      })
      .catch(() => {
        if (!active || observerStatusVersion !== initialObserverStatusVersion) return;
        observerAvailable = false;
        updateFallbackPolling();
      });

    void refresh();
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
    input.sessionConnected,
    initialRuntimeAvailabilityKey
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

  const applyAcceptedRuntimeProjection = useCallback(
    (availability: CanvasRuntimeAvailability) => {
      if (!input.profileId || !input.activeProjectId || !binding || !bindingIdentity) {
        throw new Error("collaboration_runtime_scope_unavailable");
      }
      const identity: ResolvedCanvasIdentity = {
        profileId: input.profileId,
        bindingIdentity,
        remoteWorkspaceId: binding.workspaceId,
        remoteProjectId: binding.projectId,
        remoteCanvasId: binding.canvasId
      };
      if (
        (availability.state.kind === "initialized" &&
          !matchesResolvedCanvas(availability.state.status, identity)) ||
        (availability.execution.kind === "available" &&
          !matchesResolvedCanvas(availability.execution.status, identity))
      ) {
        throw new Error("collaboration_runtime_scope_mismatch");
      }
      setRemoteState((current) =>
        commitRemoteAvailability(current, identity, availability, "accepted")
      );
    },
    [binding, bindingIdentity, input.activeProjectId, input.profileId]
  );

  return useMemo(() => {
    const availability: CollaborationRuntimeAvailabilityView = !input.enabled
      ? { kind: "not_applicable" }
      : !input.sessionConnected
        ? {
            kind: "server_disconnected",
            statusKnown: currentReadyState?.availability.state.kind === "initialized"
          }
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
        : availability.kind === "checking"
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
      authoritativeRuntime: currentReadyState?.availability ?? null,
      applyAcceptedRuntimeProjection
    };
  }, [
    applyAcceptedRuntimeProjection,
    currentReadyState,
    input.enabled,
    input.graph,
    input.sessionConnected,
    remoteState
  ]);
}

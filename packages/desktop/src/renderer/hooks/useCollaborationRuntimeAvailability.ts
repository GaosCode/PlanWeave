import { useEffect, useMemo, useState } from "react";
import type {
  CanvasRuntimeAvailability,
  CanvasRuntimeUnavailableReason
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import type { CollaborationRuntimeAvailabilityView } from "../collaboration/runtimeAvailabilityView";

export const COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS = 3_000;

export type CollaborationRuntimeAvailabilityBridge = Pick<
  PlanWeaveCollaborationApi,
  "readCollaborationCanvasRuntimeAvailability" | "resolveCollaborationCanvasScope"
>;

type ResolvedCanvasIdentity = {
  profileId: string;
  localProjectId: string;
  localCanvasId: string;
  remoteWorkspaceId: CanvasRuntimeStatusProjection["scope"]["workspaceId"];
  remoteProjectId: string;
  remoteCanvasId: string;
};

type RemoteAvailabilityState =
  | { kind: "checking" }
  | {
      kind: "available";
      identity: ResolvedCanvasIdentity;
      availability: Extract<CanvasRuntimeAvailability, { kind: "available" }>;
    }
  | { kind: "unavailable"; reason: CanvasRuntimeUnavailableReason }
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
  localProjectId: string | null;
  localCanvasId: string | null;
  graph: DesktopGraphViewModel | null;
  api?: CollaborationRuntimeAvailabilityBridge | null;
}): { graph: DesktopGraphViewModel | null; availability: CollaborationRuntimeAvailabilityView } {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const graphPackageFingerprint = input.graph?.packageFingerprint ?? null;
  const [remoteState, setRemoteState] = useState<RemoteAvailabilityState>({ kind: "checking" });

  useEffect(() => {
    if (!input.enabled || !input.sessionConnected) return undefined;
    if (
      !api ||
      !input.profileId ||
      !input.activeProjectId ||
      !input.localProjectId ||
      !input.localCanvasId ||
      !graphPackageFingerprint
    ) {
      setRemoteState({ kind: "error", message: "collaboration_runtime_scope_unavailable" });
      return undefined;
    }
    const profileId = input.profileId;
    const activeProjectId = input.activeProjectId;
    const localProjectId = input.localProjectId;
    const localCanvasId = input.localCanvasId;
    let active = true;
    let inFlight = false;
    let identity: ResolvedCanvasIdentity | null = null;
    setRemoteState({ kind: "checking" });

    const refresh = async () => {
      if (!active || inFlight || !identity) return;
      const currentIdentity = identity;
      inFlight = true;
      try {
        const next = await api.readCollaborationCanvasRuntimeAvailability({
          localProjectId,
          canvasId: localCanvasId
        });
        if (!active) return;
        if (!next) {
          setRemoteState({ kind: "error", message: "collaboration_runtime_availability_missing" });
        } else if (next.kind === "unavailable") {
          setRemoteState({ kind: "unavailable", reason: next.reason });
        } else if (!matchesResolvedCanvas(next.status, currentIdentity)) {
          setRemoteState({ kind: "error", message: "collaboration_runtime_scope_mismatch" });
        } else {
          setRemoteState({ kind: "available", identity: currentIdentity, availability: next });
        }
      } catch (caught) {
        if (active) setRemoteState({ kind: "error", message: errorMessage(caught) });
      } finally {
        inFlight = false;
      }
    };

    void api
      .resolveCollaborationCanvasScope({ localProjectId, canvasId: localCanvasId })
      .then((resolved) => {
        if (!active) return;
        if (!resolved || resolved.projectId !== activeProjectId) {
          setRemoteState({ kind: "error", message: "collaboration_runtime_scope_unavailable" });
          return;
        }
        identity = {
          profileId,
          localProjectId,
          localCanvasId,
          remoteWorkspaceId: resolved.workspaceId,
          remoteProjectId: resolved.projectId,
          remoteCanvasId: resolved.canvasId
        };
        void refresh();
      })
      .catch((caught: unknown) => {
        if (active) setRemoteState({ kind: "error", message: errorMessage(caught) });
      });
    const intervalId = setInterval(
      () => void refresh(),
      COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS
    );
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [
    api,
    input.activeProjectId,
    input.enabled,
    graphPackageFingerprint,
    input.localCanvasId,
    input.localProjectId,
    input.profileId,
    input.sessionConnected
  ]);

  const currentAvailableState =
    remoteState.kind === "available" &&
    input.profileId &&
    input.localProjectId &&
    input.localCanvasId &&
    input.activeProjectId &&
    remoteState.identity.profileId === input.profileId &&
    remoteState.identity.localProjectId === input.localProjectId &&
    remoteState.identity.localCanvasId === input.localCanvasId &&
    remoteState.identity.remoteProjectId === input.activeProjectId
      ? remoteState
      : null;

  return useMemo(() => {
    const availability: CollaborationRuntimeAvailabilityView = !input.enabled
      ? { kind: "not_applicable" }
      : !input.sessionConnected
        ? { kind: "server_disconnected" }
        : remoteState.kind === "available" && !currentAvailableState
          ? { kind: "checking" }
          : remoteState.kind === "available"
            ? { kind: "available" }
            : remoteState;
    const graph = input.graph
      ? availability.kind === "not_applicable"
        ? input.graph
        : availability.kind === "available" && currentAvailableState
          ? mergeAvailableCollaborationRuntimeStatus(
              input.graph,
              currentAvailableState.availability.status,
              {
                workspaceId: currentAvailableState.identity.remoteWorkspaceId,
                projectId: currentAvailableState.identity.remoteProjectId,
                canvasId: currentAvailableState.identity.remoteCanvasId
              }
            )
          : failClosedCollaborationRuntimeDispatchability(input.graph)
      : null;
    return { graph, availability };
  }, [currentAvailableState, input.enabled, input.graph, input.sessionConnected, remoteState]);
}

import type { DesktopAutoRunScope, DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";

type WorkspaceRemoteScopeSchedulerInput = {
  graph: DesktopGraphViewModel;
  scope: DesktopAutoRunScope;
  readStatus: () => Promise<CanvasRuntimeStatusProjection>;
  execute: (blockRef: string, signal?: AbortSignal) => Promise<void>;
  waitForStatusChange?: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

function scopeBlockRefs(
  graph: DesktopGraphViewModel,
  scope: DesktopAutoRunScope
): readonly string[] {
  if (scope.kind === "block") return [scope.blockRef];
  const tasks =
    scope.kind === "project"
      ? graph.tasks
      : graph.tasks.filter((task) => task.taskId === scope.taskId);
  return tasks.flatMap((task) => task.blocks.map((block) => block.ref));
}

const FAILED_SCOPE_STATUSES = new Set(["needs_changes", "blocked", "diverged"]);

function waitForFallbackRefresh(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, 1_000);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    function finish() {
      cleanup();
      resolve();
    }
    function cancel() {
      cleanup();
      reject(new Error("workspace_remote_scope_cancelled"));
    }
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * Advances a pure Workspace scope from the Server Runtime projection.
 * The Server remains the readiness authority; the renderer only dispatches rows marked dispatchable.
 */
export async function runWorkspaceRemoteScope(
  input: WorkspaceRemoteScopeSchedulerInput
): Promise<void> {
  const blockRefs = scopeBlockRefs(input.graph, input.scope);
  if (blockRefs.length === 0) return;
  const dispatchedBlockRefs = new Set<string>();
  const waitForStatusChange = input.waitForStatusChange ?? waitForFallbackRefresh;

  while (!input.signal?.aborted) {
    const status = await input.readStatus();
    if (input.signal?.aborted) throw new Error("workspace_remote_scope_cancelled");
    if (status.packageFingerprint !== input.graph.packageFingerprint) {
      throw new Error("workspace_remote_scope_content_mismatch");
    }
    const rowsByRef = new Map(status.blocks.map((row) => [row.ref, row]));
    const rows = blockRefs.map((ref) => {
      const row = rowsByRef.get(ref);
      if (!row) throw new Error(`workspace_remote_scope_status_missing:${ref}`);
      return row;
    });
    const failed = rows.find((row) => FAILED_SCOPE_STATUSES.has(row.status));
    if (failed) {
      throw new Error(`workspace_remote_scope_blocked:${failed.ref}:${failed.status}`);
    }
    if (rows.every((row) => row.status === "completed")) return;

    const dispatchable = rows.filter(
      (row) =>
        row.dispatchable &&
        row.status !== "completed" &&
        row.status !== "in_progress" &&
        !dispatchedBlockRefs.has(row.ref)
    );
    if (dispatchable.length === 0) {
      const serverMayStillAdvance = rows.some(
        (row) =>
          row.status === "in_progress" ||
          (row.status !== "completed" && dispatchedBlockRefs.has(row.ref))
      );
      if (!serverMayStillAdvance) {
        throw new Error("workspace_remote_scope_idle:no_dispatchable_blocks");
      }
      await waitForStatusChange(input.signal);
      continue;
    }

    const next = dispatchable[0];
    if (!next) continue;
    if (input.signal?.aborted) throw new Error("workspace_remote_scope_cancelled");
    // Mark before dispatch so a lagging Server projection cannot duplicate the operation.
    // Re-read after every operation because one completion may change other Blocks' readiness.
    dispatchedBlockRefs.add(next.ref);
    await input.execute(next.ref, input.signal);
  }

  throw new Error("workspace_remote_scope_cancelled");
}

export async function runWorkspaceRemoteScopeFromAvailability(input: {
  graph: DesktopGraphViewModel;
  scope: DesktopAutoRunScope;
  binding: { workspaceId: string; projectId: string; canvasId: string };
  readAvailability: () => Promise<CanvasRuntimeAvailability | null>;
  execute: (blockRef: string, signal?: AbortSignal) => Promise<void>;
  waitForStatusChange?: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const waitForStatusChange = input.waitForStatusChange ?? waitForFallbackRefresh;
  await runWorkspaceRemoteScope({
    graph: input.graph,
    scope: input.scope,
    readStatus: async () => {
      while (!input.signal?.aborted) {
        const availability = await input.readAvailability();
        if (!availability) throw new Error("collaboration_runtime_availability_unavailable");
        if (availability.state.kind === "uninitialized") {
          if (availability.execution.kind === "unavailable") {
            throw new Error(`collaboration_runtime_${availability.execution.reason}`);
          }
          await waitForStatusChange(input.signal);
          continue;
        }
        const status = availability.state.status;
        if (
          status.scope.workspaceId !== input.binding.workspaceId ||
          status.scope.projectId !== input.binding.projectId ||
          status.scope.canvasId !== input.binding.canvasId
        ) {
          throw new Error("collaboration_runtime_scope_mismatch");
        }
        return status;
      }
      throw new Error("workspace_remote_scope_cancelled");
    },
    execute: input.execute,
    waitForStatusChange,
    signal: input.signal
  });
}

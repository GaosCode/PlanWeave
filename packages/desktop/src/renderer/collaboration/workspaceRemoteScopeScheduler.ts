import type { DesktopAutoRunScope, DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";

type WorkspaceRemoteScopeSchedulerInput = {
  graph: DesktopGraphViewModel;
  scope: DesktopAutoRunScope;
  readStatus: () => Promise<CanvasRuntimeStatusProjection>;
  validateBeforeExecute?: (blockRef: string, signal?: AbortSignal) => Promise<void>;
  execute: (blockRef: string, signal?: AbortSignal) => Promise<void>;
  waitForStatusChange?: (signal?: AbortSignal) => Promise<void>;
  initiallyDispatchedBlockRefs?: readonly string[];
  signal?: AbortSignal;
};

function scopeRows(
  status: CanvasRuntimeStatusProjection,
  scope: DesktopAutoRunScope
): CanvasRuntimeStatusProjection["blocks"] {
  if (scope.kind === "block") {
    const row = status.blocks.find((block) => block.ref === scope.blockRef);
    if (!row) throw new Error(`workspace_remote_scope_status_missing:${scope.blockRef}`);
    return [row];
  }
  if (scope.kind === "task") {
    if (!status.tasks.some((task) => task.taskId === scope.taskId)) {
      throw new Error(`workspace_remote_scope_task_status_missing:${scope.taskId}`);
    }
    return status.blocks.filter((block) => block.ref.startsWith(`${scope.taskId}#`));
  }
  return status.blocks;
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
  const dispatchedBlockRefs = new Set(input.initiallyDispatchedBlockRefs);
  const waitForStatusChange = input.waitForStatusChange ?? waitForFallbackRefresh;

  while (!input.signal?.aborted) {
    const status = await input.readStatus();
    if (input.signal?.aborted) throw new Error("workspace_remote_scope_cancelled");
    if (status.packageFingerprint !== input.graph.packageFingerprint) {
      throw new Error("workspace_remote_scope_content_mismatch");
    }
    const rows = scopeRows(status, input.scope);
    if (rows.length === 0) return;
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
    await input.validateBeforeExecute?.(next.ref, input.signal);
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
  let pendingAvailability = await input.readAvailability();
  if (!pendingAvailability) throw new Error("collaboration_runtime_availability_unavailable");
  type CommandEvidence = {
    status: CanvasRuntimeStatusProjection;
    sourceRevision?: string;
    graphFingerprint: string;
  };
  let commandEvidence: CommandEvidence | undefined;

  const readServerEvidence = async (): Promise<CommandEvidence> => {
    const availability = pendingAvailability ?? (await input.readAvailability());
    pendingAvailability = null;
    if (!availability) throw new Error("collaboration_runtime_availability_unavailable");
    let status: CanvasRuntimeStatusProjection;
    if (availability.state.kind === "initialized") {
      status = availability.state.status;
    } else {
      if (availability.execution.kind === "unavailable") {
        throw new Error(`collaboration_runtime_${availability.execution.reason}`);
      }
      status = availability.execution.status;
    }
    if (
      status.scope.workspaceId !== input.binding.workspaceId ||
      status.scope.projectId !== input.binding.projectId ||
      status.scope.canvasId !== input.binding.canvasId
    ) {
      throw new Error("collaboration_runtime_scope_mismatch");
    }
    if (status.packageFingerprint !== input.graph.packageFingerprint) {
      throw new Error("workspace_remote_scope_content_mismatch");
    }
    if (availability.execution.kind === "unavailable") {
      return { status, graphFingerprint: status.packageFingerprint };
    }
    const execution = availability.execution;
    if (
      execution.status.scope.workspaceId !== input.binding.workspaceId ||
      execution.status.scope.projectId !== input.binding.projectId ||
      execution.status.scope.canvasId !== input.binding.canvasId
    ) {
      throw new Error("collaboration_runtime_scope_mismatch");
    }
    if (
      execution.graphFingerprint !== execution.status.packageFingerprint ||
      execution.graphFingerprint !== status.packageFingerprint
    ) {
      throw new Error("workspace_remote_scope_content_mismatch");
    }
    return {
      status,
      sourceRevision: execution.sourceRevision,
      graphFingerprint: execution.graphFingerprint
    };
  };

  await runWorkspaceRemoteScope({
    graph: input.graph,
    scope: input.scope,
    readStatus: async () => {
      while (!input.signal?.aborted) {
        commandEvidence = await readServerEvidence();
        return commandEvidence.status;
      }
      throw new Error("workspace_remote_scope_cancelled");
    },
    validateBeforeExecute: async (blockRef) => {
      const selected = commandEvidence;
      if (!selected) throw new Error("collaboration_runtime_availability_unavailable");
      const current = await readServerEvidence();
      if (
        selected.sourceRevision !== undefined &&
        current.sourceRevision !== selected.sourceRevision
      ) {
        throw new Error("workspace_remote_scope_source_mismatch");
      }
      if (current.graphFingerprint !== selected.graphFingerprint) {
        throw new Error("workspace_remote_scope_content_mismatch");
      }
      const row = scopeRows(current.status, input.scope).find(
        (candidate) => candidate.ref === blockRef
      );
      if (!row || !row.dispatchable || row.status === "completed" || row.status === "in_progress") {
        throw new Error("workspace_remote_scope_idle:no_dispatchable_blocks");
      }
    },
    execute: input.execute,
    waitForStatusChange,
    signal: input.signal
  });
}

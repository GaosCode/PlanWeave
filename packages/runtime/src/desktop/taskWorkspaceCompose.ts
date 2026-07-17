import { taskWorkspaceSchema, type TaskWorkspace } from "./types/taskWorkspaceAggregateTypes.js";
import type { TaskWorkspaceRunListItem } from "./types/taskWorkspaceQueryTypes.js";
import { projectTaskWorkspaceDuration } from "./taskWorkspaceDurationProjection.js";

/** Merge loaded run list pages into a Task Workspace for UI / live projection. */
export function composeTaskWorkspaceRuns(
  workspace: TaskWorkspace,
  items: readonly TaskWorkspaceRunListItem[],
  options: { now?: Date } = {}
): TaskWorkspace {
  const now = options.now ?? new Date();
  const byBlock = new Map<string, TaskWorkspaceRunListItem[]>();
  for (const item of items) {
    const list = byBlock.get(item.blockRef) ?? [];
    list.push(item);
    byBlock.set(item.blockRef, list);
  }
  const preferredSelected =
    workspace.selectedRecordId ?? items.find((item) => item.selected)?.run.record.recordId ?? null;
  const blocks = workspace.blocks.map((block) => {
    const blockItems = (byBlock.get(block.ref) ?? []).slice().sort((left, right) => {
      const byRetry = left.retryIndex - right.retryIndex;
      if (byRetry !== 0) return byRetry;
      return left.run.record.recordId.localeCompare(right.run.record.recordId);
    });
    return {
      ...block,
      runs: blockItems.map((item) => ({
        retryIndex: item.retryIndex,
        active: item.active,
        selected: preferredSelected !== null && item.run.record.recordId === preferredSelected,
        waitingInteraction: item.waitingInteraction,
        run: item.run
      }))
    };
  });
  const activeFromRuns = [
    ...new Set(
      blocks.flatMap((block) =>
        block.runs.filter((item) => item.active).map((item) => item.run.record.recordId)
      )
    )
  ];
  const selected =
    blocks.flatMap((block) => block.runs).find((item) => item.selected)?.run.record.recordId ??
    null;
  return taskWorkspaceSchema.parse({
    ...workspace,
    blocks,
    activeRecordIds: activeFromRuns.length > 0 ? activeFromRuns : workspace.activeRecordIds,
    selectedRecordId: selected,
    duration: projectTaskWorkspaceDuration(blocks, now)
  });
}

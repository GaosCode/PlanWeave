import type { TaskWorkspace, TaskWorkspaceBlock } from "@planweave-ai/runtime";
import type {
  TaskWorkspaceTimelineProjection,
  TimelineDefaultSelectionContext,
  TimelineRunProjection,
  TimelineRunStatus,
  TimelineSelection,
  TimelineWaveMembership
} from "./types";

type RunItem = TaskWorkspaceBlock["runs"][number];

function stableRunItems(block: TaskWorkspaceBlock): RunItem[] {
  return [...block.runs].sort((left, right) => {
    const retryOrder = left.retryIndex - right.retryIndex;
    if (retryOrder === 0) {
      return left.run.record.recordId.localeCompare(right.run.record.recordId);
    }
    return retryOrder;
  });
}

export function taskWorkspaceRunStatus(item: RunItem): TimelineRunStatus {
  if (item.waitingInteraction.active) {
    return "waiting";
  }
  if (item.active) {
    return "active";
  }
  if (item.run.metadata.exitCode !== null && item.run.metadata.exitCode !== 0) {
    return "failed";
  }
  if (item.run.duration.finishedAt !== null) {
    return "completed";
  }
  return "waiting";
}

function waveMemberships(workspace: TaskWorkspace): Map<string, TimelineWaveMembership> {
  const recordsByWave = new Map<string, string[]>();
  for (const block of workspace.blocks) {
    for (const item of stableRunItems(block)) {
      const waveId = item.run.executionWaveId;
      if (waveId !== null) {
        const recordIds = recordsByWave.get(waveId) ?? [];
        recordIds.push(item.run.record.recordId);
        recordsByWave.set(waveId, recordIds);
      }
    }
  }

  const memberships = new Map<string, TimelineWaveMembership>();
  for (const [waveId, recordIds] of recordsByWave) {
    if (recordIds.length >= 2) {
      recordIds.forEach((recordId, index) => {
        memberships.set(recordId, { index: index + 1, total: recordIds.length, waveId });
      });
    }
  }
  return memberships;
}

function projectRun(
  block: TaskWorkspaceBlock,
  item: RunItem,
  memberships: Map<string, TimelineWaveMembership>
): TimelineRunProjection {
  const { record } = item.run;
  return {
    active: item.active,
    blockRef: block.ref,
    blockTitle: block.title,
    executionWave: memberships.get(record.recordId) ?? null,
    finishedAt: item.run.duration.finishedAt,
    isRetry: item.retryIndex > 1,
    item,
    recordId: record.recordId,
    retryIndex: item.retryIndex,
    runId: record.runId,
    startedAt: item.run.duration.startedAt,
    status: taskWorkspaceRunStatus(item)
  };
}

export function projectTaskWorkspaceTimeline(
  workspace: TaskWorkspace
): TaskWorkspaceTimelineProjection {
  const memberships = waveMemberships(workspace);
  const blocks = workspace.blocks.map((block) => ({
    annotations: block.annotations,
    blockId: block.blockId,
    ref: block.ref,
    runs: stableRunItems(block).map((item) => projectRun(block, item, memberships)),
    title: block.title,
    type: block.type
  }));
  return { blocks, runs: blocks.flatMap((block) => block.runs) };
}

export function defaultTimelineSelection(
  workspace: TaskWorkspace,
  context: TimelineDefaultSelectionContext = {}
): TimelineSelection | null {
  const projection = projectTaskWorkspaceTimeline(workspace);
  let historyRun: TimelineRunProjection | undefined;
  if (context.historyRecordId) {
    historyRun = projection.runs.find((run) => run.recordId === context.historyRecordId);
  }
  if (historyRun) {
    return { blockRef: historyRun.blockRef, recordId: historyRun.recordId };
  }

  const activeRun = projection.runs.find((run) => run.active);
  if (activeRun) {
    return { blockRef: activeRun.blockRef, recordId: activeRun.recordId };
  }

  if (context.entryBlockRef) {
    const blockRuns = projection.blocks.find((block) => block.ref === context.entryBlockRef)?.runs;
    const latestBlockRun = blockRuns?.at(-1);
    if (latestBlockRun) {
      return { blockRef: latestBlockRun.blockRef, recordId: latestBlockRun.recordId };
    }
  }

  const [firstRun] = projection.runs;
  if (firstRun) {
    return { blockRef: firstRun.blockRef, recordId: firstRun.recordId };
  }
  return null;
}

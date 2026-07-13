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

type RunSeed = {
  block: TaskWorkspaceBlock;
  blockIndex: number;
  item: RunItem;
  ordinal: number;
};

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
  switch (item.run.metadata.terminalState) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
  if (item.run.metadata.exitCode !== null && item.run.metadata.exitCode !== 0) {
    return "failed";
  }
  if (item.run.duration.finishedAt !== null) {
    return "completed";
  }
  return "waiting";
}

function waveMemberships(seeds: RunSeed[]): Map<string, TimelineWaveMembership> {
  const recordsByWave = new Map<string, RunSeed[]>();
  for (const seed of seeds) {
    const { item } = seed;
    const waveId = item.run.executionWaveId;
    if (waveId !== null) {
      const waveSeeds = recordsByWave.get(waveId) ?? [];
      waveSeeds.push(seed);
      recordsByWave.set(waveId, waveSeeds);
    }
  }

  const memberships = new Map<string, TimelineWaveMembership>();
  for (const [waveId, waveSeeds] of recordsByWave) {
    if (waveSeeds.length >= 2) {
      waveSeeds
        .sort((left, right) =>
          left.blockIndex === right.blockIndex
            ? left.item.retryIndex - right.item.retryIndex
            : left.blockIndex - right.blockIndex
        )
        .forEach((seed, index) => {
          memberships.set(seed.item.run.record.recordId, {
            index: index + 1,
            total: waveSeeds.length,
            waveId
          });
        });
    }
  }
  return memberships;
}

function startedAtMs(item: RunItem): number | null {
  const value = item.run.duration.startedAt;
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function chronologicalRuns(
  seeds: RunSeed[],
  memberships: Map<string, TimelineWaveMembership>
): RunSeed[] {
  const groupStart = new Map<string, { ordinal: number; startedAt: number | null }>();
  for (const seed of seeds) {
    const membership = memberships.get(seed.item.run.record.recordId);
    const groupKey = membership ? `wave:${membership.waveId}` : `run:${seed.ordinal}`;
    const timestamp = startedAtMs(seed.item);
    const existing = groupStart.get(groupKey);
    groupStart.set(groupKey, {
      ordinal: Math.min(existing?.ordinal ?? seed.ordinal, seed.ordinal),
      startedAt:
        timestamp === null
          ? (existing?.startedAt ?? null)
          : Math.min(existing?.startedAt ?? timestamp, timestamp)
    });
  }
  return [...seeds].sort((left, right) => {
    const leftMembership = memberships.get(left.item.run.record.recordId);
    const rightMembership = memberships.get(right.item.run.record.recordId);
    const leftGroup = leftMembership ? `wave:${leftMembership.waveId}` : `run:${left.ordinal}`;
    const rightGroup = rightMembership ? `wave:${rightMembership.waveId}` : `run:${right.ordinal}`;
    if (leftGroup === rightGroup) {
      return left.blockIndex === right.blockIndex
        ? left.item.retryIndex - right.item.retryIndex
        : left.blockIndex - right.blockIndex;
    }
    const leftOrder = groupStart.get(leftGroup)!;
    const rightOrder = groupStart.get(rightGroup)!;
    if (leftOrder.startedAt !== null && rightOrder.startedAt !== null) {
      const timestampOrder = leftOrder.startedAt - rightOrder.startedAt;
      if (timestampOrder !== 0) return timestampOrder;
    } else if (leftOrder.startedAt !== null) {
      return -1;
    } else if (rightOrder.startedAt !== null) {
      return 1;
    }
    return leftOrder.ordinal - rightOrder.ordinal;
  });
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
  let ordinal = 0;
  const seeds = workspace.blocks.flatMap((block, blockIndex) =>
    stableRunItems(block).map((item) => ({ block, blockIndex, item, ordinal: ordinal++ }))
  );
  const memberships = waveMemberships(seeds);
  const blocks = workspace.blocks.map((block) => ({
    annotations: block.annotations,
    blockId: block.blockId,
    ref: block.ref,
    runs: stableRunItems(block).map((item) => projectRun(block, item, memberships)),
    title: block.title,
    type: block.type
  }));
  const runs = chronologicalRuns(seeds, memberships).map((seed) =>
    projectRun(seed.block, seed.item, memberships)
  );
  return { blocks, runs };
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

  const activeRuns = projection.runs.filter((run) => run.active);
  if (activeRuns.length === 1) {
    const [activeRun] = activeRuns;
    return { blockRef: activeRun!.blockRef, recordId: activeRun!.recordId };
  }
  if (activeRuns.length > 1) {
    return null;
  }

  if (context.entryBlockRef) {
    const blockRuns = projection.blocks.find((block) => block.ref === context.entryBlockRef)?.runs;
    const latestBlockRun = blockRuns?.at(-1);
    if (latestBlockRun) {
      return { blockRef: latestBlockRun.blockRef, recordId: latestBlockRun.recordId };
    }
  }

  const latestRun = projection.runs.at(-1);
  if (latestRun) {
    return { blockRef: latestRun.blockRef, recordId: latestRun.recordId };
  }
  return null;
}

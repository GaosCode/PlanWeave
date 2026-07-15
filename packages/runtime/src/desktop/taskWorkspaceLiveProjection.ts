import type { RunnerRecordReadModel } from "../autoRun/runnerRecordReadModel.js";
import type { RunnerRunIdentity } from "../autoRun/runnerContractSchemas.js";
import {
  taskWorkspaceSchema,
  type TaskWorkspace,
  type TaskWorkspaceBlock
} from "./types/taskWorkspaceAggregateTypes.js";
import { projectTaskWorkspaceDuration } from "./taskWorkspaceApi.js";
import {
  projectTaskWorkspaceCurrentContextUsage,
  projectTaskWorkspaceRunDuration
} from "./taskWorkspaceRunProjection.js";

function sameRunIdentity(left: RunnerRunIdentity, right: RunnerRunIdentity): boolean {
  return (
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId &&
    left.taskId === right.taskId &&
    left.blockId === right.blockId &&
    left.claimRef === right.claimRef &&
    left.runId === right.runId &&
    left.runOwner === right.runOwner &&
    left.runSessionId === right.runSessionId &&
    left.desktopRunId === right.desktopRunId &&
    left.executorRunId === right.executorRunId
  );
}

function assertLiveIdentity(options: {
  expected: RunnerRunIdentity;
  model: RunnerRecordReadModel;
  recordId: string;
}): void {
  const canonical = options.model.cursor.canonicalIdentity?.identity;
  if (canonical === undefined || !sameRunIdentity(options.expected, canonical)) {
    throw new Error(
      `Live Task Workspace model does not match selected record '${options.recordId}'.`
    );
  }
}

function projectClockBlocks(blocks: TaskWorkspaceBlock[], now: Date): TaskWorkspaceBlock[] {
  return blocks.map((block) => ({
    ...block,
    runs: block.runs.map((item) => ({
      ...item,
      run: {
        ...item.run,
        duration: item.active
          ? projectTaskWorkspaceRunDuration({
              startedAt: item.run.duration.startedAt,
              finishedAt: item.run.duration.finishedAt,
              now
            })
          : item.run.duration
      }
    }))
  }));
}

function projectWaitingInteraction(
  model: RunnerRecordReadModel
): TaskWorkspaceBlock["runs"][number]["waitingInteraction"] {
  const activeRequests = model.interaction.activeRequests;
  if (activeRequests.length === 0) {
    return { active: false, count: 0, kinds: [] };
  }
  return {
    active: true,
    count: activeRequests.length,
    kinds: [...new Set(activeRequests.map((request) => request.kind))].sort()
  };
}

export function projectTaskWorkspaceClockSnapshot(
  workspace: TaskWorkspace,
  now: Date
): TaskWorkspace {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Task Workspace clock projection requires a valid current time.");
  }
  const blocks = projectClockBlocks(workspace.blocks, now);
  return taskWorkspaceSchema.parse({
    ...workspace,
    blocks,
    duration: projectTaskWorkspaceDuration(blocks, now)
  });
}

function projectBlock(options: {
  block: TaskWorkspaceBlock;
  model: RunnerRecordReadModel;
  now: Date;
  recordId: string;
}): { block: TaskWorkspaceBlock; matched: boolean } {
  let matched = false;
  const runs = options.block.runs.map((item) => {
    const recordId = item.run.record.recordId;
    const selected = recordId === options.recordId;
    if (selected) {
      if (matched) {
        throw new Error(`Task Workspace record '${recordId}' is duplicated.`);
      }
      matched = true;
      assertLiveIdentity({
        expected: item.run.runIdentity,
        model: options.model,
        recordId
      });
    }
    const liveModel = selected ? options.model : null;
    const terminalEvent = liveModel
      ? [...liveModel.events].reverse().find((event) => event.body.kind === "terminal")
      : undefined;
    if (liveModel?.terminal && terminalEvent === undefined) {
      throw new Error(
        `Terminal live Task Workspace model for record '${recordId}' has no terminal event.`
      );
    }
    const terminalOutcome =
      terminalEvent?.body.kind === "terminal" ? terminalEvent.body.outcome : null;
    const finishedAt = terminalOutcome?.finishedAt ?? item.run.duration.finishedAt;
    const active = liveModel ? item.active && !liveModel.terminal : item.active;
    return {
      ...item,
      active,
      waitingInteraction: liveModel
        ? projectWaitingInteraction(liveModel)
        : item.waitingInteraction,
      run: {
        ...item.run,
        metadata: terminalOutcome
          ? {
              ...item.run.metadata,
              exitCode: terminalOutcome.exitCode,
              terminalState: terminalOutcome.state
            }
          : item.run.metadata,
        duration: projectTaskWorkspaceRunDuration({
          startedAt: item.run.duration.startedAt,
          finishedAt,
          now: options.now
        }),
        usage: liveModel
          ? {
              ...item.run.usage,
              currentContext: projectTaskWorkspaceCurrentContextUsage(liveModel.events)
            }
          : item.run.usage,
        actualConfiguration: liveModel
          ? liveModel.actualConfiguration
          : item.run.actualConfiguration,
        capabilities: liveModel
          ? {
              ...item.run.capabilities,
              prompt: liveModel.intervention.prompt,
              cancel: liveModel.intervention.cancel
            }
          : item.run.capabilities
      }
    };
  });
  return { block: { ...options.block, runs }, matched };
}

export function projectTaskWorkspaceLiveSnapshot(options: {
  workspace: TaskWorkspace;
  recordId: string;
  model: RunnerRecordReadModel;
  now: Date;
}): TaskWorkspace {
  if (!Number.isFinite(options.now.getTime())) {
    throw new Error("Task Workspace live projection requires a valid current time.");
  }
  const clockWorkspace = projectTaskWorkspaceClockSnapshot(options.workspace, options.now);
  let matched = false;
  const blocks = clockWorkspace.blocks.map((block) => {
    const projection = projectBlock({
      block,
      model: options.model,
      now: options.now,
      recordId: options.recordId
    });
    if (projection.matched) {
      if (matched) {
        throw new Error(`Task Workspace record '${options.recordId}' is duplicated.`);
      }
      matched = true;
    }
    return projection.block;
  });
  if (!matched) {
    throw new Error(
      `Live Task Workspace record '${options.recordId}' does not belong to this Task.`
    );
  }
  const activeRecordIds = blocks.flatMap((block) =>
    block.runs.flatMap((item) => (item.active ? [item.run.record.recordId] : []))
  );
  return taskWorkspaceSchema.parse({
    ...clockWorkspace,
    activeRecordIds,
    blocks,
    duration: projectTaskWorkspaceDuration(blocks, options.now)
  });
}

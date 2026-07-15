import { z } from "zod";
import { runnerRecordReadModelSchema } from "../autoRun/runnerRecordReadModelContract.js";
import {
  executionWaveIdSchema,
  runnerRunIdentitySchema,
  type RunnerRunIdentity
} from "../autoRun/runnerContractSchemas.js";
import { agentFamilySchema, runnerTransportSchema } from "../types/executor.js";
import type { DesktopRunRecord } from "./types/recordsTypes.js";
import {
  TASK_WORKSPACE_RESUME_UNAVAILABLE_REASON,
  TASK_WORKSPACE_RETRY_UNAVAILABLE_REASON,
  TASK_WORKSPACE_RUN_TOKENS_UNAVAILABLE_REASON,
  TASK_WORKSPACE_TASK_TOKENS_UNAVAILABLE_REASON,
  taskWorkspaceRunSchema,
  type TaskWorkspaceRun,
  type TaskWorkspaceRunDuration
} from "./types/taskWorkspaceTypes.js";

const TASK_WORKSPACE_PROMPT_READ_MODEL_UNAVAILABLE_REASON =
  "Send follow-up is unavailable because this run has no RunnerRecordReadModel capability.";
const TASK_WORKSPACE_CANCEL_READ_MODEL_UNAVAILABLE_REASON =
  "Stop current run is unavailable because this run has no RunnerRecordReadModel capability.";
const TASK_WORKSPACE_DURATION_UNAVAILABLE_REASON =
  "Run wall-clock duration is unavailable because startedAt is missing.";

const taskWorkspaceProjectionRecordSchema = z
  .object({
    recordId: z.string().min(1).max(1_024),
    kind: z.literal("block"),
    ref: z.string().min(3).max(513),
    taskId: z.string().min(1).max(256),
    blockId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    executor: z.string().min(1).nullable(),
    adapter: z.string().min(1).nullable(),
    executionCwd: z.string().min(1).nullable(),
    projectRoot: z.string().min(1).nullable(),
    agentSessionId: z.string().min(1).nullable(),
    tmuxSessionId: z.string().min(1).nullable().optional(),
    exitCode: z.number().int().nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    runnerReadModel: runnerRecordReadModelSchema.nullable()
  })
  .passthrough();

const taskWorkspaceProjectionMetadataSchema = z
  .object({
    executionWaveId: executionWaveIdSchema.optional(),
    runnerKind: runnerTransportSchema.nullable().optional(),
    agentId: agentFamilySchema.nullable().optional()
  })
  .passthrough();

export function projectTaskWorkspaceRunDuration(options: {
  startedAt: string | null;
  finishedAt: string | null;
  now: Date;
}): TaskWorkspaceRunDuration {
  if (Number.isNaN(options.now.getTime())) {
    throw new Error("Task Workspace run projection requires a valid injected current time.");
  }
  const calculatedAt = options.now.toISOString();
  if (options.startedAt === null) {
    return {
      startedAt: null,
      finishedAt: options.finishedAt,
      calculatedAt,
      wallClockMs: null,
      unavailableReason: TASK_WORKSPACE_DURATION_UNAVAILABLE_REASON
    };
  }

  const startedAtMs = Date.parse(options.startedAt);
  const durationEndMs =
    options.finishedAt === null ? options.now.getTime() : Date.parse(options.finishedAt);
  if (durationEndMs < startedAtMs) {
    throw new Error("Task Workspace run finishedAt/current time cannot precede startedAt.");
  }
  return {
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    calculatedAt,
    wallClockMs: durationEndMs - startedAtMs,
    unavailableReason: null
  };
}

export function projectTaskWorkspaceCurrentContextUsage(
  events: NonNullable<DesktopRunRecord["runnerReadModel"]>["events"] | undefined
): TaskWorkspaceRun["usage"]["currentContext"] {
  return (
    events?.reduce<TaskWorkspaceRun["usage"]["currentContext"]>((latest, event) => {
      if (event.body.kind !== "usage_update") {
        return latest;
      }
      if (latest !== null && latest.sequence >= event.sequence) {
        return latest;
      }
      return {
        aggregation: "snapshot",
        sequence: event.sequence,
        observedAt: event.timestamp,
        usedTokens: event.body.usedTokens,
        contextWindowTokens: event.body.contextWindowTokens,
        cost: event.body.cost
      };
    }, null) ?? null
  );
}

function projectCapabilities(
  readModel: DesktopRunRecord["runnerReadModel"],
  retry: TaskWorkspaceRun["capabilities"]["retry"] | undefined
): TaskWorkspaceRun["capabilities"] {
  return {
    prompt: readModel?.intervention.prompt ?? {
      available: false,
      reason: TASK_WORKSPACE_PROMPT_READ_MODEL_UNAVAILABLE_REASON,
      identity: null,
      inFlight: false
    },
    cancel: readModel?.intervention.cancel ?? {
      available: false,
      reason: TASK_WORKSPACE_CANCEL_READ_MODEL_UNAVAILABLE_REASON,
      identity: null
    },
    retry: retry ?? {
      available: false,
      reason: TASK_WORKSPACE_RETRY_UNAVAILABLE_REASON,
      identity: null
    },
    resume: {
      available: false,
      reason: TASK_WORKSPACE_RESUME_UNAVAILABLE_REASON,
      identity: null
    }
  };
}

function unavailableTokenUsage(): Pick<TaskWorkspaceRun["usage"], "runTokens" | "taskTokens"> {
  return {
    runTokens: {
      available: false,
      totalTokens: null,
      reason: TASK_WORKSPACE_RUN_TOKENS_UNAVAILABLE_REASON
    },
    taskTokens: {
      available: false,
      totalTokens: null,
      reason: TASK_WORKSPACE_TASK_TOKENS_UNAVAILABLE_REASON
    }
  };
}

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

function authoritativeRunIdentity(options: {
  supplied: RunnerRunIdentity;
  readModel: DesktopRunRecord["runnerReadModel"];
}): RunnerRunIdentity {
  if (options.readModel === null) {
    return options.supplied;
  }
  const canonical = options.readModel.cursor.canonicalIdentity?.identity;
  if (canonical === undefined || !sameRunIdentity(options.supplied, canonical)) {
    throw new Error(
      "Task Workspace RunnerRunIdentity must exactly match the canonical runner record identity."
    );
  }
  return canonical;
}

export function projectTaskWorkspaceRun(options: {
  record: DesktopRunRecord;
  runIdentity: RunnerRunIdentity;
  now: Date;
  retry?: TaskWorkspaceRun["capabilities"]["retry"];
}): TaskWorkspaceRun {
  const record = taskWorkspaceProjectionRecordSchema.parse(options.record);
  const suppliedRunIdentity = runnerRunIdentitySchema.parse(options.runIdentity);
  const runIdentity = authoritativeRunIdentity({
    supplied: suppliedRunIdentity,
    readModel: record.runnerReadModel
  });
  const metadata = taskWorkspaceProjectionMetadataSchema.parse(record.metadata);
  const terminalState = [...(record.runnerReadModel?.events ?? [])]
    .reverse()
    .find((event) => event.body.kind === "terminal")?.body;

  return taskWorkspaceRunSchema.parse({
    version: "planweave.task-workspace-run/v1",
    kind: "block",
    record: {
      recordId: record.recordId,
      ref: record.ref,
      taskId: record.taskId,
      blockId: record.blockId,
      runId: record.runId
    },
    runIdentity,
    metadata: {
      executor: record.executor,
      adapter: record.adapter,
      runnerKind: metadata.runnerKind ?? null,
      agentId: metadata.agentId ?? null,
      executionCwd: record.executionCwd,
      projectRoot: record.projectRoot,
      agentSessionId: record.agentSessionId,
      tmuxSessionId: record.tmuxSessionId ?? null,
      exitCode: record.exitCode,
      terminalState: terminalState?.kind === "terminal" ? terminalState.outcome.state : null
    },
    executionWaveId: metadata.executionWaveId ?? null,
    duration: projectTaskWorkspaceRunDuration({
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      now: options.now
    }),
    usage: {
      currentContext: projectTaskWorkspaceCurrentContextUsage(record.runnerReadModel?.events),
      ...unavailableTokenUsage()
    },
    actualConfiguration: record.runnerReadModel?.actualConfiguration ?? {
      available: false,
      reason:
        "Actual session configuration is unavailable because this run has no ACP RunnerRecordReadModel."
    },
    capabilities: projectCapabilities(record.runnerReadModel, options.retry)
  });
}

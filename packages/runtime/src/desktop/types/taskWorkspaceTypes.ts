import { z } from "zod";
import { agentFamilySchema, runnerTransportSchema } from "../../types/executor.js";
import {
  canvasIdSchema,
  executionWaveIdSchema,
  runnerTerminalStateSchema,
  runnerRunIdentitySchema,
  runnerSessionActionIdentitySchema,
  taskIdSchema
} from "../../autoRun/runnerContractSchemas.js";
import { desktopAgentPromptIdentitySchema } from "../../autoRun/runnerRecordReadModelContract.js";
import { acpActualSessionConfigurationSchema } from "../../autoRun/acpSessionConfiguration.js";
import { parseRunRecordId, runRecordId } from "../runRecordIdentity.js";

export const TASK_WORKSPACE_RETRY_UNAVAILABLE_REASON =
  "Retry is unavailable for this persisted run.";
export const TASK_WORKSPACE_RESUME_UNAVAILABLE_REASON =
  "Continue session is unavailable because runtime does not provide a live resume API.";
export const TASK_WORKSPACE_RUN_TOKENS_UNAVAILABLE_REASON =
  "Run token accounting is unavailable because usage_update.usedTokens is a current-context snapshot, not cumulative consumption.";
export const TASK_WORKSPACE_TASK_TOKENS_UNAVAILABLE_REASON =
  "Task token accounting is unavailable because runtime has no authoritative cumulative token source.";

const nonEmptyStringSchema = z.string().min(1).max(4_096);
const nullableNonEmptyStringSchema = nonEmptyStringSchema.nullable();
const availabilityBaseSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().min(1).max(1_024).nullable()
  })
  .strict();

function requireAvailableIdentity(
  value: { available: boolean; reason: string | null; identity: unknown },
  context: z.RefinementCtx
): void {
  if (value.available && value.identity === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identity"],
      message: "An available action requires an exact runtime-validated identity."
    });
  }
  if (value.available && value.reason !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "An available action cannot have an unavailable reason."
    });
  }
  if (!value.available && value.reason === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "An unavailable action requires a reason."
    });
  }
}

export const taskWorkspacePromptCapabilitySchema = availabilityBaseSchema
  .extend({
    identity: desktopAgentPromptIdentitySchema.nullable(),
    inFlight: z.boolean()
  })
  .strict()
  .superRefine(requireAvailableIdentity);

export const taskWorkspaceCancelCapabilitySchema = availabilityBaseSchema
  .extend({ identity: runnerSessionActionIdentitySchema.nullable() })
  .strict()
  .superRefine(requireAvailableIdentity);

export const taskWorkspaceRetryIdentitySchema = z
  .object({
    version: z.literal("planweave.task-workspace-retry/v1"),
    projectId: nonEmptyStringSchema.max(256),
    projectRoot: nonEmptyStringSchema,
    canvasId: canvasIdSchema,
    taskId: taskIdSchema,
    blockId: nonEmptyStringSchema.max(256),
    claimRef: nonEmptyStringSchema.max(513),
    recordId: nonEmptyStringSchema.max(1_024),
    runId: nonEmptyStringSchema.max(256),
    executorRunId: nonEmptyStringSchema.max(256)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.claimRef !== `${value.taskId}#${value.blockId}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claimRef"],
        message: "Retry claimRef must equal '<taskId>#<blockId>'."
      });
    }
    if (value.recordId !== runRecordId(value.claimRef, value.runId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recordId"],
        message: "Retry recordId must equal '<claimRef>::<runId>'."
      });
    }
    if (value.executorRunId !== value.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executorRunId"],
        message: "Retry executorRunId must equal runId."
      });
    }
  });

export const taskWorkspaceRetryCapabilitySchema = availabilityBaseSchema
  .extend({ identity: taskWorkspaceRetryIdentitySchema.nullable() })
  .strict()
  .superRefine(requireAvailableIdentity);

const unavailableFutureActionSchema = z
  .object({
    available: z.literal(false),
    reason: z.string().min(1).max(1_024),
    identity: z.null()
  })
  .strict();

export const taskWorkspaceRunCapabilitiesSchema = z
  .object({
    prompt: taskWorkspacePromptCapabilitySchema,
    cancel: taskWorkspaceCancelCapabilitySchema,
    retry: taskWorkspaceRetryCapabilitySchema,
    resume: unavailableFutureActionSchema
  })
  .strict();

export const taskWorkspaceContextUsageSnapshotSchema = z
  .object({
    aggregation: z.literal("snapshot"),
    sequence: z.number().int().positive(),
    observedAt: z.string().datetime(),
    usedTokens: z.number().int().nonnegative(),
    contextWindowTokens: z.number().int().positive(),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string().length(3)
      })
      .strict()
      .nullable()
  })
  .strict();

export const taskWorkspaceUnavailableTokenAccountingSchema = z
  .object({
    available: z.literal(false),
    totalTokens: z.null(),
    reason: z.string().min(1).max(1_024)
  })
  .strict();

export const taskWorkspaceRunUsageSchema = z
  .object({
    currentContext: taskWorkspaceContextUsageSnapshotSchema.nullable(),
    runTokens: taskWorkspaceUnavailableTokenAccountingSchema,
    taskTokens: taskWorkspaceUnavailableTokenAccountingSchema
  })
  .strict();

export const taskWorkspaceRunDurationSchema = z
  .object({
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    calculatedAt: z.string().datetime(),
    wallClockMs: z.number().int().nonnegative().nullable(),
    unavailableReason: z.string().min(1).max(1_024).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startedAt === null && value.wallClockMs !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wallClockMs"],
        message: "Run duration cannot contain wallClockMs when startedAt is unavailable."
      });
    }
    if (value.startedAt === null && value.unavailableReason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unavailableReason"],
        message: "Run duration requires an unavailable reason when startedAt is unavailable."
      });
    }
    if ((value.wallClockMs === null) !== (value.unavailableReason !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wallClockMs"],
        message: "Run duration must contain either wallClockMs or an unavailable reason."
      });
    }
  });

export const taskWorkspaceRunRecordIdentitySchema = z
  .object({
    recordId: nonEmptyStringSchema.max(1_024),
    ref: nonEmptyStringSchema.max(513),
    taskId: nonEmptyStringSchema.max(256),
    blockId: nonEmptyStringSchema.max(256),
    runId: nonEmptyStringSchema.max(256)
  })
  .strict();

export const taskWorkspaceRunMetadataSchema = z
  .object({
    executor: nullableNonEmptyStringSchema,
    adapter: nullableNonEmptyStringSchema,
    runnerKind: runnerTransportSchema.nullable(),
    agentId: agentFamilySchema.nullable(),
    executionCwd: nullableNonEmptyStringSchema,
    projectRoot: nullableNonEmptyStringSchema,
    agentSessionId: nullableNonEmptyStringSchema,
    tmuxSessionId: nullableNonEmptyStringSchema,
    exitCode: z.number().int().nullable(),
    terminalState: runnerTerminalStateSchema.nullable()
  })
  .strict();

export const taskWorkspaceRunSchema = z
  .object({
    version: z.literal("planweave.task-workspace-run/v1"),
    kind: z.literal("block"),
    record: taskWorkspaceRunRecordIdentitySchema,
    runIdentity: runnerRunIdentitySchema,
    metadata: taskWorkspaceRunMetadataSchema,
    executionWaveId: executionWaveIdSchema.nullable(),
    duration: taskWorkspaceRunDurationSchema,
    usage: taskWorkspaceRunUsageSchema,
    actualConfiguration: acpActualSessionConfigurationSchema,
    capabilities: taskWorkspaceRunCapabilitiesSchema
  })
  .strict()
  .superRefine((value, context) => {
    const { record, runIdentity: identity } = value;
    try {
      const parsedRecordId = parseRunRecordId(record.recordId);
      if (
        parsedRecordId.kind !== "block" ||
        parsedRecordId.blockRef !== record.ref ||
        parsedRecordId.runId !== record.runId ||
        record.recordId !== runRecordId(record.ref, record.runId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["record", "recordId"],
          message: "Block recordId must equal '<blockRef>::<runId>'."
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["record", "recordId"],
        message: "Block recordId must use the canonical '<blockRef>::<runId>' format."
      });
    }
    if (
      identity.claimRef !== record.ref ||
      identity.taskId !== record.taskId ||
      identity.blockId !== record.blockId ||
      identity.runId !== record.runId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runIdentity"],
        message: "RunnerRunIdentity must match the selected persisted block record."
      });
    }
    if (identity.executorRunId !== record.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runIdentity", "executorRunId"],
        message: "RunnerRunIdentity executorRunId must equal the persisted record runId."
      });
    }
    const promptIdentity = value.capabilities.prompt.identity;
    if (
      promptIdentity !== null &&
      (promptIdentity.recordId !== record.recordId ||
        promptIdentity.claimRef !== record.ref ||
        promptIdentity.executorRunId !== identity.executorRunId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "prompt", "identity"],
        message: "Prompt action identity must match the selected persisted block record."
      });
    }
    const cancelIdentity = value.capabilities.cancel.identity;
    if (
      cancelIdentity !== null &&
      (cancelIdentity.claimRef !== record.ref ||
        cancelIdentity.executorRunId !== identity.executorRunId ||
        cancelIdentity.desktopRunId !== identity.desktopRunId ||
        cancelIdentity.runSessionId !== identity.runSessionId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "cancel", "identity"],
        message: "Cancel action identity must match the selected RunnerRunIdentity."
      });
    }
    const retryIdentity = value.capabilities.retry.identity;
    if (
      retryIdentity !== null &&
      (retryIdentity.projectId !== identity.projectId ||
        retryIdentity.canvasId !== identity.canvasId ||
        retryIdentity.taskId !== record.taskId ||
        retryIdentity.blockId !== record.blockId ||
        retryIdentity.claimRef !== record.ref ||
        retryIdentity.recordId !== record.recordId ||
        retryIdentity.runId !== record.runId ||
        retryIdentity.executorRunId !== identity.executorRunId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "retry", "identity"],
        message: "Retry action identity must match the selected persisted block record."
      });
    }
    if (
      promptIdentity !== null &&
      cancelIdentity !== null &&
      promptIdentity.sessionId !== cancelIdentity.sessionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "cancel", "identity", "sessionId"],
        message: "Prompt and cancel action identities must target the same sessionId."
      });
    }
  });

export type TaskWorkspacePromptCapability = z.infer<typeof taskWorkspacePromptCapabilitySchema>;
export type TaskWorkspaceCancelCapability = z.infer<typeof taskWorkspaceCancelCapabilitySchema>;
export type TaskWorkspaceRetryIdentity = z.infer<typeof taskWorkspaceRetryIdentitySchema>;
export type TaskWorkspaceRetryCapability = z.infer<typeof taskWorkspaceRetryCapabilitySchema>;
export type TaskWorkspaceRunCapabilities = z.infer<typeof taskWorkspaceRunCapabilitiesSchema>;
export type TaskWorkspaceContextUsageSnapshot = z.infer<
  typeof taskWorkspaceContextUsageSnapshotSchema
>;
export type TaskWorkspaceUnavailableTokenAccounting = z.infer<
  typeof taskWorkspaceUnavailableTokenAccountingSchema
>;
export type TaskWorkspaceRunUsage = z.infer<typeof taskWorkspaceRunUsageSchema>;
export type TaskWorkspaceRunDuration = z.infer<typeof taskWorkspaceRunDurationSchema>;
export type TaskWorkspaceRunRecordIdentity = z.infer<typeof taskWorkspaceRunRecordIdentitySchema>;
export type TaskWorkspaceRunMetadata = z.infer<typeof taskWorkspaceRunMetadataSchema>;
export type TaskWorkspaceRun = z.infer<typeof taskWorkspaceRunSchema>;

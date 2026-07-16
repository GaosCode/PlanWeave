import { z } from "zod";
import { canvasIdSchema, taskIdSchema } from "../../autoRun/runnerContractSchemas.js";
import { runnerRecordReadModelSchema } from "../../autoRun/runnerRecordReadModelContract.js";
import { parseRunRecordId } from "../runRecordIdentity.js";
import {
  taskWorkspaceInputSchema,
  taskWorkspaceRunItemSchema,
  taskWorkspaceWaitingInteractionSchema
} from "./taskWorkspaceAggregateTypes.js";
import { taskWorkspaceRunSchema } from "./taskWorkspaceTypes.js";

const nonEmptyStringSchema = z.string().min(1).max(4_096);
const nullableStringSchema = z.string().max(4_096).nullable();

/** Default page size for Task Workspace run summary lists. */
export const TASK_WORKSPACE_RUNS_DEFAULT_LIMIT = 50;
/** Hard upper bound for Task Workspace run summary page size. */
export const TASK_WORKSPACE_RUNS_MAX_LIMIT = 100;

export const taskWorkspaceRunsCursorSchema = z
  .object({
    version: z.literal("planweave.task-workspace-runs-cursor/v2"),
    taskId: taskIdSchema,
    canvasId: canvasIdSchema,
    /** Logical keyset anchor, independent from index generation and physical pages. */
    orderedAt: z.string().datetime({ offset: true }),
    recordId: nonEmptyStringSchema.max(1_024)
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const parsed = parseRunRecordId(value.recordId);
      // Task Workspace run pages only page block runs. Feedback recordIds must not be
      // accepted as continuation tokens even when syntax and sortKey are valid.
      if (parsed.kind !== "block") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recordId"],
          message: `Cursor recordId must identify a block run; got '${value.recordId}'.`
        });
        return;
      }
    } catch (error: unknown) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recordId"],
        message:
          error instanceof Error
            ? error.message
            : `Cursor recordId '${value.recordId}' is invalid.`
      });
    }
  });

export const taskWorkspaceListRunsInputSchema = z
  .object({
    projectRoot: nonEmptyStringSchema,
    canvasId: canvasIdSchema,
    taskId: taskIdSchema,
    cursor: taskWorkspaceRunsCursorSchema.nullable().optional(),
    limit: z.number().int().positive().max(TASK_WORKSPACE_RUNS_MAX_LIMIT).optional()
  })
  .strict();

export const taskWorkspaceRunDetailInputSchema = z
  .object({
    projectRoot: nonEmptyStringSchema,
    canvasId: canvasIdSchema,
    taskId: taskIdSchema,
    recordId: nonEmptyStringSchema.max(1_024)
  })
  .strict();

export const taskWorkspaceRunListItemSchema = z
  .object({
    blockRef: nonEmptyStringSchema.max(513),
    retryIndex: z.number().int().positive(),
    active: z.boolean(),
    selected: z.boolean(),
    waitingInteraction: taskWorkspaceWaitingInteractionSchema,
    run: taskWorkspaceRunSchema
  })
  .strict();

export const taskWorkspaceRunsPageSchema = z
  .object({
    version: z.literal("planweave.task-workspace-runs-page/v1"),
    projectRoot: nonEmptyStringSchema,
    canvasId: canvasIdSchema,
    taskId: taskIdSchema,
    limit: z.number().int().positive().max(TASK_WORKSPACE_RUNS_MAX_LIMIT),
    items: z.array(taskWorkspaceRunListItemSchema).max(TASK_WORKSPACE_RUNS_MAX_LIMIT),
    nextCursor: taskWorkspaceRunsCursorSchema.nullable()
  })
  .strict();

/**
 * Full selected-run detail record shared across runtime → main → preload → renderer.
 * Validates identity, text surfaces, and RunnerRecordReadModel — no passthrough extras.
 */
export const desktopRunRecordSchema = z
  .object({
    recordId: nonEmptyStringSchema.max(1_024),
    kind: z.enum(["block", "feedback"]).optional(),
    ref: nonEmptyStringSchema.max(513),
    feedbackId: z.string().min(1).max(256).nullable().optional(),
    sourceReviewBlockRef: z.string().min(1).max(513).nullable().optional(),
    taskId: nonEmptyStringSchema.max(256),
    blockId: nonEmptyStringSchema.max(256),
    runId: nonEmptyStringSchema.max(256),
    executor: nullableStringSchema,
    adapter: nullableStringSchema,
    executionCwd: nullableStringSchema,
    projectRoot: nullableStringSchema,
    agentSessionId: nullableStringSchema,
    codexSessionId: nullableStringSchema,
    tmuxSessionId: nullableStringSchema.optional(),
    tmuxAttachCommand: nullableStringSchema.optional(),
    tmuxReadOnlyAttachCommand: nullableStringSchema.optional(),
    exitCode: z.number().int().nullable(),
    startedAt: z.string().max(128).nullable(),
    finishedAt: z.string().max(128).nullable(),
    promptPath: nullableStringSchema,
    reportPath: nullableStringSchema,
    metadataPath: nonEmptyStringSchema,
    stdoutUpdatedAt: z.string().max(128).nullable().optional(),
    stderrUpdatedAt: z.string().max(128).nullable().optional(),
    metadataUpdatedAt: z.string().max(128).nullable().optional(),
    heartbeatPath: nullableStringSchema.optional(),
    heartbeatUpdatedAt: z.string().max(128).nullable().optional(),
    heartbeatStatus: z.string().max(256).nullable().optional(),
    heartbeatPid: z.number().int().nullable().optional(),
    lastHeartbeatAt: z.string().max(128).nullable().optional(),
    lastActivityAt: z.string().max(128).nullable().optional(),
    lastOutputAt: z.string().max(128).nullable().optional(),
    stdoutSummary: z.string(),
    stderrSummary: z.string(),
    promptMarkdown: z.string(),
    reportMarkdown: z.string(),
    displayMarkdown: z.string(),
    displayMarkdownSource: z.enum(["report", "live-output", "none"]),
    metadata: z.record(z.string(), z.unknown()),
    runnerReadModel: runnerRecordReadModelSchema.nullable()
  })
  .strict();

/** Alias used by IPC/main validation paths that already import this name. */
export const taskWorkspaceRunDetailRecordIdentitySchema = desktopRunRecordSchema;

export const taskWorkspaceRunDetailSchema = z
  .object({
    version: z.literal("planweave.task-workspace-run-detail/v1"),
    projectRoot: nonEmptyStringSchema,
    canvasId: canvasIdSchema,
    taskId: taskIdSchema,
    blockRef: nonEmptyStringSchema.max(513),
    item: taskWorkspaceRunItemSchema,
    record: desktopRunRecordSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.record.recordId !== value.item.run.record.recordId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["record", "recordId"],
        message: "Detail recordId must match the projected run item."
      });
    }
    if (value.record.ref !== value.blockRef || value.record.taskId !== value.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["record"],
        message: "Detail record must belong to the requested task and block."
      });
    }
  });

/** Header query reuses the existing workspace input (selection is a hint only). */
export const taskWorkspaceHeaderInputSchema = taskWorkspaceInputSchema;

export type TaskWorkspaceRunsCursor = z.infer<typeof taskWorkspaceRunsCursorSchema>;
export type TaskWorkspaceListRunsInput = z.infer<typeof taskWorkspaceListRunsInputSchema>;
export type TaskWorkspaceRunDetailInput = z.infer<typeof taskWorkspaceRunDetailInputSchema>;
export type TaskWorkspaceRunListItem = z.infer<typeof taskWorkspaceRunListItemSchema>;
export type TaskWorkspaceRunsPage = z.infer<typeof taskWorkspaceRunsPageSchema>;
export type TaskWorkspaceRunDetail = z.infer<typeof taskWorkspaceRunDetailSchema>;
export type DesktopRunRecordPayload = z.infer<typeof desktopRunRecordSchema>;

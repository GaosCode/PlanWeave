import { z } from "zod";
import {
  artifactReferenceSchema,
  canvasIdSchema,
  pendingInteractionKindSchema,
  taskIdSchema
} from "../../autoRun/runnerContractSchemas.js";
import { blockTypes } from "../../types/manifest.js";
import {
  blockStatuses,
  feedbackStatuses,
  reviewVerdicts,
  taskStatuses
} from "../../types/state.js";
import { promptSourceSummarySchema } from "../../taskManager/promptContracts.js";
import {
  taskWorkspaceRunSchema,
  taskWorkspaceUnavailableTokenAccountingSchema
} from "./taskWorkspaceTypes.js";

const nonEmptyStringSchema = z.string().min(1).max(4_096);

export const TASK_WORKSPACE_TASK_COST_UNAVAILABLE_REASON =
  "Task cost accounting is unavailable because runtime has no authoritative cumulative cost source.";

export const taskWorkspaceInputSchema = z
  .object({
    projectRoot: nonEmptyStringSchema,
    canvasId: canvasIdSchema,
    taskId: taskIdSchema,
    selectedRecordId: nonEmptyStringSchema.max(1_024).nullable().optional()
  })
  .strict();

export const taskWorkspaceWaitingInteractionSchema = z.discriminatedUnion("active", [
  z
    .object({
      active: z.literal(false),
      count: z.literal(0),
      kinds: z.array(pendingInteractionKindSchema).length(0)
    })
    .strict(),
  z
    .object({
      active: z.literal(true),
      count: z.number().int().positive(),
      kinds: z.array(pendingInteractionKindSchema).min(1).max(3)
    })
    .strict()
]);

export const taskWorkspaceRunItemSchema = z
  .object({
    retryIndex: z.number().int().positive(),
    active: z.boolean(),
    selected: z.boolean(),
    waitingInteraction: taskWorkspaceWaitingInteractionSchema,
    run: taskWorkspaceRunSchema
  })
  .strict();

const annotationIdentityShape = {
  annotationId: nonEmptyStringSchema.max(1_024),
  sourceReviewBlockRef: nonEmptyStringSchema.max(513)
};

export const taskWorkspaceAnnotationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...annotationIdentityShape,
      kind: z.literal("review_attempt"),
      associatedRunRecordId: z.null(),
      attemptId: nonEmptyStringSchema.max(256),
      verdict: z.enum(reviewVerdicts).nullable(),
      content: z.string(),
      contentPreview: z.string().max(400),
      reviewedAt: z.string().datetime().nullable()
    })
    .strict(),
  z
    .object({
      ...annotationIdentityShape,
      kind: z.literal("feedback"),
      associatedRunRecordId: z.null(),
      feedbackId: nonEmptyStringSchema.max(256),
      sourceReviewAttemptId: nonEmptyStringSchema.max(256).nullable(),
      status: z.enum(feedbackStatuses),
      latestSubmissionId: nonEmptyStringSchema.max(256).nullable(),
      content: z.string(),
      contentPreview: z.string().max(400),
      createdAt: z.string().datetime().nullable()
    })
    .strict(),
  z
    .object({
      ...annotationIdentityShape,
      kind: z.literal("feedback_run"),
      associatedRunRecordId: nonEmptyStringSchema.max(1_024),
      recordId: nonEmptyStringSchema.max(1_024),
      feedbackId: nonEmptyStringSchema.max(256).nullable(),
      sourceReviewAttemptId: nonEmptyStringSchema.max(256).nullable(),
      status: z.enum(feedbackStatuses).nullable(),
      contentPreview: z.string().max(400),
      startedAt: z.string().datetime().nullable(),
      finishedAt: z.string().datetime().nullable(),
      reportPath: nonEmptyStringSchema.nullable()
    })
    .strict()
    .superRefine((value, context) => {
      if (value.associatedRunRecordId !== value.recordId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["associatedRunRecordId"],
          message: "Feedback run annotation must associate its own persisted recordId."
        });
      }
    })
]);

export const taskWorkspaceDependencyProgressSchema = z
  .object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    percent: z.number().int().min(0).max(100),
    status: z.enum(["not_applicable", "pending", "in_progress", "completed"]),
    blockers: z.array(nonEmptyStringSchema.max(513))
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed > value.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed"],
        message: "Completed dependency count cannot exceed total dependency count."
      });
      return;
    }
    const expectedPercent =
      value.total === 0 ? 100 : Math.floor((value.completed / value.total) * 100);
    const expectedStatus =
      value.total === 0
        ? "not_applicable"
        : value.completed === value.total
          ? "completed"
          : value.completed === 0
            ? "pending"
            : "in_progress";
    if (value.percent !== expectedPercent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["percent"],
        message: "Dependency percent must be derived from completed and total counts."
      });
    }
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Dependency status must match completed and total counts."
      });
    }
  });

export const taskWorkspaceBlockSchema = z
  .object({
    ref: nonEmptyStringSchema.max(513),
    taskId: taskIdSchema,
    blockId: nonEmptyStringSchema.max(256),
    type: z.enum(blockTypes),
    title: nonEmptyStringSchema,
    status: z.enum(blockStatuses),
    executor: nonEmptyStringSchema.nullable(),
    effectiveExecutor: nonEmptyStringSchema.nullable(),
    promptMarkdown: z.string(),
    promptMissing: z.boolean(),
    promptSurfaceMarkdown: z.string(),
    promptSources: z.array(promptSourceSummarySchema),
    dependencies: taskWorkspaceDependencyProgressSchema,
    runs: z.array(taskWorkspaceRunItemSchema),
    annotations: z.array(taskWorkspaceAnnotationSchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type !== "review" && value.annotations.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["annotations"],
        message: "Only Review Blocks may contain review or feedback annotations."
      });
    }
    value.annotations.forEach((annotation, index) => {
      if (annotation.sourceReviewBlockRef !== value.ref) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["annotations", index, "sourceReviewBlockRef"],
          message: "Annotation source must equal its containing Review Block ref."
        });
      }
    });
  });

export const taskWorkspaceWallClockSchema = z
  .discriminatedUnion("available", [
    z
      .object({
        available: z.literal(true),
        startedAt: z.string().datetime(),
        endedAt: z.string().datetime(),
        calculatedAt: z.string().datetime(),
        totalMs: z.number().int().nonnegative(),
        unavailableReason: z.null()
      })
      .strict(),
    z
      .object({
        available: z.literal(false),
        startedAt: z.null(),
        endedAt: z.null(),
        calculatedAt: z.string().datetime(),
        totalMs: z.null(),
        unavailableReason: nonEmptyStringSchema
      })
      .strict()
  ])
  .superRefine((value, context) => {
    if (!value.available) return;
    const startedAt = Date.parse(value.startedAt);
    const endedAt = Date.parse(value.endedAt);
    if (endedAt < startedAt || value.totalMs !== endedAt - startedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalMs"],
        message: "Available wall-clock total must equal endedAt minus startedAt."
      });
    }
  });

export const taskWorkspaceAgentTimeSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("complete"),
      totalMs: z.number().int().nonnegative(),
      includedRunCount: z.number().int().positive(),
      missingRunCount: z.literal(0),
      reason: z.null()
    })
    .strict(),
  z
    .object({
      availability: z.literal("partial"),
      totalMs: z.number().int().nonnegative(),
      includedRunCount: z.number().int().positive(),
      missingRunCount: z.number().int().positive(),
      reason: nonEmptyStringSchema
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      totalMs: z.null(),
      includedRunCount: z.literal(0),
      missingRunCount: z.number().int().nonnegative(),
      reason: nonEmptyStringSchema
    })
    .strict()
]);

export const taskWorkspaceLatestArtifactSchema = z
  .object({
    recordId: nonEmptyStringSchema.max(1_024),
    blockRef: nonEmptyStringSchema.max(513),
    runId: nonEmptyStringSchema.max(256),
    reportPath: nonEmptyStringSchema.nullable(),
    reference: artifactReferenceSchema.nullable(),
    legacy: z.boolean()
  })
  .strict();

export const taskWorkspaceCostAccountingSchema = z
  .object({
    available: z.literal(false),
    totals: z.null(),
    reason: nonEmptyStringSchema
  })
  .strict();

export const taskWorkspaceSchema = z
  .object({
    version: z.literal("planweave.task-workspace/v1"),
    project: z
      .object({
        projectId: nonEmptyStringSchema.max(256),
        projectRoot: nonEmptyStringSchema,
        canvasId: canvasIdSchema
      })
      .strict(),
    task: z
      .object({
        taskId: taskIdSchema,
        title: nonEmptyStringSchema,
        status: z.enum(taskStatuses),
        executor: nonEmptyStringSchema.nullable(),
        promptMarkdown: z.string(),
        promptMissing: z.boolean(),
        acceptance: z.array(z.string())
      })
      .strict(),
    dependencyProgress: taskWorkspaceDependencyProgressSchema,
    blocks: z.array(taskWorkspaceBlockSchema),
    activeRecordIds: z.array(nonEmptyStringSchema.max(1_024)),
    selectedRecordId: nonEmptyStringSchema.max(1_024).nullable(),
    latestArtifact: taskWorkspaceLatestArtifactSchema.nullable(),
    duration: z
      .object({
        wallClock: taskWorkspaceWallClockSchema,
        agentTime: taskWorkspaceAgentTimeSchema
      })
      .strict(),
    usage: z
      .object({
        taskTokens: taskWorkspaceUnavailableTokenAccountingSchema,
        taskCost: taskWorkspaceCostAccountingSchema
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    const runItems = value.blocks.flatMap((block) => block.runs);
    // Header responses may omit runs (loaded via listTaskWorkspaceRuns). When runs
    // are present (client-composed or tests), selection/active must stay consistent.
    if (runItems.length === 0) {
      const activeRecordIds = new Set(value.activeRecordIds);
      if (activeRecordIds.size !== value.activeRecordIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeRecordIds"],
          message: "Active record ids must not contain duplicates."
        });
      }
      return;
    }
    const recordIds = new Set(runItems.map((item) => item.run.record.recordId));
    const selectedItems = runItems.filter((item) => item.selected);
    if (
      value.selectedRecordId === null
        ? selectedItems.length !== 0
        : selectedItems.length !== 1 ||
          selectedItems[0]?.run.record.recordId !== value.selectedRecordId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedRecordId"],
        message: "Selected record id must identify exactly one selected Task Workspace run."
      });
    }
    const activeItems = runItems.filter((item) => item.active);
    const activeRecordIds = new Set(value.activeRecordIds);
    if (
      activeRecordIds.size !== value.activeRecordIds.length ||
      value.activeRecordIds.some((recordId) => !recordIds.has(recordId)) ||
      activeItems.length !== activeRecordIds.size ||
      activeItems.some((item) => !activeRecordIds.has(item.run.record.recordId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeRecordIds"],
        message: "Active record ids must exactly match active Task Workspace runs."
      });
    }
  });

export type TaskWorkspaceInput = z.infer<typeof taskWorkspaceInputSchema>;
export type TaskWorkspaceAnnotation = z.infer<typeof taskWorkspaceAnnotationSchema>;
export type TaskWorkspaceBlock = z.infer<typeof taskWorkspaceBlockSchema>;
export type TaskWorkspace = z.infer<typeof taskWorkspaceSchema>;

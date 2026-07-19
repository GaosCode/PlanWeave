import { z } from "zod";
import {
  desktopLayoutFileSchema,
  desktopLayoutNodeSchema
} from "../desktop/types/desktopLayoutSchema.js";
import { manifestBlockSchema, manifestNodeSchema, reviewBlockSchema } from "../schema/manifest.js";
import type { PlanGraphCommand, PlanGraphCommandDiagnostic } from "./commands.js";

const baseCommandShape = {
  baseGraphVersion: z.string().optional()
};

const reviewHookSchema = z
  .object({
    id: z.string(),
    type: z.literal("executable"),
    command: z.string(),
    args: z.array(z.string()),
    executionPolicy: z.literal("trusted-local")
  })
  .strict();

const manifestEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    type: z.literal("depends_on")
  })
  .strict();

const taskComponentSnapshotSchema = z
  .object({
    task: manifestNodeSchema,
    taskPromptMarkdown: z.string(),
    blockPromptMarkdown: z.array(
      z
        .object({
          blockId: z.string(),
          markdown: z.string()
        })
        .strict()
    ),
    insertIndex: z.number().int().nullable(),
    affectedTaskEdges: z.array(manifestEdgeSchema),
    layoutNode: desktopLayoutNodeSchema.nullable().optional()
  })
  .strict();

const blockComponentSnapshotSchema = z
  .object({
    taskId: z.string(),
    block: manifestBlockSchema,
    promptMarkdown: z.string(),
    insertIndex: z.number().int().nullable(),
    affectedDependsOn: z.array(
      z
        .object({
          blockRef: z.string(),
          dependsOn: z.array(z.string())
        })
        .strict()
    )
  })
  .strict();

const projectTaskRefSchema = z
  .object({
    canvasId: z.string(),
    taskId: z.string()
  })
  .strict();

const activeCanvasSelectionSchema = z
  .object({
    activeCanvasId: z
      .string()
      .refine((value) => value.trim().length > 0, "Active canvas id is required.")
  })
  .strict();

const updateLayoutCommandSchema = z
  .object({
    ...baseCommandShape,
    type: z.literal("updateLayout"),
    layoutScope: z.enum(["desktop", "canvas"]),
    layout: z.unknown()
  })
  .strict()
  .superRefine((command, context) => {
    const result = (
      command.layoutScope === "desktop" ? desktopLayoutFileSchema : activeCanvasSelectionSchema
    ).safeParse(command.layout);
    if (result.success) {
      return;
    }
    for (const issue of result.error.issues) {
      context.addIssue({
        ...issue,
        path: ["layout", ...issue.path]
      });
    }
  });

const blockFieldEditSchema = z
  .object({
    title: z.string().optional(),
    promptMarkdown: z.string().optional(),
    executor: z.string().nullable().optional(),
    dependsOn: z.array(z.string()).optional(),
    sharedResources: z.array(z.string()).optional(),
    reviewRequired: z.boolean().optional(),
    maxFeedbackCycles: z.number().int().nonnegative().optional(),
    reviewHook: reviewHookSchema.nullable().optional(),
    basePromptHash: z.string().optional()
  })
  .strict();

const bulkBlockFieldEditSchema = blockFieldEditSchema.omit({ basePromptHash: true });

/** Shared canvas execution policy field shape (PlanGraph bulk update + desktop IPC). */
export const canvasExecutionPolicyFieldEditSchema = z
  .object({
    defaultExecutor: z.string().nullable().optional(),
    parallelEnabled: z.boolean().optional(),
    maxConcurrent: z.number().int().positive().optional()
  })
  .strict();

/** Alias for desktop bridge transport parsing of updateCanvasExecutionPolicy. */
export const canvasExecutionPolicyInputSchema = canvasExecutionPolicyFieldEditSchema;

const planGraphCommandSchemaOptions = [
  z
    .object({
      ...baseCommandShape,
      type: z.literal("addTaskDependency"),
      fromTaskId: z.string(),
      toTaskId: z.string()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("removeTaskDependency"),
      fromTaskId: z.string(),
      toTaskId: z.string()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("reconnectTaskDependency"),
      fromTaskId: z.string(),
      oldToTaskId: z.string(),
      newFromTaskId: z.string().optional(),
      newToTaskId: z.string()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("updateTaskPrompt"),
      taskId: z.string(),
      promptMarkdown: z.string(),
      basePromptHash: z.string().optional()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("updateBlockPrompt"),
      blockRef: z.string(),
      promptMarkdown: z.string(),
      basePromptHash: z.string().optional()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("updateTaskFields"),
      taskId: z.string(),
      fields: z
        .object({
          title: z.string().optional(),
          promptMarkdown: z.string().optional(),
          executor: z.string().nullable().optional(),
          acceptance: z.array(z.string()).optional(),
          basePromptHash: z.string().optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("updateBlockFields"),
      blockRef: z.string(),
      fields: blockFieldEditSchema
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("bulkUpdateBlocks"),
      updates: z
        .array(
          z
            .object({
              blockRef: z.string(),
              fields: bulkBlockFieldEditSchema
            })
            .strict()
        )
        .min(1)
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("bulkUpdateParallelPolicy"),
      canvasPolicy: canvasExecutionPolicyFieldEditSchema.optional(),
      blocks: z.array(
        z
          .object({
            blockRef: z.string(),
            input: z
              .object({
                sharedResources: z.array(z.string()).optional()
              })
              .strict()
          })
          .strict()
      )
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("addTask"),
      snapshot: taskComponentSnapshotSchema
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("removeTask"),
      taskId: z.string(),
      layoutNode: desktopLayoutNodeSchema.nullable().optional()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("restoreTask"),
      snapshot: taskComponentSnapshotSchema
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("addBlock"),
      snapshot: blockComponentSnapshotSchema
    })
    .strict(),
  z.object({ ...baseCommandShape, type: z.literal("removeBlock"), blockRef: z.string() }).strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("restoreBlock"),
      snapshot: blockComponentSnapshotSchema
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("updateReviewPipeline"),
      taskId: z.string(),
      packageDefaults: z
        .object({
          maxFeedbackCycles: z.number().int().nonnegative(),
          completionPolicy: z.literal("strict")
        })
        .strict(),
      reviewBlocks: z.array(reviewBlockSchema),
      promptMarkdownByBlockId: z.array(
        z.object({ blockId: z.string(), markdown: z.string() }).strict()
      )
    })
    .strict(),
  updateLayoutCommandSchema,
  z
    .object({
      ...baseCommandShape,
      type: z.literal("addCanvasDependency"),
      fromCanvasId: z.string(),
      toCanvasId: z.string()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("removeCanvasDependency"),
      fromCanvasId: z.string(),
      toCanvasId: z.string()
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("addCrossTaskDependency"),
      from: projectTaskRefSchema,
      to: projectTaskRefSchema
    })
    .strict(),
  z
    .object({
      ...baseCommandShape,
      type: z.literal("removeCrossTaskDependency"),
      from: projectTaskRefSchema,
      to: projectTaskRefSchema
    })
    .strict()
] as const;

type PlanGraphCommandSchemaType = z.output<(typeof planGraphCommandSchemaOptions)[number]>["type"];
type MissingPlanGraphCommandSchemaType = Exclude<
  PlanGraphCommand["type"],
  PlanGraphCommandSchemaType
>;
type ExtraPlanGraphCommandSchemaType = Exclude<
  PlanGraphCommandSchemaType,
  PlanGraphCommand["type"]
>;
const planGraphCommandSchemaTypeCoverage: Record<
  MissingPlanGraphCommandSchemaType | ExtraPlanGraphCommandSchemaType,
  never
> = {};

export const planGraphCommandSchema = z.discriminatedUnion("type", planGraphCommandSchemaOptions);

const planGraphCommandArrayOrSingleSchema = z.union([
  planGraphCommandSchema,
  z.array(planGraphCommandSchema).min(1)
]);

export class PlanGraphOperationLogParseError extends Error {
  readonly operationId: number;
  readonly fieldName: "command_json" | "inverse_json";
  readonly issueSummary: string;

  constructor(options: {
    operationId: number;
    fieldName: "command_json" | "inverse_json";
    issueSummary: string;
  }) {
    super(
      `Invalid operation_log ${options.fieldName} for operation ${options.operationId}: ${options.issueSummary}`
    );
    this.name = "PlanGraphOperationLogParseError";
    this.operationId = options.operationId;
    this.fieldName = options.fieldName;
    this.issueSummary = options.issueSummary;
  }
}

export function parsePlanGraphCommand(value: unknown): PlanGraphCommand {
  return planGraphCommandSchema.parse(value);
}

export function parsePlanGraphCommandArrayOrSingle(
  value: unknown
): PlanGraphCommand | PlanGraphCommand[] {
  return planGraphCommandArrayOrSingleSchema.parse(value);
}

export function planGraphCommandParseDiagnostic(
  error: unknown,
  path: string
): PlanGraphCommandDiagnostic {
  return {
    code: "history_command_invalid",
    message: `Invalid PlanGraph command history at ${path}: ${planGraphCommandIssueSummary(error)}.`,
    path
  };
}

export function planGraphCommandIssueSummary(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 3)
      .map(
        (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`
      )
      .join("; ");
  }
  return error instanceof Error ? error.message : "Unknown parse error";
}

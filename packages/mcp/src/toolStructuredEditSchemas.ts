import type {
  BlockType,
  DesktopUpdateReviewPipelineInput,
  ProjectTaskRef,
  ReviewHookDefinition
} from "@planweave-ai/runtime";
import * as z from "zod/v4";
import {
  blockRefInputShape,
  blockTypeSchema,
  blockTypesSchema,
  hasBlockTarget,
  hasUpdateField,
  optionalNullableTrimmedStringSchema,
  optionalReviewHookSchema,
  optionalStringArraySchema,
  packageDefaultsInputSchema,
  projectCanvasInputShape,
  requiredStringArraySchema,
  requiredTrimmedStringSchema,
  resolveBlockRef,
  reviewHookSchema,
  reviewPipelineStepInputSchema,
  updateFieldSchema
} from "./toolInputSchemas.js";

export { reviewHookSchema };

const optionalBooleanSchema = z.boolean().optional();
const optionalNonNegativeIntegerSchema = z.number().int().nonnegative().optional();
const optionalPositiveIntegerSchema = z.number().int().positive().optional();
const optionalMarkdownSchema = z.string().optional();

const blockTargetShape = {
  blockRef: blockRefInputShape.blockRef,
  taskId: blockRefInputShape.taskId,
  blockId: blockRefInputShape.blockId
} satisfies z.core.$ZodLooseShape;

function withResolvedBlockRef<T extends { blockRef?: string; taskId?: string; blockId?: string }>(
  schema: z.ZodType<T>
) {
  return schema.refine(hasBlockTarget, {
    message: "blockRef is required unless taskId and blockId are provided."
  });
}

function hasPlanningField(input: {
  sharedResources?: string[];
  reviewRequired?: boolean;
  maxFeedbackCycles?: number;
  reviewHook?: ReviewHookDefinition | null;
}): boolean {
  return (
    input.sharedResources !== undefined ||
    input.reviewRequired !== undefined ||
    input.maxFeedbackCycles !== undefined ||
    input.reviewHook !== undefined
  );
}

function hasExecutionPolicyField(input: {
  defaultExecutor?: string | null;
  parallelEnabled?: boolean;
  maxConcurrent?: number;
}): boolean {
  return (
    input.defaultExecutor !== undefined ||
    input.parallelEnabled !== undefined ||
    input.maxConcurrent !== undefined
  );
}

// --- Nested DTO schemas advertised by MCP tool contracts ---

export const createBlockFieldsShape = {
  taskId: requiredTrimmedStringSchema,
  type: blockTypeSchema,
  title: requiredTrimmedStringSchema,
  promptMarkdown: z.string(),
  executor: optionalNullableTrimmedStringSchema,
  dependsOn: optionalStringArraySchema
} satisfies z.core.$ZodLooseShape;

export const createBlockFieldsSchema = z.object(createBlockFieldsShape);

export const taskAcceptanceFieldsShape = {
  acceptance: requiredStringArraySchema.min(1, {
    message: "acceptance must include at least one item."
  })
} satisfies z.core.$ZodLooseShape;

export const taskAcceptanceFieldsSchema = z.object(taskAcceptanceFieldsShape);

export const blockDependenciesFieldsShape = {
  dependsOn: requiredStringArraySchema
} satisfies z.core.$ZodLooseShape;

export const blockDependenciesFieldsSchema = z.object(blockDependenciesFieldsShape);

export const blockPlanningFieldsShape = {
  sharedResources: optionalStringArraySchema,
  reviewRequired: optionalBooleanSchema,
  maxFeedbackCycles: optionalNonNegativeIntegerSchema,
  reviewHook: optionalReviewHookSchema
} satisfies z.core.$ZodLooseShape;

export const blockPlanningFieldsSchema = z
  .object(blockPlanningFieldsShape)
  .refine(hasPlanningField, {
    message: "At least one block planning field must be provided."
  });

export const canvasExecutionPolicyFieldsShape = {
  defaultExecutor: optionalNullableTrimmedStringSchema,
  parallelEnabled: optionalBooleanSchema,
  maxConcurrent: optionalPositiveIntegerSchema
} satisfies z.core.$ZodLooseShape;

export const canvasExecutionPolicyFieldsSchema = z
  .object(canvasExecutionPolicyFieldsShape)
  .refine(hasExecutionPolicyField, {
    message: "At least one execution policy field must be provided."
  });

export const projectTaskRefsShape = {
  fromCanvasId: requiredTrimmedStringSchema,
  fromTaskId: requiredTrimmedStringSchema,
  toCanvasId: requiredTrimmedStringSchema,
  toTaskId: requiredTrimmedStringSchema
} satisfies z.core.$ZodLooseShape;

export const projectTaskRefsSchema = z.object(projectTaskRefsShape);

export const taskDependencyEdgeSchema = z.object({
  dependentTaskId: requiredTrimmedStringSchema,
  dependsOnTaskId: requiredTrimmedStringSchema
});

export const taskDependencyUpdateSchema = z.object({
  taskId: requiredTrimmedStringSchema,
  dependsOn: requiredStringArraySchema
});

export const blockDependencyRefSchema = z
  .object({
    ...blockTargetShape,
    dependsOnBlockId: requiredTrimmedStringSchema
  })
  .refine(hasBlockTarget, {
    message: "blockRef is required unless taskId and blockId are provided."
  });

export const blockDependencyUpdateSchema = z
  .object({
    ...blockTargetShape,
    dependsOn: requiredStringArraySchema
  })
  .refine(hasBlockTarget, {
    message: "blockRef is required unless taskId and blockId are provided."
  });

export const bulkCreateTaskSchema = z.object({
  title: requiredTrimmedStringSchema,
  promptMarkdown: z.string(),
  acceptance: optionalStringArraySchema,
  blockTypes: blockTypesSchema,
  executor: optionalNullableTrimmedStringSchema
});

export const bulkCreateBlockSchema = createBlockFieldsSchema;

export const bulkUpdateTaskSchema = z
  .object({
    taskId: requiredTrimmedStringSchema,
    title: updateFieldSchema,
    promptMarkdown: optionalMarkdownSchema,
    executor: optionalNullableTrimmedStringSchema,
    acceptance: optionalStringArraySchema
  })
  .refine((input) => hasUpdateField(input) || input.acceptance !== undefined, {
    message: "At least one task field must be provided."
  });

export const bulkUpdateBlockSchema = z
  .strictObject({
    ...blockTargetShape,
    title: updateFieldSchema,
    promptMarkdown: optionalMarkdownSchema,
    executor: optionalNullableTrimmedStringSchema,
    dependsOn: optionalStringArraySchema,
    sharedResources: optionalStringArraySchema,
    reviewRequired: optionalBooleanSchema,
    maxFeedbackCycles: optionalNonNegativeIntegerSchema,
    reviewHook: optionalReviewHookSchema
  })
  .refine(hasBlockTarget, {
    message: "blockRef is required unless taskId and blockId are provided."
  })
  .refine(
    (input) => hasUpdateField(input) || input.dependsOn !== undefined || hasPlanningField(input),
    {
      message: "At least one block field must be provided."
    }
  );

export const reviewPipelineBulkUpdateSchema = z.object({
  taskId: requiredTrimmedStringSchema,
  packageDefaults: packageDefaultsInputSchema.optional(),
  steps: z.array(reviewPipelineStepInputSchema)
});

export const parallelBlockPolicySchema = z
  .strictObject({
    ...blockTargetShape,
    sharedResources: optionalStringArraySchema
  })
  .refine(hasBlockTarget, {
    message: "blockRef is required unless taskId and blockId are provided."
  })
  .refine((input) => input.sharedResources !== undefined, {
    message: "At least one block planning field must be provided."
  });

export const removeBlockRefSchema = z.union([
  requiredTrimmedStringSchema,
  withResolvedBlockRef(z.object(blockTargetShape))
]);

const bulkRemoveGraphItemsFieldsSchema = z
  .object({
    tasks: optionalStringArraySchema,
    blocks: z.array(removeBlockRefSchema).optional(),
    taskDependencyEdges: z.array(taskDependencyEdgeSchema).optional(),
    blockDependencyRefs: z.array(blockDependencyRefSchema).optional()
  })
  .superRefine((input, context) => {
    const tasks = input.tasks ?? [];
    const blocks = input.blocks ?? [];
    const taskDependencyEdges = input.taskDependencyEdges ?? [];
    const blockDependencyRefs = input.blockDependencyRefs ?? [];
    if (
      tasks.length === 0 &&
      blocks.length === 0 &&
      taskDependencyEdges.length === 0 &&
      blockDependencyRefs.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "bulk_remove_graph_items requires at least one item to remove."
      });
    }
  });

const bulkParallelPolicyFieldsSchema = z
  .object({
    canvasPolicy: z.object(canvasExecutionPolicyFieldsShape).optional(),
    blocks: z.array(parallelBlockPolicySchema).optional()
  })
  .superRefine((input, context) => {
    if (input.canvasPolicy !== undefined) {
      if (!hasExecutionPolicyField(input.canvasPolicy)) {
        context.addIssue({
          code: "custom",
          message: "At least one execution policy field must be provided.",
          path: ["canvasPolicy"]
        });
      }
    }
    const blocks = input.blocks ?? [];
    if (input.canvasPolicy === undefined && blocks.length === 0) {
      context.addIssue({
        code: "custom",
        message: "bulk_update_parallel_policy requires canvasPolicy or at least one block update."
      });
    }
  });

// --- Advertised input shapes for full tools (where useful) ---

export const createBlockInputShape = {
  ...projectCanvasInputShape,
  ...createBlockFieldsShape
} satisfies z.core.$ZodLooseShape;

export const updateTaskAcceptanceInputShape = {
  ...projectCanvasInputShape,
  taskId: requiredTrimmedStringSchema,
  ...taskAcceptanceFieldsShape
} satisfies z.core.$ZodLooseShape;

export const updateBlockDependenciesInputShape = {
  ...projectCanvasInputShape,
  ...blockTargetShape,
  ...blockDependenciesFieldsShape
} satisfies z.core.$ZodLooseShape;

export const updateCanvasExecutionPolicyInputShape = {
  ...projectCanvasInputShape,
  ...canvasExecutionPolicyFieldsShape
} satisfies z.core.$ZodLooseShape;

export const updateBlockPlanningInputShape = {
  ...projectCanvasInputShape,
  ...blockTargetShape,
  ...blockPlanningFieldsShape
} satisfies z.core.$ZodLooseShape;

export const projectTaskRefsInputShape = {
  projectId: requiredTrimmedStringSchema,
  ...projectTaskRefsShape
} satisfies z.core.$ZodLooseShape;

// --- Parsed gateway-facing types ---

export type ParsedCreateBlockInput = {
  taskId: string;
  type: BlockType;
  title: string;
  promptMarkdown: string;
  executor?: string | null;
  dependsOn?: string[];
};

export type ParsedBlockPlanningInput = {
  sharedResources?: string[];
  reviewRequired?: boolean;
  maxFeedbackCycles?: number;
  reviewHook?: ReviewHookDefinition | null;
};

export type ParsedCanvasExecutionPolicyInput = {
  defaultExecutor?: string | null;
  parallelEnabled?: boolean;
  maxConcurrent?: number;
};

export type ParsedBulkUpdateTask = {
  taskId: string;
  input: {
    title?: string;
    promptMarkdown?: string;
    executor?: string | null;
    acceptance?: string[];
  };
};

export type ParsedBulkUpdateBlock = {
  blockRef: string;
  input: {
    title?: string;
    promptMarkdown?: string;
    executor?: string | null;
    dependsOn?: string[];
    sharedResources?: string[];
    reviewRequired?: boolean;
    maxFeedbackCycles?: number;
    reviewHook?: ReviewHookDefinition | null;
  };
};

export type ParsedBulkRemoveGraphItems = {
  tasks: string[];
  blocks: string[];
  taskDependencyEdges: Array<{ dependentTaskId: string; dependsOnTaskId: string }>;
  blockDependencyRefs: Array<{ blockRef: string; dependsOnBlockId: string }>;
};

export type ParsedBulkParallelPolicyInput = {
  canvasPolicy: ParsedCanvasExecutionPolicyInput | undefined;
  blocks: Array<{ blockRef: string; input: { sharedResources?: string[] } }>;
};

export type ParsedReviewPipelineBulkUpdate = {
  taskId: string;
  input: DesktopUpdateReviewPipelineInput;
};

// --- Parsers ---

export function parseCreateBlockInput(record: Record<string, unknown>): ParsedCreateBlockInput {
  return createBlockFieldsSchema.parse(record);
}

export function parseTaskAcceptanceInput(record: Record<string, unknown>): string[] {
  return taskAcceptanceFieldsSchema.parse(record).acceptance;
}

export function parseBlockDependenciesInput(record: Record<string, unknown>): string[] {
  return blockDependenciesFieldsSchema.parse(record).dependsOn;
}

export function parseBlockPlanningInput(record: Record<string, unknown>): ParsedBlockPlanningInput {
  const parsed = blockPlanningFieldsSchema.parse(record);
  return {
    sharedResources: parsed.sharedResources,
    reviewRequired: parsed.reviewRequired,
    maxFeedbackCycles: parsed.maxFeedbackCycles,
    reviewHook: parsed.reviewHook
  };
}

export function parseCanvasExecutionPolicyInput(
  record: Record<string, unknown>
): ParsedCanvasExecutionPolicyInput {
  const parsed = canvasExecutionPolicyFieldsSchema.parse(record);
  return {
    defaultExecutor: parsed.defaultExecutor,
    parallelEnabled: parsed.parallelEnabled,
    maxConcurrent: parsed.maxConcurrent
  };
}

export function parseProjectTaskRefs(record: Record<string, unknown>): {
  from: ProjectTaskRef;
  to: ProjectTaskRef;
} {
  const parsed = projectTaskRefsSchema.parse(record);
  return {
    from: { canvasId: parsed.fromCanvasId, taskId: parsed.fromTaskId },
    to: { canvasId: parsed.toCanvasId, taskId: parsed.toTaskId }
  };
}

export function parseTaskDependencyEdges(
  value: unknown
): Array<{ dependentTaskId: string; dependsOnTaskId: string }> {
  return z
    .array(taskDependencyEdgeSchema)
    .min(1, { message: "edges must contain at least one dependency." })
    .parse(value);
}

export function parseTaskDependencyUpdates(
  value: unknown
): Array<{ taskId: string; dependsOn: string[] }> {
  return z
    .array(taskDependencyUpdateSchema)
    .min(1, { message: "updates must contain at least one task dependency update." })
    .parse(value);
}

export function parseBlockDependencyUpdates(
  value: unknown
): Array<{ blockRef: string; dependsOn: string[] }> {
  const updates = z
    .array(blockDependencyUpdateSchema)
    .min(1, { message: "updates must contain at least one block dependency update." })
    .parse(value);
  return updates.map((update) => ({
    blockRef: resolveBlockRef(update),
    dependsOn: update.dependsOn
  }));
}

export function parseBulkCreateTasks(record: Record<string, unknown>): Array<{
  title: string;
  promptMarkdown: string;
  acceptance?: string[];
  blockTypes?: BlockType[];
  executor?: string | null;
}> {
  return z
    .object({
      tasks: z.array(bulkCreateTaskSchema).min(1, {
        message: "tasks must contain at least one item."
      })
    })
    .parse(record).tasks;
}

export function parseBulkCreateBlocks(record: Record<string, unknown>): ParsedCreateBlockInput[] {
  return z
    .object({
      blocks: z.array(bulkCreateBlockSchema).min(1, {
        message: "blocks must contain at least one item."
      })
    })
    .parse(record).blocks;
}

export function parseBulkUpdateTasks(record: Record<string, unknown>): ParsedBulkUpdateTask[] {
  const updates = z
    .object({
      updates: z.array(bulkUpdateTaskSchema).min(1, {
        message: "updates must contain at least one item."
      })
    })
    .parse(record).updates;
  return updates.map((update) => ({
    taskId: update.taskId,
    input: {
      title: update.title,
      promptMarkdown: update.promptMarkdown,
      executor: update.executor,
      acceptance: update.acceptance
    }
  }));
}

export function parseBulkUpdateBlocks(record: Record<string, unknown>): ParsedBulkUpdateBlock[] {
  const updates = z
    .object({
      updates: z.array(bulkUpdateBlockSchema).min(1, {
        message: "updates must contain at least one item."
      })
    })
    .parse(record).updates;
  return updates.map((update) => ({
    blockRef: resolveBlockRef(update),
    input: {
      title: update.title,
      promptMarkdown: update.promptMarkdown,
      executor: update.executor,
      dependsOn: update.dependsOn,
      sharedResources: update.sharedResources,
      reviewRequired: update.reviewRequired,
      maxFeedbackCycles: update.maxFeedbackCycles,
      reviewHook: update.reviewHook
    }
  }));
}

export function parseBulkRemoveGraphItems(
  record: Record<string, unknown>
): ParsedBulkRemoveGraphItems {
  const parsed = bulkRemoveGraphItemsFieldsSchema.parse(record);
  return {
    tasks: parsed.tasks ?? [],
    blocks: (parsed.blocks ?? []).map((block) =>
      typeof block === "string" ? block : resolveBlockRef(block)
    ),
    taskDependencyEdges: parsed.taskDependencyEdges ?? [],
    blockDependencyRefs: (parsed.blockDependencyRefs ?? []).map((item) => ({
      blockRef: resolveBlockRef(item),
      dependsOnBlockId: item.dependsOnBlockId
    }))
  };
}

export function parseBulkReviewPipelineUpdates(
  record: Record<string, unknown>
): ParsedReviewPipelineBulkUpdate[] {
  const updates = z
    .object({
      updates: z.array(reviewPipelineBulkUpdateSchema).min(1, {
        message: "updates must contain at least one review pipeline update."
      })
    })
    .superRefine((value, context) => {
      const seenTaskIds = new Set<string>();
      for (const [index, update] of value.updates.entries()) {
        if (seenTaskIds.has(update.taskId)) {
          context.addIssue({
            code: "custom",
            message: `updates must not contain duplicate taskId: ${update.taskId}`,
            path: ["updates", index, "taskId"]
          });
          continue;
        }
        seenTaskIds.add(update.taskId);
      }
    })
    .parse(record).updates;

  return updates.map((update) => ({
    taskId: update.taskId,
    input: {
      packageDefaults: update.packageDefaults,
      steps: update.steps
    }
  }));
}

export function parseBulkParallelPolicyInput(
  record: Record<string, unknown>
): ParsedBulkParallelPolicyInput {
  const parsed = bulkParallelPolicyFieldsSchema.parse(record);
  return {
    canvasPolicy:
      parsed.canvasPolicy === undefined
        ? undefined
        : {
            defaultExecutor: parsed.canvasPolicy.defaultExecutor,
            parallelEnabled: parsed.canvasPolicy.parallelEnabled,
            maxConcurrent: parsed.canvasPolicy.maxConcurrent
          },
    blocks: (parsed.blocks ?? []).map((block) => ({
      blockRef: resolveBlockRef(block),
      input: { sharedResources: block.sharedResources }
    }))
  };
}

export function parseRequiredStringArray(value: unknown, field: string): string[] {
  return z
    .array(requiredTrimmedStringSchema, {
      error: () => ({ message: `${field} must be an array of strings.` })
    })
    .parse(value);
}

export function parseOptionalPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = z
    .number({ error: () => ({ message: `${field} must be a finite number.` }) })
    .finite({ message: `${field} must be a finite number.` })
    .parse(value);
  if (parsed <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return parsed;
}

export function parseOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return z
    .number({ error: () => ({ message: `${field} must be a finite number.` }) })
    .finite({ message: `${field} must be a finite number.` })
    .parse(value);
}

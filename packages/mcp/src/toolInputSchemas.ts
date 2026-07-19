import type { BlockType, DesktopUpdateReviewPipelineInput } from "@planweave-ai/runtime";
import * as z from "zod/v4";

export const blockTypeSchema = z.enum(["implementation", "review"]);
const reviewTriggerConditionSchema = z.enum(["after_required_work_completed", "manual"]);

export const requiredTrimmedStringSchema = z.string().trim().min(1);
export const optionalTrimmedStringSchema = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? undefined : value),
  requiredTrimmedStringSchema.optional()
);
export const optionalNullableTrimmedStringSchema = z.preprocess(
  (value) => (value === undefined ? undefined : value === null || value === "" ? null : value),
  requiredTrimmedStringSchema.nullable().optional()
);
export const optionalStringArraySchema = z.preprocess(
  (value) => (value === undefined || value === null ? undefined : value),
  z.array(requiredTrimmedStringSchema).optional()
);
export const requiredStringArraySchema = z.array(requiredTrimmedStringSchema);

export const blockTypesSchema = z.preprocess(
  (value) => (value === undefined || value === null ? undefined : value),
  z.array(blockTypeSchema).optional()
);

export const updateFieldSchema = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? undefined : value),
  requiredTrimmedStringSchema.optional()
);

export const blockRefSchema = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? undefined : value),
  requiredTrimmedStringSchema.optional()
);

export const reviewHookSchema = z.object({
  id: requiredTrimmedStringSchema,
  type: z.literal("executable"),
  command: requiredTrimmedStringSchema,
  args: z.array(requiredTrimmedStringSchema).default([]),
  executionPolicy: z.literal("trusted-local")
});

export const optionalReviewHookSchema = z.preprocess(
  (value) => (value === undefined ? undefined : value),
  reviewHookSchema.nullable().optional()
);

export const projectCanvasInputShape = {
  projectId: requiredTrimmedStringSchema,
  canvasId: optionalTrimmedStringSchema
} satisfies z.core.$ZodLooseShape;

export const blockRefInputShape = {
  blockRef: blockRefSchema,
  taskId: blockRefSchema,
  blockId: blockRefSchema
} satisfies z.core.$ZodLooseShape;

export const createTaskInputShape = {
  ...projectCanvasInputShape,
  title: requiredTrimmedStringSchema,
  promptMarkdown: z.string(),
  acceptance: optionalStringArraySchema,
  blockTypes: blockTypesSchema,
  executor: optionalNullableTrimmedStringSchema
} satisfies z.core.$ZodLooseShape;

export const updateTaskInputShape = {
  ...projectCanvasInputShape,
  taskId: requiredTrimmedStringSchema,
  title: updateFieldSchema,
  promptMarkdown: z.string().optional(),
  executor: optionalNullableTrimmedStringSchema
} satisfies z.core.$ZodLooseShape;

export const updateBlockInputShape = {
  ...projectCanvasInputShape,
  ...blockRefInputShape,
  title: updateFieldSchema,
  promptMarkdown: z.string().optional(),
  executor: optionalNullableTrimmedStringSchema
} satisfies z.core.$ZodLooseShape;

export const packageDefaultsInputSchema = z.object({
  maxFeedbackCycles: z.number().int().nonnegative(),
  completionPolicy: z.literal("strict")
});

export const reviewPipelineStepInputSchema = z
  .object({
    blockRef: z.preprocess(
      (value) => (value === undefined || value === null || value === "" ? null : value),
      requiredTrimmedStringSchema.nullable()
    ),
    blockId: blockRefSchema,
    title: requiredTrimmedStringSchema,
    enabled: z.boolean().default(true),
    preset: requiredTrimmedStringSchema,
    triggerCondition: reviewTriggerConditionSchema.default("after_required_work_completed"),
    inputContext: requiredTrimmedStringSchema,
    passCriteria: requiredTrimmedStringSchema,
    feedbackFormat: requiredTrimmedStringSchema,
    maxFeedbackCycles: z.number().int().nonnegative().default(1),
    hook: optionalReviewHookSchema.transform((value) => value ?? null),
    promptMarkdown: z.string()
  })
  .superRefine((step, context) => {
    if (
      step.blockId === undefined &&
      step.blockRef !== null &&
      blockIdFromStepRef(step.blockRef) === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "blockRef must use '<taskId>#<blockId>'.",
        path: ["blockRef"]
      });
    }
  })
  .transform((step) => {
    const blockId = step.blockId ?? blockIdFromStepRef(step.blockRef);
    return { ...step, blockId: blockId ?? "" };
  });

export const updateReviewPipelineInputShape = {
  ...projectCanvasInputShape,
  taskId: requiredTrimmedStringSchema,
  packageDefaults: packageDefaultsInputSchema.optional(),
  steps: z.array(reviewPipelineStepInputSchema)
} satisfies z.core.$ZodLooseShape;

const createTaskInputSchema = z.object(createTaskInputShape);
const updateTaskInputSchema = z.object(updateTaskInputShape).refine(hasUpdateField, {
  message: "At least one of title, promptMarkdown, or executor must be provided."
});
const updateBlockInputSchema = z
  .object(updateBlockInputShape)
  .refine(hasBlockTarget, {
    message: "blockRef is required unless taskId and blockId are provided."
  })
  .refine(hasUpdateField, {
    message: "At least one of title, promptMarkdown, or executor must be provided."
  });
const updateReviewPipelineInputSchema = z.object(updateReviewPipelineInputShape);

export type ParsedCreateTaskToolArgs = {
  projectId: string;
  canvasId?: string;
  input: {
    title: string;
    promptMarkdown: string;
    acceptance?: string[];
    blockTypes?: BlockType[];
    executor?: string | null;
  };
};

export type ParsedUpdateTaskToolArgs = {
  projectId: string;
  canvasId?: string;
  taskId: string;
  input: { title?: string; promptMarkdown?: string; executor?: string | null };
};

export type ParsedUpdateBlockToolArgs = {
  projectId: string;
  canvasId?: string;
  blockRef: string;
  input: { title?: string; promptMarkdown?: string; executor?: string | null };
};

export type ParsedUpdateReviewPipelineToolArgs = {
  projectId: string;
  canvasId?: string;
  taskId: string;
  input: DesktopUpdateReviewPipelineInput;
};

export function parseCreateTaskToolArgs(record: Record<string, unknown>): ParsedCreateTaskToolArgs {
  const parsed = createTaskInputSchema.parse(record);
  return {
    projectId: parsed.projectId,
    canvasId: parsed.canvasId,
    input: {
      title: parsed.title,
      promptMarkdown: parsed.promptMarkdown,
      acceptance: parsed.acceptance,
      blockTypes: parsed.blockTypes,
      executor: parsed.executor
    }
  };
}

export function parseUpdateTaskToolArgs(record: Record<string, unknown>): ParsedUpdateTaskToolArgs {
  const parsed = updateTaskInputSchema.parse(record);
  return {
    projectId: parsed.projectId,
    canvasId: parsed.canvasId,
    taskId: parsed.taskId,
    input: updateFields(parsed)
  };
}

export function parseUpdateBlockToolArgs(
  record: Record<string, unknown>
): ParsedUpdateBlockToolArgs {
  const parsed = updateBlockInputSchema.parse(record);
  return {
    projectId: parsed.projectId,
    canvasId: parsed.canvasId,
    blockRef: resolveBlockRef(parsed),
    input: updateFields(parsed)
  };
}

export function parseUpdateReviewPipelineToolArgs(
  record: Record<string, unknown>
): ParsedUpdateReviewPipelineToolArgs {
  const parsed = updateReviewPipelineInputSchema.parse(record);
  return {
    projectId: parsed.projectId,
    canvasId: parsed.canvasId,
    taskId: parsed.taskId,
    input: {
      packageDefaults: parsed.packageDefaults,
      steps: parsed.steps
    }
  };
}

export function hasUpdateField(input: {
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
}): boolean {
  return (
    input.title !== undefined || input.promptMarkdown !== undefined || input.executor !== undefined
  );
}

export function hasBlockTarget(input: {
  blockRef?: string;
  taskId?: string;
  blockId?: string;
}): boolean {
  return (
    input.blockRef !== undefined || (input.taskId !== undefined && input.blockId !== undefined)
  );
}

export function resolveBlockRef(input: {
  blockRef?: string;
  taskId?: string;
  blockId?: string;
}): string {
  return input.blockRef ?? `${input.taskId}#${input.blockId}`;
}

function updateFields(input: {
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
}) {
  return {
    title: input.title,
    promptMarkdown: input.promptMarkdown,
    executor: input.executor
  };
}

export function blockIdFromStepRef(blockRef: string | null): string | undefined {
  if (blockRef === null) {
    return undefined;
  }
  const separator = blockRef.indexOf("#");
  if (separator <= 0 || separator === blockRef.length - 1) {
    return undefined;
  }
  return blockRef.slice(separator + 1);
}

import * as z from "zod/v4";
import {
  createTaskInputShape,
  updateBlockInputShape,
  updateReviewPipelineInputShape,
  updateTaskInputShape
} from "../toolInputSchemas.js";
import {
  blockDependencyRefSchema,
  blockDependencyUpdateSchema,
  bulkCreateBlockSchema,
  bulkCreateTaskSchema,
  bulkUpdateBlockSchema,
  bulkUpdateTaskSchema,
  parallelBlockPolicySchema,
  reviewHookSchema,
  reviewPipelineBulkUpdateSchema,
  taskDependencyEdgeSchema,
  taskDependencyUpdateSchema
} from "../toolStructuredEditSchemas.js";

export const blockTypeSchema = z.enum(["implementation", "review"]);
export const graphReviewPolicySchema = z.enum(["none", "risk-based", "required"]);
export const graphGatePolicySchema = z.enum(["none", "required"]);
export const graphHeuristicsSchema = z.enum(["on", "off"]);
export const searchResultKindSchema = z.enum([
  "task",
  "block",
  "prompt",
  "run_record",
  "review_attempt",
  "feedback"
]);

export {
  blockDependencyRefSchema,
  blockDependencyUpdateSchema,
  bulkCreateBlockSchema,
  bulkCreateTaskSchema,
  bulkUpdateBlockSchema,
  bulkUpdateTaskSchema,
  parallelBlockPolicySchema,
  reviewHookSchema,
  reviewPipelineBulkUpdateSchema,
  taskDependencyEdgeSchema,
  taskDependencyUpdateSchema
};

export const packageFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal("utf8").optional()
});

export const projectInput = {
  projectId: z.string().min(1)
};

export const projectCanvasInput = {
  ...projectInput,
  canvasId: z.string().min(1).optional()
};

export const optionalProjectCanvasInput = {
  ...projectInput,
  canvasId: z.string().min(1).nullable().optional()
};

export const blockRefInput = {
  blockRef: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional()
};

export const taskPromptInput = {
  ...projectCanvasInput,
  taskId: z.string().min(1),
  markdown: z.string()
};

export const blockPromptInput = {
  ...projectCanvasInput,
  ...blockRefInput,
  markdown: z.string()
};

export const semanticTaskDependencyInput = {
  ...projectCanvasInput,
  dependentTaskId: z.string().min(1),
  dependsOnTaskId: z.string().min(1)
};

export const graphReadInput = {
  ...projectCanvasInput,
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).optional()
};

export const graphSliceInput = {
  ...projectCanvasInput,
  taskId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional()
};

export const promptSourceInput = {
  ...projectCanvasInput,
  target: z.enum(["project", "task", "block"]),
  taskId: z.string().min(1).optional(),
  blockRef: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().optional()
};

export const promptSourceWriteInput = {
  ...projectCanvasInput,
  target: z.enum(["project", "task", "block"]),
  taskId: z.string().min(1).optional(),
  blockRef: z.string().min(1).optional(),
  markdown: z.string()
};

export {
  createTaskInputShape,
  updateBlockInputShape,
  updateReviewPipelineInputShape,
  updateTaskInputShape
};

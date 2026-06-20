import * as z from "zod/v4";
import type { PlanweaveToolName } from "./tools.js";

const blockTypes = ["implementation", "review"] as const;
const blockStatuses = ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"] as const;
const edgeTypes = ["depends_on"] as const;
const reviewTriggerConditions = ["after_required_work_completed", "manual"] as const;
const taskStatuses = ["planned", "ready", "in_progress", "implemented"] as const;

const validationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional()
}).passthrough();

const taskCanvasSummarySchema = z.object({
  canvasId: z.string(),
  name: z.string(),
  taskCount: z.number(),
  missingPromptCount: z.number(),
  diagnostics: z.array(validationIssueSchema),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough();

const sanitizedProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  activeCanvasId: z.string().nullable(),
  taskCanvases: z.array(taskCanvasSummarySchema)
}).passthrough();

const reviewGateHintSchema = z.object({
  isGate: z.literal(true),
  required: z.boolean(),
  requiredReason: z.string(),
  executorRole: z.literal("reviewer"),
  downstreamTasks: z.array(z.string()),
  unlocksTasks: z.array(z.string()),
  needsChangesReturnsTo: z.array(z.string())
}).passthrough();

const blockPreviewSchema = z.object({
  ref: z.string(),
  blockId: z.string(),
  type: z.enum(blockTypes),
  title: z.string(),
  status: z.enum(blockStatuses),
  executor: z.string().nullable(),
  promptMissing: z.boolean(),
  exceptionReason: z.string().nullable()
}).passthrough();

const graphSchema = z.object({
  projectId: z.string(),
  projectTitle: z.string(),
  executorOptions: z.array(z.string()),
  tasks: z.array(z.object({
    taskId: z.string(),
    title: z.string(),
    status: z.enum(taskStatuses),
    executor: z.string().nullable(),
    executorLabel: z.string(),
    promptMarkdown: z.string(),
    promptMissing: z.boolean(),
    promptPreview: z.string(),
    blocks: z.array(blockPreviewSchema),
    blockPreview: z.array(blockPreviewSchema),
    hiddenBlockRefs: z.array(z.string()),
    overflowBlockCount: z.number(),
    exceptions: z.array(z.object({
      ref: z.string(),
      reason: z.string(),
      source: z.enum(["blocked", "diverged", "feedback", "needs_changes"])
    }).passthrough())
  }).passthrough()),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    type: z.enum(edgeTypes)
  }).passthrough()),
  diagnostics: z.array(validationIssueSchema),
  dirtyPromptRefs: z.array(z.string())
}).passthrough();

const taskDetailSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.enum(taskStatuses),
  executor: z.string().nullable(),
  promptMarkdown: z.string(),
  promptMissing: z.boolean(),
  acceptance: z.array(z.string()),
  blockOrder: z.array(z.string())
}).passthrough();

const promptSourceSchema = z.object({
  kind: z.enum(["global", "projectCanvas", "projectGraph", "taskNode", "block"]),
  label: z.string(),
  included: z.boolean(),
  empty: z.boolean(),
  missing: z.boolean(),
  disabledReason: z.string().nullable(),
  preview: z.string()
}).passthrough();

const blockDetailSchema = z.object({
  ref: z.string(),
  taskId: z.string(),
  blockId: z.string(),
  type: z.enum(blockTypes),
  title: z.string(),
  status: z.enum(blockStatuses),
  executor: z.string().nullable(),
  effectiveExecutor: z.string().nullable(),
  promptMarkdown: z.string(),
  promptMissing: z.boolean(),
  promptSurfaceMarkdown: z.string(),
  promptSources: z.array(promptSourceSchema),
  dependencies: z.array(z.string()),
  latestRunId: z.string().nullable(),
  latestReviewAttemptId: z.string().nullable(),
  activeFeedbackId: z.string().nullable(),
  exceptionReason: z.string().nullable(),
  reviewGate: reviewGateHintSchema.nullable()
}).passthrough();

const reviewPipelineSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  packageDefaults: z.object({
    maxFeedbackCycles: z.number(),
    completionPolicy: z.literal("strict")
  }).passthrough(),
  steps: z.array(z.object({
    blockRef: z.string(),
    blockId: z.string(),
    title: z.string(),
    enabled: z.boolean(),
    preset: z.string(),
    triggerCondition: z.enum(reviewTriggerConditions),
    inputContext: z.string(),
    passCriteria: z.string(),
    feedbackFormat: z.string(),
    maxFeedbackCycles: z.number(),
    hook: z.unknown().nullable(),
    promptMarkdown: z.string()
  }).passthrough())
}).passthrough();

const schemaDocumentSchema = z.object({
  name: z.string(),
  summary: z.string(),
  path: z.string(),
  ownership: z.string(),
  validation: z.array(z.string()),
  schema: z.unknown(),
  notes: z.array(z.string())
}).passthrough();

export const planweaveToolOutputSchemas = {
  get_schema: {
    topic: z.enum(["manifest", "project"]).nullable(),
    documents: z.record(z.string(), schemaDocumentSchema)
  },
  list_projects: {
    projects: z.array(sanitizedProjectSchema)
  },
  open_project: {
    project: sanitizedProjectSchema
  },
  validate_project: {
    ok: z.boolean(),
    errors: z.array(validationIssueSchema),
    warnings: z.array(validationIssueSchema)
  },
  get_project_overview: {
    project: sanitizedProjectSchema
  },
  get_project_graph: {
    graph: graphSchema
  },
  get_task_detail: {
    task: taskDetailSchema
  },
  get_block_detail: {
    block: blockDetailSchema
  },
  get_review_pipeline: {
    reviewPipeline: reviewPipelineSchema
  }
} satisfies Record<PlanweaveToolName, z.core.$ZodLooseShape>;

import * as z from "zod/v4";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";
import type { PlanweaveToolName } from "./tools.js";

const blockTypes = ["implementation", "review"] as const;
const blockStatuses = ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"] as const;
const edgeTypes = ["depends_on"] as const;
const reviewTriggerConditions = ["after_required_work_completed", "manual"] as const;
const taskStatuses = ["planned", "ready", "in_progress", "implemented"] as const;
const searchResultKinds = ["task", "block", "prompt", "run_record", "review_attempt", "feedback"] as const;
const feedbackStatuses = ["open", "in_progress", "resolved", "dismissed"] as const;

const validationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional()
}).passthrough();

const validationReportSchema = z.object({
  ok: z.boolean(),
  errors: z.array(validationIssueSchema),
  warnings: z.array(validationIssueSchema)
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
    exceptions: z.array(z.unknown())
  }).passthrough()),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    type: z.enum(edgeTypes)
  }).passthrough()),
  diagnostics: z.array(validationIssueSchema),
  dirtyPromptRefs: z.array(z.string())
}).passthrough();

const graphContextSummarySchema = z.object({
  canvasId: z.string(),
  name: z.string(),
  taskCount: z.number(),
  edgeCount: z.number(),
  diagnostics: z.array(validationIssueSchema),
  dirtyPromptRefs: z.array(z.string()),
  tasks: z.array(z.object({
    taskId: z.string(),
    title: z.string(),
    status: z.enum(taskStatuses),
    executor: z.string().nullable(),
    promptMissing: z.boolean(),
    blockCount: z.number(),
    blocks: z.array(blockPreviewSchema)
  }).passthrough())
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
  promptSources: z.array(z.unknown()),
  dependencies: z.array(z.string()),
  latestRunId: z.string().nullable(),
  latestReviewAttemptId: z.string().nullable(),
  activeFeedbackId: z.string().nullable(),
  exceptionReason: z.string().nullable(),
  reviewGate: z.unknown().nullable()
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

const planweaveGuideSchema = z.object({
  summary: z.string(),
  concepts: z.array(z.object({
    name: z.string(),
    description: z.string()
  }).passthrough()),
  workspaceLayout: z.array(z.string()),
  mcpWorkflow: z.array(z.string()),
  toolSelection: z.array(z.object({
    need: z.string(),
    tool: z.string()
  }).passthrough()),
  nonGoals: z.array(z.string())
}).passthrough();

const graphEditSchema = z.object({
  ok: z.boolean(),
  affectedTasks: z.array(z.string()),
  diagnostics: z.array(validationIssueSchema)
}).passthrough();

const packageFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.literal("utf8")
}).passthrough();

const planPackageExportSchema = z.object({
  canvasId: z.string().nullable(),
  files: z.array(packageFileSchema)
}).passthrough();

const promptOutputSchema = {
  target: z.string(),
  markdown: z.string(),
  taskId: z.string().optional(),
  blockRef: z.string().optional(),
  promptMissing: z.boolean().optional(),
  rendered: z.boolean().optional()
};

const graphEditOutputSchema = {
  edit: graphEditSchema
};

const executionStatusSchema = {
  projectId: z.string(),
  canvasId: z.string().nullable(),
  taskTotal: z.number(),
  blockTotal: z.number(),
  tasks: z.array(z.object({
    taskId: z.string(),
    status: z.enum(taskStatuses),
    openFeedbackCount: z.number()
  }).passthrough()),
  blocks: z.array(z.object({
    ref: z.string(),
    taskId: z.string(),
    blockId: z.string(),
    type: z.enum(blockTypes),
    status: z.enum(blockStatuses),
    reason: z.string().nullable().optional(),
    completionReason: z.enum(["passed", "max_cycles_reached"]).nullable().optional(),
    lastRunId: z.string().nullable().optional(),
    latestReviewAttemptId: z.string().nullable().optional(),
    activeFeedbackId: z.string().nullable().optional()
  }).passthrough()),
  currentRefs: z.array(z.string()),
  openFeedback: z.array(z.object({
    feedbackId: z.string(),
    sourceReviewBlockRef: z.string(),
    status: z.enum(["open", "in_progress"])
  }).passthrough()),
  nextClaimable: z.array(z.string()),
  claimHints: z.array(z.object({
    ref: z.string(),
    taskId: z.string(),
    blockId: z.string(),
    blockType: z.enum(blockTypes),
    status: z.enum(blockStatuses),
    statusReason: z.string().nullable(),
    ready: z.boolean(),
    readyReason: z.string().nullable(),
    blockedByBlocks: z.array(z.string()),
    blockedByTasks: z.array(z.string()),
    blockedByProject: z.array(z.string()),
    parallelSafe: z.boolean(),
    sequentialOnly: z.boolean(),
    recommendedCommand: z.string().nullable(),
    dispatchable: z.boolean(),
    dispatchCommand: z.string().nullable(),
    reviewGate: z.unknown().nullable()
  }).passthrough()),
  counts: z.object({
    tasks: z.record(z.enum(taskStatuses), z.number()),
    blocks: z.record(z.enum(blockStatuses), z.number()),
    feedback: z.record(z.enum(feedbackStatuses), z.number())
  }).passthrough(),
  warnings: z.array(validationIssueSchema)
};

const searchResultSchema = z.object({
  kind: z.enum(searchResultKinds),
  canvasId: z.string().optional(),
  canvasName: z.string().optional(),
  ref: z.string(),
  targetRef: z.string().optional(),
  title: z.string(),
  excerpt: z.string(),
  match: z.object({
    field: z.enum(["title", "body"]),
    start: z.number(),
    length: z.number(),
    excerpt: z.string(),
    excerptStart: z.number()
  }).optional(),
  recordId: z.string().optional()
}).passthrough();

const readyBlockSchema = z.object({
  canvasId: z.string().nullable(),
  canvasName: z.string().nullable(),
  ref: z.string(),
  taskId: z.string(),
  blockId: z.string(),
  title: z.string(),
  parallelSafe: z.boolean(),
  locks: z.array(z.string()),
  reviewGate: z.unknown().nullable()
}).passthrough();

const planweaveContextProjectSchema = z.object({
  project: sanitizedProjectSchema,
  validation: validationReportSchema.nullable(),
  status: z.object(executionStatusSchema).nullable(),
  readyBlocks: z.array(readyBlockSchema),
  canvases: z.array(graphContextSummarySchema),
  errors: z.array(z.object({
    scope: z.string(),
    message: z.string()
  }).passthrough())
}).passthrough();

const projectTaskRefSchema = z.object({
  canvasId: z.string(),
  taskId: z.string()
}).passthrough();

const projectGraphSchema = z.object({
  version: z.string(),
  canvases: z.array(z.object({
    id: z.string(),
    type: z.literal("canvas"),
    title: z.string(),
    description: z.string().optional(),
    packageDir: z.string(),
    stateFile: z.string(),
    resultsDir: z.string()
  }).passthrough()),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    type: z.literal("depends_on")
  }).passthrough()),
  crossTaskEdges: z.array(z.object({
    from: projectTaskRefSchema,
    to: projectTaskRefSchema,
    type: z.literal("depends_on")
  }).passthrough())
}).passthrough();

const projectGraphEditOutputSchema = {
  projectGraphEdit: z.object({
    ok: z.boolean(),
    diagnostics: z.array(validationIssueSchema),
    graph: projectGraphSchema
  }).passthrough()
};

export const planweaveToolOutputSchemas = {
  get_schema: {
    topic: z.enum(runtimeSchemaTopicOrder).nullable(),
    documents: z.record(z.string(), schemaDocumentSchema)
  },
  get_planweave_guide: {
    guide: planweaveGuideSchema
  },
  get_authoring_rules: {
    rules: z.array(z.string())
  },
  get_plan_package_example: {
    files: z.array(packageFileSchema),
    notes: z.array(z.string())
  },
  get_project_tree: {
    generatedAt: z.string(),
    desktopSelection: z.null(),
    guidance: z.array(z.string()),
    projects: z.array(planweaveContextProjectSchema),
    errors: z.array(z.object({
      scope: z.string(),
      message: z.string()
    }).passthrough())
  },
  list_projects: {
    projects: z.array(sanitizedProjectSchema)
  },
  open_project: {
    project: sanitizedProjectSchema
  },
  init_project: {
    project: sanitizedProjectSchema
  },
  create_canvas: {
    canvas: taskCanvasSummarySchema
  },
  get_project_overview: {
    project: sanitizedProjectSchema
  },
  validate_project: validationReportSchema.shape,
  explain_validation_errors: {
    ok: z.boolean(),
    issues: z.array(validationIssueSchema.passthrough()),
    explanations: z.array(z.object({
      code: z.string(),
      severity: z.enum(["error", "warning"]),
      path: z.string().nullable(),
      explanation: z.string(),
      suggestedAction: z.string()
    }).passthrough())
  },
  get_status: executionStatusSchema,
  get_prompt: {
    projectId: z.string(),
    canvasId: z.string().nullable(),
    ref: z.string(),
    markdown: z.string()
  },
  search_project: {
    results: z.array(searchResultSchema),
    diagnostics: z.array(validationIssueSchema)
  },
  list_ready_blocks: {
    readyBlocks: z.array(readyBlockSchema)
  },
  preview_execution_graph: {
    graph: graphSchema
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
  },
  update_review_pipeline: graphEditOutputSchema,
  create_task: graphEditOutputSchema,
  update_task: graphEditOutputSchema,
  update_task_acceptance: graphEditOutputSchema,
  remove_task: graphEditOutputSchema,
  create_block: graphEditOutputSchema,
  update_block: graphEditOutputSchema,
  update_canvas_execution_policy: graphEditOutputSchema,
  update_block_planning: graphEditOutputSchema,
  update_block_dependencies: graphEditOutputSchema,
  remove_block: graphEditOutputSchema,
  add_dependency: graphEditOutputSchema,
  remove_dependency: graphEditOutputSchema,
  add_canvas_dependency: projectGraphEditOutputSchema,
  remove_canvas_dependency: projectGraphEditOutputSchema,
  add_cross_task_dependency: projectGraphEditOutputSchema,
  remove_cross_task_dependency: projectGraphEditOutputSchema,
  read_prompt: promptOutputSchema,
  write_task_prompt: graphEditOutputSchema,
  write_block_prompt: graphEditOutputSchema,
  update_project_prompt: {
    markdown: z.string()
  },
  refresh_prompts: {
    refresh: z.object({
      prompts: z.array(z.object({
        ref: z.string(),
        path: z.string(),
        markdown: z.string()
      }).passthrough())
    }).passthrough()
  },
  export_project: {
    project: sanitizedProjectSchema,
    projectPromptMarkdown: z.string(),
    planPackages: z.array(planPackageExportSchema)
  },
  export_plan_package: {
    planPackage: planPackageExportSchema
  },
  import_plan_package: {
    project: sanitizedProjectSchema,
    validation: validationReportSchema,
    importedFiles: z.number()
  }
} satisfies Record<PlanweaveToolName, z.core.$ZodLooseShape>;

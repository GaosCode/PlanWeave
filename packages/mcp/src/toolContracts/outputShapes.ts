import * as z from "zod/v4";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";

const blockTypes = ["implementation", "review"] as const;
const blockStatuses = ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"] as const;
const edgeTypes = ["depends_on"] as const;
const reviewTriggerConditions = ["after_required_work_completed", "manual"] as const;
const taskStatuses = ["planned", "ready", "in_progress", "implemented"] as const;
const searchResultKinds = ["task", "block", "prompt", "run_record", "review_attempt", "feedback"] as const;
const feedbackStatuses = ["open", "in_progress", "resolved", "dismissed"] as const;

export const validationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional()
}).passthrough();

const validationSummarySchema = z.object({
  errorCount: z.number(),
  warningCount: z.number(),
  groups: z.array(z.object({
    code: z.string(),
    message: z.string(),
    count: z.number(),
    examples: z.array(z.string())
  }).passthrough())
}).passthrough();

export const validationReportSchema = z.object({
  ok: z.boolean(),
  errors: z.array(validationIssueSchema),
  warnings: z.array(validationIssueSchema),
  summary: validationSummarySchema
}).passthrough();

export const taskCanvasSummarySchema = z.object({
  canvasId: z.string(),
  name: z.string(),
  taskCount: z.number(),
  missingPromptCount: z.number(),
  diagnostics: z.array(validationIssueSchema),
  createdAt: z.string(),
  updatedAt: z.string()
}).passthrough();

export const sanitizedProjectSchema = z.object({
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

export const graphSchema = z.object({
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

export const graphContextSummarySchema = z.object({
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

export const taskDetailSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.enum(taskStatuses),
  executor: z.string().nullable(),
  promptMarkdown: z.string(),
  promptMissing: z.boolean(),
  acceptance: z.array(z.string()),
  blockOrder: z.array(z.string())
}).passthrough();

export const blockDetailSchema = z.object({
  ref: z.string(),
  taskId: z.string(),
  blockId: z.string(),
  type: z.enum(blockTypes),
  title: z.string(),
  status: z.enum(blockStatuses),
  executor: z.string().nullable(),
  effectiveExecutor: z.string().nullable().optional(),
  promptMissing: z.boolean(),
  promptMarkdown: z.string().optional(),
  promptHash: z.string().optional(),
  promptSurfaceMarkdown: z.string().optional(),
  promptSources: z.array(z.unknown()).optional(),
  promptMarkdownAvailable: z.boolean().optional(),
  renderedPromptAvailable: z.boolean().optional(),
  promptSourceCount: z.number().optional(),
  dependencies: z.array(z.string()),
  latestRunId: z.string().nullable(),
  latestReviewAttemptId: z.string().nullable(),
  activeFeedbackId: z.string().nullable(),
  exceptionReason: z.string().nullable(),
  reviewGate: z.unknown().nullable()
}).passthrough();

export const reviewPipelineSchema = z.object({
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

export const schemaDocumentSchema = z.object({
  name: z.string(),
  summary: z.string(),
  path: z.string(),
  ownership: z.string(),
  validation: z.array(z.string()),
  schema: z.unknown(),
  notes: z.array(z.string())
}).passthrough();

export const schemaTopicSummarySchema = z.object({
  name: z.enum(runtimeSchemaTopicOrder),
  summary: z.string(),
  path: z.string(),
  ownership: z.string()
}).passthrough();

export const planweaveGuideSchema = z.object({
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

export const packageExampleSummarySchema = z.object({
  template: z.string(),
  title: z.string(),
  description: z.string(),
  fileCount: z.number()
}).passthrough();

export const graphEditSchema = z.object({
  ok: z.boolean(),
  affectedTasks: z.array(z.string()),
  diagnostics: z.array(validationIssueSchema)
}).passthrough();

export const packageFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.literal("utf8")
}).passthrough();

export const planPackageExportSchema = z.object({
  canvasId: z.string().nullable(),
  files: z.array(packageFileSchema)
}).passthrough();

const packageFileSummarySchema = z.object({
  path: z.string(),
  encoding: z.literal("utf8"),
  contentBytes: z.number(),
  content: z.string().optional()
}).passthrough();

export const planPackageExportSummarySchema = z.object({
  canvasId: z.string().nullable(),
  fileCount: z.number(),
  contentIncluded: z.boolean(),
  files: z.array(packageFileSummarySchema)
}).passthrough();

export const projectExportSummarySchema = z.object({
  project: sanitizedProjectSchema,
  projectPrompt: z.object({
    contentIncluded: z.boolean(),
    markdownBytes: z.number()
  }).passthrough(),
  planPackages: z.array(planPackageExportSummarySchema)
}).passthrough();

export const projectExportFilesSchema = z.object({
  project: sanitizedProjectSchema,
  projectPromptMarkdown: z.string().optional(),
  planPackages: z.array(planPackageExportSchema)
}).passthrough();

const graphQualitySummarySchema = z.object({
  taskCount: z.number(),
  blockCount: z.number(),
  taskDependencyCount: z.number(),
  reviewBlockCount: z.number(),
  orphanTaskCount: z.number(),
  score: z.number(),
  errorCount: z.number(),
  warningCount: z.number(),
  infoCount: z.number()
}).passthrough();

const graphQualityDiagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  count: z.number(),
  examples: z.array(z.string()),
  suggestion: z.string(),
  ruleType: z.enum(["structural", "policy", "heuristic"]),
  affectedIds: z.array(z.string()),
  suggestedTool: z.string().optional(),
  fixId: z.string().optional()
}).passthrough();

export const graphQualityReportSchema = z.object({
  ok: z.boolean(),
  summary: graphQualitySummarySchema,
  diagnostics: z.array(graphQualityDiagnosticSchema)
}).passthrough();

const packageDraftCanvasReportSchema = z.object({
  canvasId: z.string().nullable(),
  packageDir: z.string(),
  validation: validationReportSchema,
  graphQuality: graphQualityReportSchema.nullable(),
  fileCount: z.number()
}).passthrough();

export const packageDraftValidationSchema = z.object({
  ok: z.boolean(),
  draftRoot: z.string(),
  mode: z.enum(["single-canvas", "project"]).nullable(),
  validation: validationReportSchema,
  canvases: z.array(packageDraftCanvasReportSchema)
}).passthrough();

const packageDraftFileDiffSchema = z.object({
  path: z.string(),
  type: z.enum(["added", "changed", "removed", "unchanged"])
}).passthrough();

const packageDraftImportEffectSchema = z.object({
  type: z.enum(["replace_package", "reset_state", "reset_results", "write_project_graph", "remove_canvas"]),
  path: z.string()
}).passthrough();

export const packageDraftImportPreviewSchema = packageDraftValidationSchema.extend({
  target: z.object({
    projectRoot: z.string(),
    canvasId: z.string().nullable()
  }).passthrough(),
  fileDiffs: z.array(packageDraftFileDiffSchema),
  effects: z.array(packageDraftImportEffectSchema),
  summary: z.object({
    fileCount: z.number(),
    added: z.number(),
    changed: z.number(),
    removed: z.number(),
    unchanged: z.number()
  }).passthrough()
}).passthrough();

export const packageDraftImportApplySchema = packageDraftImportPreviewSchema.extend({
  applied: z.boolean()
}).passthrough();

const graphInspectionPageSchema = z.object({
  limit: z.number(),
  cursor: z.string().nullable(),
  nextCursor: z.string().nullable(),
  total: z.number(),
  truncated: z.boolean()
}).passthrough();

const graphInspectionTaskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.enum(taskStatuses),
  acceptanceCount: z.number(),
  blockCount: z.number(),
  reviewBlockCount: z.number(),
  dependsOn: z.array(z.string()),
  dependents: z.array(z.string()),
  promptMissing: z.boolean()
}).passthrough();

const graphInspectionBlockSchema = z.object({
  ref: z.string(),
  blockId: z.string(),
  type: z.enum(blockTypes),
  title: z.string(),
  status: z.enum(blockStatuses),
  dependsOn: z.array(z.string())
}).passthrough();

const graphInspectionEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.literal("depends_on")
}).passthrough();

function boundedSectionSchema<T extends z.core.$ZodType>(itemSchema: T) {
  return z.object({
    limit: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    items: z.array(itemSchema)
  }).passthrough();
}

export const graphInspectionSchema = z.discriminatedUnion("view", [
  z.object({
    view: z.literal("summary"),
    project: z.object({
      id: z.string(),
      title: z.string(),
      description: z.string()
    }).passthrough(),
    canvas: z.object({
      id: z.string().nullable(),
      title: z.string()
    }).passthrough(),
    counts: z.object({
      taskCount: z.number(),
      blockCount: z.number(),
      taskDependencyCount: z.number(),
      reviewBlockCount: z.number(),
      readyBlockCount: z.number(),
      diagnosticCount: z.number()
    }).passthrough(),
    tasksPreview: z.array(graphInspectionTaskSchema),
    page: graphInspectionPageSchema
  }).passthrough(),
  z.object({
    view: z.literal("tasks"),
    tasks: z.array(graphInspectionTaskSchema),
    page: graphInspectionPageSchema
  }).passthrough(),
  z.object({
    view: z.literal("slice"),
    taskId: z.string(),
    center: graphInspectionTaskSchema,
    dependencies: boundedSectionSchema(graphInspectionTaskSchema),
    dependents: boundedSectionSchema(graphInspectionTaskSchema),
    edges: boundedSectionSchema(graphInspectionEdgeSchema),
    blocks: boundedSectionSchema(graphInspectionBlockSchema)
  }).passthrough()
]);

export const executionReadinessReportSchema = z.object({
  ok: z.boolean(),
  summary: z.object({
    taskCount: z.number(),
    blockCount: z.number(),
    readyBlockCount: z.number(),
    currentRefCount: z.number(),
    openFeedbackCount: z.number(),
    errorCount: z.number(),
    warningCount: z.number(),
    infoCount: z.number()
  }).passthrough(),
  diagnostics: z.array(z.object({
    code: z.string(),
    severity: z.enum(["error", "warning", "info"]),
    message: z.string(),
    affectedRefs: z.array(z.string()),
    suggestedTool: z.string().optional()
  }).passthrough()),
  nextClaimable: z.array(z.string())
}).passthrough();

export const passthroughObjectSchema = z.object({}).passthrough();

export const toolGroupsSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  recommendedTools: z.array(z.string())
}).passthrough();

export const packageContentRefSchema = z.object({
  kind: z.enum(["package_file", "prompt_source", "rendered_prompt"]),
  path: z.string().optional(),
  ref: z.string().optional(),
  hash: z.string(),
  sizeBytes: z.number()
}).passthrough();

export const packageFileListSchema = {
  files: z.array(z.object({
    path: z.string(),
    sizeBytes: z.number(),
    hash: z.string(),
    owner: passthroughObjectSchema,
    preview: z.string(),
    contentRef: packageContentRefSchema
  }).passthrough()),
  pagination: z.object({
    limit: z.number(),
    cursor: z.string().nullable(),
    nextCursor: z.string().nullable(),
    total: z.number(),
    hasMore: z.boolean()
  }).passthrough()
};

export const packageContentReadSchema = z.object({
  contentRef: packageContentRefSchema,
  content: z.string(),
  truncated: z.boolean()
}).passthrough();

export const promptOutputSchema = {
  target: z.string(),
  markdown: z.string(),
  taskId: z.string().optional(),
  blockRef: z.string().optional(),
  promptMissing: z.boolean().optional(),
  rendered: z.boolean().optional()
};

export const graphEditOutputSchema = {
  edit: graphEditSchema
};

const bulkEditSchema = z.object({
  ok: z.boolean(),
  counts: z.object({
    affectedTaskCount: z.number(),
    affectedBlockCount: z.number(),
    diagnosticCount: z.number()
  }).passthrough(),
  affectedTasks: z.array(z.string()),
  affectedBlocks: z.array(z.string()),
  diagnostics: z.array(validationIssueSchema),
  graphDigest: z.string().optional()
}).passthrough();

export const bulkEditOutputSchema = {
  bulkEdit: bulkEditSchema
};

export const executionStatusSchema = {
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

export const searchResultSchema = z.object({
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

export const readyBlockSchema = z.object({
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

export const planweaveContextProjectSchema = z.object({
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

export const projectGraphSchema = z.object({
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

export const projectGraphEditOutputSchema = {
  projectGraphEdit: z.object({
    ok: z.boolean(),
    diagnostics: z.array(validationIssueSchema),
    graph: projectGraphSchema
  }).passthrough()
};

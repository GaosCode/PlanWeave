import * as z from "zod/v4";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";
import {
  createTaskInputShape,
  updateBlockInputShape,
  updateReviewPipelineInputShape,
  updateTaskInputShape
} from "./toolInputSchemas.js";
import type { PlanweaveToolName } from "./tools.js";

const blockTypeSchema = z.enum(["implementation", "review"]);
const graphViewSchema = z.enum(["summary", "tasks", "slice"]);
const graphReviewPolicySchema = z.enum(["none", "risk-based", "required"]);
const graphGatePolicySchema = z.enum(["none", "required"]);
const graphHeuristicsSchema = z.enum(["on", "off"]);
const searchResultKindSchema = z.enum(["task", "block", "prompt", "run_record", "review_attempt", "feedback"]);
const reviewHookSchema = z.object({
  id: z.string().min(1),
  type: z.literal("executable"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  executionPolicy: z.literal("trusted-local")
});
const packageFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal("utf8").optional()
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  openWorldHint: false
} as const;

export type ToolDefinition = {
  title: string;
  description: string;
  inputSchema?: z.core.$ZodLooseShape;
  annotations: typeof readOnlyAnnotations | typeof writeAnnotations;
};

const projectInput = {
  projectId: z.string().min(1)
};

const projectCanvasInput = {
  ...projectInput,
  canvasId: z.string().min(1).optional()
};

const optionalProjectCanvasInput = {
  ...projectInput,
  canvasId: z.string().min(1).nullable().optional()
};

const blockRefInput = {
  blockRef: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional()
};

const taskPromptInput = {
  ...projectCanvasInput,
  taskId: z.string().min(1),
  markdown: z.string()
};

const blockPromptInput = {
  ...projectCanvasInput,
  ...blockRefInput,
  markdown: z.string()
};

const semanticTaskDependencyInput = {
  ...projectCanvasInput,
  dependentTaskId: z.string().min(1),
  dependsOnTaskId: z.string().min(1)
};

const taskDependencyEdgeSchema = z.object({
  dependentTaskId: z.string().min(1),
  dependsOnTaskId: z.string().min(1)
});

const taskDependencyUpdateSchema = z.object({
  taskId: z.string().min(1),
  dependsOn: z.array(z.string().min(1))
});

const bulkCreateTaskSchema = z.object({
  title: z.string().min(1),
  promptMarkdown: z.string(),
  acceptance: z.array(z.string().min(1)).optional(),
  blockTypes: z.array(blockTypeSchema).optional(),
  executor: z.string().min(1).nullable().optional()
});

const bulkCreateBlockSchema = z.object({
  taskId: z.string().min(1),
  type: blockTypeSchema,
  title: z.string().min(1),
  promptMarkdown: z.string(),
  executor: z.string().min(1).nullable().optional(),
  dependsOn: z.array(z.string().min(1)).optional()
});

const bulkUpdateTaskSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1).optional(),
  promptMarkdown: z.string().optional(),
  executor: z.string().min(1).nullable().optional(),
  acceptance: z.array(z.string().min(1)).optional()
});

const bulkUpdateBlockSchema = z.object({
  ...blockRefInput,
  title: z.string().min(1).optional(),
  promptMarkdown: z.string().optional(),
  executor: z.string().min(1).nullable().optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  parallelSafe: z.boolean().optional(),
  parallelLocks: z.array(z.string().min(1)).optional(),
  reviewRequired: z.boolean().optional(),
  maxFeedbackCycles: z.number().int().nonnegative().optional(),
  reviewHook: reviewHookSchema.nullable().optional()
});

const blockDependencyRefSchema = z.object({
  ...blockRefInput,
  dependsOnBlockId: z.string().min(1)
});

const blockDependencyUpdateSchema = z.object({
  blockRef: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1))
});

const reviewPipelineBulkUpdateSchema = z.object({
  taskId: z.string().min(1),
  packageDefaults: updateReviewPipelineInputShape.packageDefaults.optional(),
  steps: updateReviewPipelineInputShape.steps
});

const parallelBlockPolicySchema = z.object({
  blockRef: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional(),
  parallelSafe: z.boolean().optional(),
  parallelLocks: z.array(z.string().min(1)).optional()
});

const graphReadInput = {
  ...projectCanvasInput,
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).optional()
};

const graphSliceInput = {
  ...projectCanvasInput,
  taskId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional()
};

const promptSourceInput = {
  ...projectCanvasInput,
  target: z.enum(["project", "task", "block"]),
  taskId: z.string().min(1).optional(),
  blockRef: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().optional()
};

const promptSourceWriteInput = {
  ...projectCanvasInput,
  target: z.enum(["project", "task", "block"]),
  taskId: z.string().min(1).optional(),
  blockRef: z.string().min(1).optional(),
  markdown: z.string()
};

export const planweaveToolDefinitions: Record<PlanweaveToolName, ToolDefinition> = {
  list_tool_groups: {
    title: "List PlanWeave Tool Groups",
    description: "Return recommended lightweight PlanWeave MCP tool groups and identify legacy compatibility aliases.",
    annotations: readOnlyAnnotations
  },
  get_schema: {
    title: "Get PlanWeave Schema",
    description: "Return PlanWeave runtime schema documents.",
    inputSchema: { topic: z.enum(runtimeSchemaTopicOrder).optional() },
    annotations: readOnlyAnnotations
  },
  get_planweave_guide: {
    title: "Get PlanWeave Guide",
    description:
      "Explain PlanWeave concepts, workspace layout, default canvas storage, and MCP tool selection. Use this when you need to understand how to author plans correctly.",
    annotations: readOnlyAnnotations
  },
  get_authoring_rules: {
    title: "Get PlanWeave Authoring Rules",
    description: "Return concise rules for authoring PlanWeave packages through MCP tools.",
    annotations: readOnlyAnnotations
  },
  get_plan_package_examples: {
    title: "List PlanWeave Package Examples",
    description: "Return official package example templates by default; pass template to include the selected file set.",
    inputSchema: { template: z.string().min(1).optional() },
    annotations: readOnlyAnnotations
  },
  get_plan_package_example: {
    title: "Get PlanWeave Package Example",
    description: "Compatibility alias that returns the basic importable PlanWeave package file set. Prefer get_plan_package_examples for template discovery.",
    annotations: readOnlyAnnotations
  },
  get_project_tree: {
    title: "Get PlanWeave Project Tree",
    description:
      "Return a tree of registered PlanWeave projects, canvases, tasks, and blocks, including projectIds/canvasIds needed for later read and write tools.",
    inputSchema: {
      projectId: z.string().min(1).optional(),
      includeTasks: z.boolean().optional(),
      includeStatus: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  list_projects: {
    title: "List PlanWeave Projects",
    description: "Compatibility alias for list_projects_summary.",
    annotations: readOnlyAnnotations
  },
  list_projects_summary: {
    title: "List PlanWeave Project Summaries",
    description: "List registered PlanWeave projects with projectId, name, active canvas, canvas count, and diagnostics counts.",
    annotations: readOnlyAnnotations
  },
  open_project: {
    title: "Open PlanWeave Project",
    description: "Compatibility alias for open_project_summary.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  open_project_summary: {
    title: "Open PlanWeave Project Summary",
    description: "Return one registered PlanWeave project's metadata and canvas summaries by projectId.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  list_canvases: {
    title: "List PlanWeave Canvases",
    description: "List canvas summaries for one registered PlanWeave project without returning task or prompt bodies.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  create_project: {
    title: "Create PlanWeave Project",
    description: "Create or open a managed PlanWeave project by name.",
    inputSchema: { name: z.string().min(1) },
    annotations: writeAnnotations
  },
  init_project: {
    title: "Initialize PlanWeave Project",
    description: "Compatibility alias for create_project.",
    inputSchema: { name: z.string().min(1) },
    annotations: writeAnnotations
  },
  create_canvas: {
    title: "Create PlanWeave Task Canvas",
    description: "Create a new task canvas in a registered PlanWeave project.",
    inputSchema: { ...projectInput, name: z.string().min(1).optional() },
    annotations: writeAnnotations
  },
  get_project_overview: {
    title: "Get PlanWeave Project Overview",
    description: "Compatibility alias for open_project. Return a registered PlanWeave project's canvases and high-level summary.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  validate_project: {
    title: "Validate PlanWeave Project",
    description: "Validate a registered PlanWeave project by projectId.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  explain_validation_errors: {
    title: "Explain PlanWeave Validation Errors",
    description: "Validate a project and return issue explanations with suggested repair actions.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  get_status: {
    title: "Get PlanWeave Execution Status",
    description: "Return sanitized execution status for a registered project or selected canvas.",
    inputSchema: optionalProjectCanvasInput,
    annotations: readOnlyAnnotations
  },
  get_prompt: {
    title: "Get PlanWeave Rendered Prompt",
    description: "Return the rendered prompt markdown for a block without modifying source prompts.",
    inputSchema: { ...optionalProjectCanvasInput, ref: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  search_project: {
    title: "Search PlanWeave Project",
    description: "Search tasks, blocks, prompts, and result records in a registered project.",
    inputSchema: {
      ...optionalProjectCanvasInput,
      query: z.string().min(1),
      kinds: z.array(searchResultKindSchema).optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    annotations: readOnlyAnnotations
  },
  list_ready_blocks: {
    title: "List PlanWeave Ready Blocks",
    description: "Return the project-level ready queue or the ready queue for a selected canvas.",
    inputSchema: optionalProjectCanvasInput,
    annotations: readOnlyAnnotations
  },
  preview_execution_graph: {
    title: "Preview PlanWeave Execution Graph",
    description: "Compatibility alias for get_project_graph. Preview the selected canvas DAG before or after graph edits.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  get_project_graph: {
    title: "Get PlanWeave Project Graph",
    description: "Legacy graph DTO. Prefer get_graph_summary, list_tasks, or get_graph_slice for bounded runtime graph inspection.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  get_graph_summary: {
    title: "Get PlanWeave Graph Summary",
    description: "Return a bounded runtime graph summary without prompt bodies or Desktop-only DTO fields.",
    inputSchema: graphReadInput,
    annotations: readOnlyAnnotations
  },
  get_graph_slice: {
    title: "Get PlanWeave Graph Slice",
    description: "Return a bounded task neighborhood from the runtime graph inspection service.",
    inputSchema: graphSliceInput,
    annotations: readOnlyAnnotations
  },
  list_tasks: {
    title: "List PlanWeave Tasks",
    description: "List tasks in a canvas with pagination and lightweight dependency/block counts.",
    inputSchema: graphReadInput,
    annotations: readOnlyAnnotations
  },
  validate_graph_quality: {
    title: "Validate PlanWeave Graph Quality",
    description: "Run runtime graph quality diagnostics for a canvas, including review, gate, dependency, layout, and heuristic rules.",
    inputSchema: {
      ...projectCanvasInput,
      reviewPolicy: graphReviewPolicySchema.optional(),
      gatePolicy: graphGatePolicySchema.optional(),
      heuristics: graphHeuristicsSchema.optional(),
      strict: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  validate_execution_readiness: {
    title: "Validate PlanWeave Execution Readiness",
    description: "Check whether a canvas is currently runnable using runtime status and claim readiness.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  get_task_detail: {
    title: "Get PlanWeave Task Detail",
    description: "Return a task's prompt, acceptance criteria, status, executor, and ordered block refs.",
    inputSchema: { ...projectCanvasInput, taskId: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  get_block_detail: {
    title: "Get PlanWeave Block Detail",
    description: "Compatibility detail tool. Defaults to legacy full block fields, including prompt markdown and rendered prompt surface. Use view: summary or get_block_summary for bounded output.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput, view: z.enum(["legacy", "summary", "content"]).optional() },
    annotations: readOnlyAnnotations
  },
  get_block_summary: {
    title: "Get PlanWeave Block Summary",
    description: "Return bounded block metadata without promptMarkdown, promptSurfaceMarkdown, or promptSources.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput },
    annotations: readOnlyAnnotations
  },
  get_block_detail_full_debug: {
    title: "Get PlanWeave Block Detail Full Debug",
    description: "Explicit heavy/debug block detail tool that returns source prompt, rendered prompt surface, and prompt sources.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput },
    annotations: readOnlyAnnotations
  },
  get_review_pipeline: {
    title: "Get PlanWeave Review Pipeline",
    description: "Return review gates configured for a task, including presets, pass criteria, feedback format, and prompt markdown.",
    inputSchema: { ...projectCanvasInput, taskId: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  update_review_pipeline: {
    title: "Update PlanWeave Review Pipeline",
    description: "Replace review gate steps and package review defaults for a task.",
    inputSchema: updateReviewPipelineInputShape,
    annotations: writeAnnotations
  },
  set_review_pipeline: {
    title: "Set PlanWeave Review Pipeline",
    description: "Preferred replacement-name alias for update_review_pipeline.",
    inputSchema: updateReviewPipelineInputShape,
    annotations: writeAnnotations
  },
  create_task: {
    title: "Create PlanWeave Task",
    description: "Create a task node and initial blocks in the selected canvas.",
    inputSchema: createTaskInputShape,
    annotations: writeAnnotations
  },
  update_task: {
    title: "Update PlanWeave Task",
    description: "Update a task title, prompt markdown, or executor. Use promptMarkdown here instead of a separate prompt-writing tool.",
    inputSchema: updateTaskInputShape,
    annotations: writeAnnotations
  },
  update_task_acceptance: {
    title: "Update PlanWeave Task Acceptance",
    description: "Replace a task's acceptance criteria.",
    inputSchema: { ...projectCanvasInput, taskId: z.string().min(1), acceptance: z.array(z.string().min(1)).min(1) },
    annotations: writeAnnotations
  },
  remove_task: {
    title: "Remove PlanWeave Task",
    description: "Remove a task node and its package files from the selected canvas.",
    inputSchema: { ...projectCanvasInput, taskId: z.string().min(1) },
    annotations: writeAnnotations
  },
  create_block: {
    title: "Create PlanWeave Block",
    description: "Create an implementation or review block under a task.",
    inputSchema: {
      ...projectCanvasInput,
      taskId: z.string().min(1),
      type: blockTypeSchema,
      title: z.string().min(1),
      promptMarkdown: z.string(),
      executor: z.string().min(1).nullable().optional(),
      dependsOn: z.array(z.string().min(1)).optional()
    },
    annotations: writeAnnotations
  },
  update_block: {
    title: "Update PlanWeave Block",
    description: "Update a block title, prompt markdown, or executor. Use promptMarkdown here instead of a separate prompt-writing tool.",
    inputSchema: updateBlockInputShape,
    annotations: writeAnnotations
  },
  update_canvas_execution_policy: {
    title: "Update PlanWeave Canvas Execution Policy",
    description:
      "Update selected top-level manifest execution policy fields for one canvas. Use this for execution.defaultExecutor and execution.parallel; use update_block_planning for per-block parallel safety and locks.",
    inputSchema: {
      ...projectCanvasInput,
      defaultExecutor: z.string().min(1).nullable().optional(),
      parallelEnabled: z.boolean().optional(),
      maxConcurrent: z.number().int().positive().optional()
    },
    annotations: writeAnnotations
  },
  update_block_planning: {
    title: "Update PlanWeave Block Planning",
    description:
      "Update per-block planning fields: implementation parallel safety/locks or review block planning fields. Use update_canvas_execution_policy for the canvas-level parallel enable/maxConcurrent switch.",
    inputSchema: {
      ...projectCanvasInput,
      ...blockRefInput,
      parallelSafe: z.boolean().optional(),
      parallelLocks: z.array(z.string().min(1)).optional(),
      reviewRequired: z.boolean().optional(),
      maxFeedbackCycles: z.number().int().nonnegative().optional(),
      reviewHook: reviewHookSchema.nullable().optional()
    },
    annotations: writeAnnotations
  },
  update_block_dependencies: {
    title: "Update PlanWeave Block Dependencies",
    description: "Compatibility alias for set_block_dependencies. Replace a block's intra-task depends_on block id list.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput, dependsOn: z.array(z.string().min(1)) },
    annotations: writeAnnotations
  },
  set_block_dependencies: {
    title: "Set PlanWeave Block Dependencies",
    description: "Replace a block's intra-task depends_on block id list.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput, dependsOn: z.array(z.string().min(1)) },
    annotations: writeAnnotations
  },
  remove_block: {
    title: "Remove PlanWeave Block",
    description: "Remove a block and its package prompt file from the selected canvas.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput },
    annotations: writeAnnotations
  },
  add_dependency: {
    title: "Add PlanWeave Dependency",
    description: "Compatibility task dependency tool using manifest-oriented fromTaskId/toTaskId. Prefer add_task_dependency.",
    inputSchema: { ...projectCanvasInput, fromTaskId: z.string().min(1), toTaskId: z.string().min(1) },
    annotations: writeAnnotations
  },
  remove_dependency: {
    title: "Remove PlanWeave Dependency",
    description: "Compatibility task dependency tool using manifest-oriented fromTaskId/toTaskId. Prefer remove_task_dependency.",
    inputSchema: { ...projectCanvasInput, fromTaskId: z.string().min(1), toTaskId: z.string().min(1) },
    annotations: writeAnnotations
  },
  add_task_dependency: {
    title: "Add PlanWeave Task Dependency",
    description: "Add an edge meaning dependentTaskId depends on dependsOnTaskId.",
    inputSchema: semanticTaskDependencyInput,
    annotations: writeAnnotations
  },
  remove_task_dependency: {
    title: "Remove PlanWeave Task Dependency",
    description: "Remove an edge meaning dependentTaskId depends on dependsOnTaskId.",
    inputSchema: semanticTaskDependencyInput,
    annotations: writeAnnotations
  },
  set_task_dependencies: {
    title: "Set PlanWeave Task Dependencies",
    description: "Replace one task's full dependency list using dependsOn.",
    inputSchema: { ...projectCanvasInput, taskId: z.string().min(1), dependsOn: z.array(z.string().min(1)) },
    annotations: writeAnnotations
  },
  bulk_create_tasks: {
    title: "Bulk Create PlanWeave Tasks",
    description: "Create multiple task nodes in one runtime mutation. Returns a lightweight bulk edit summary.",
    inputSchema: { ...projectCanvasInput, tasks: z.array(bulkCreateTaskSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_create_blocks: {
    title: "Bulk Create PlanWeave Blocks",
    description: "Create multiple blocks in one runtime mutation. Returns a lightweight bulk edit summary.",
    inputSchema: { ...projectCanvasInput, blocks: z.array(bulkCreateBlockSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_update_tasks: {
    title: "Bulk Update PlanWeave Tasks",
    description: "Update multiple task titles, prompt markdown bodies, executors, or acceptance criteria in one runtime mutation.",
    inputSchema: { ...projectCanvasInput, updates: z.array(bulkUpdateTaskSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_update_blocks: {
    title: "Bulk Update PlanWeave Blocks",
    description: "Update multiple block titles, prompt markdown bodies, executors, dependencies, parallel policy fields, or review gate fields in one runtime mutation.",
    inputSchema: { ...projectCanvasInput, updates: z.array(bulkUpdateBlockSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_remove_graph_items: {
    title: "Bulk Remove PlanWeave Graph Items",
    description: "Remove task nodes, blocks, task dependency edges, and block dependency references in one runtime mutation.",
    inputSchema: {
      ...projectCanvasInput,
      tasks: z.array(z.string().min(1)).optional(),
      blocks: z.array(z.union([z.string().min(1), z.object(blockRefInput)])).optional(),
      taskDependencyEdges: z.array(taskDependencyEdgeSchema).optional(),
      blockDependencyRefs: z.array(blockDependencyRefSchema).optional()
    },
    annotations: writeAnnotations
  },
  bulk_add_task_dependencies: {
    title: "Bulk Add PlanWeave Task Dependencies",
    description: "Add multiple task dependency edges in one runtime mutation.",
    inputSchema: { ...projectCanvasInput, edges: z.array(taskDependencyEdgeSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_set_task_dependencies: {
    title: "Bulk Set PlanWeave Task Dependencies",
    description: "Replace dependency lists for multiple tasks in one runtime mutation.",
    inputSchema: { ...projectCanvasInput, updates: z.array(taskDependencyUpdateSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_set_block_dependencies: {
    title: "Bulk Set PlanWeave Block Dependencies",
    description: "Replace block dependency lists for multiple blocks.",
    inputSchema: { ...projectCanvasInput, updates: z.array(blockDependencyUpdateSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_apply_review_pipeline: {
    title: "Bulk Apply PlanWeave Review Pipelines",
    description: "Replace review gate steps and package review defaults for multiple tasks after validating all inputs.",
    inputSchema: { ...projectCanvasInput, updates: z.array(reviewPipelineBulkUpdateSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_update_parallel_policy: {
    title: "Bulk Update PlanWeave Parallel Policy",
    description: "Update canvas-level parallel settings and per-block parallel safety/locks after validating all inputs.",
    inputSchema: {
      ...projectCanvasInput,
      canvasPolicy: z.object({
        defaultExecutor: z.string().min(1).nullable().optional(),
        parallelEnabled: z.boolean().optional(),
        maxConcurrent: z.number().int().positive().optional()
      }).optional(),
      blocks: z.array(parallelBlockPolicySchema).optional()
    },
    annotations: writeAnnotations
  },
  apply_canvas_lane_layout: {
    title: "Apply PlanWeave Canvas Lane Layout",
    description: "Generate and save a desktop lane layout for the selected canvas from task dependency depth. Returns a lightweight node count and bounds summary by default.",
    inputSchema: {
      ...projectCanvasInput,
      columnWidth: z.number().positive().optional(),
      rowHeight: z.number().positive().optional(),
      startX: z.number().optional(),
      startY: z.number().optional()
    },
    annotations: writeAnnotations
  },
  add_canvas_dependency: {
    title: "Add PlanWeave Canvas Dependency",
    description: "Add a project graph dependency edge from one canvas to another canvas.",
    inputSchema: { ...projectInput, fromCanvasId: z.string().min(1), toCanvasId: z.string().min(1) },
    annotations: writeAnnotations
  },
  remove_canvas_dependency: {
    title: "Remove PlanWeave Canvas Dependency",
    description: "Remove a project graph dependency edge from one canvas to another canvas.",
    inputSchema: { ...projectInput, fromCanvasId: z.string().min(1), toCanvasId: z.string().min(1) },
    annotations: writeAnnotations
  },
  add_cross_task_dependency: {
    title: "Add PlanWeave Cross-Task Dependency",
    description: "Add a project graph dependency from a task in one canvas to a task in another canvas.",
    inputSchema: {
      ...projectInput,
      fromCanvasId: z.string().min(1),
      fromTaskId: z.string().min(1),
      toCanvasId: z.string().min(1),
      toTaskId: z.string().min(1)
    },
    annotations: writeAnnotations
  },
  remove_cross_task_dependency: {
    title: "Remove PlanWeave Cross-Task Dependency",
    description: "Remove a project graph dependency from a task in one canvas to a task in another canvas.",
    inputSchema: {
      ...projectInput,
      fromCanvasId: z.string().min(1),
      fromTaskId: z.string().min(1),
      toCanvasId: z.string().min(1),
      toTaskId: z.string().min(1)
    },
    annotations: writeAnnotations
  },
  read_prompt: {
    title: "Read PlanWeave Prompt",
    description: "Compatibility source/rendered prompt reader. Prefer read_prompt_source or get_rendered_prompt.",
    inputSchema: {
      ...projectCanvasInput,
      target: z.enum(["project", "task", "block"]),
      taskId: z.string().min(1).optional(),
      blockId: z.string().min(1).optional(),
      blockRef: z.string().min(1).optional(),
      rendered: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  read_prompt_source: {
    title: "Read PlanWeave Prompt Source",
    description: "Read one project, task, or block source prompt by explicit selector.",
    inputSchema: promptSourceInput,
    annotations: readOnlyAnnotations
  },
  get_rendered_prompt: {
    title: "Get PlanWeave Rendered Prompt",
    description: "Render and return one block prompt surface by ref.",
    inputSchema: { ...projectCanvasInput, ref: z.string().min(1), maxBytes: z.number().int().positive().optional() },
    annotations: readOnlyAnnotations
  },
  get_prompt_sources: {
    title: "Get PlanWeave Prompt Sources",
    description: "Return source summaries for one rendered prompt without full source bodies.",
    inputSchema: { ...projectCanvasInput, ref: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  list_package_files: {
    title: "List PlanWeave Package Files",
    description: "List package files with size, hash, owner, preview, and content refs.",
    inputSchema: graphReadInput,
    annotations: readOnlyAnnotations
  },
  read_package_file: {
    title: "Read PlanWeave Package File",
    description: "Read one package file by relative path.",
    inputSchema: { ...projectCanvasInput, path: z.string().min(1), maxBytes: z.number().int().positive().optional() },
    annotations: readOnlyAnnotations
  },
  write_task_prompt: {
    title: "Write PlanWeave Task Prompt",
    description: "Compatibility alias for update_task with promptMarkdown.",
    inputSchema: taskPromptInput,
    annotations: writeAnnotations
  },
  write_block_prompt: {
    title: "Write PlanWeave Block Prompt",
    description: "Compatibility alias for update_block with promptMarkdown.",
    inputSchema: blockPromptInput,
    annotations: writeAnnotations
  },
  write_prompt_source: {
    title: "Write PlanWeave Prompt Source",
    description: "Write one project, task, or block source prompt by explicit selector.",
    inputSchema: promptSourceWriteInput,
    annotations: writeAnnotations
  },
  update_project_prompt: {
    title: "Update PlanWeave Project Prompt",
    description: "Replace the project-level prompt policy markdown.",
    inputSchema: { ...projectInput, markdown: z.string() },
    annotations: writeAnnotations
  },
  refresh_prompts: {
    title: "Refresh PlanWeave Prompts",
    description: "Compatibility alias for refresh_prompts_summary. Returns a bounded summary without markdown.",
    inputSchema: projectCanvasInput,
    annotations: writeAnnotations
  },
  refresh_prompts_summary: {
    title: "Refresh PlanWeave Prompts Summary",
    description: "Render block prompt surfaces for the selected canvas and return counts/refs without markdown.",
    inputSchema: projectCanvasInput,
    annotations: writeAnnotations
  },
  refresh_prompts_full_debug: {
    title: "Refresh PlanWeave Prompts Full Debug",
    description: "Explicit heavy/debug prompt refresh that includes rendered markdown for every block.",
    inputSchema: projectCanvasInput,
    annotations: writeAnnotations
  },
  export_project: {
    title: "Export PlanWeave Project",
    description: "Compatibility alias for export_project_summary. Full project content requires export_project_full_debug.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  export_project_summary: {
    title: "Export PlanWeave Project Summary",
    description: "Export project metadata, project prompt metadata, and package file inventories without file contents.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  export_project_files: {
    title: "Export Selected PlanWeave Project Files",
    description: "Return content only for explicitly requested project prompt or package files.",
    inputSchema: {
      ...projectInput,
      includeProjectPrompt: z.boolean().optional(),
      packageFiles: z.array(z.object({
        canvasId: z.string().nullable().optional(),
        path: z.string().min(1)
      })).optional()
    },
    annotations: readOnlyAnnotations
  },
  export_project_full_debug: {
    title: "Export PlanWeave Project Full Debug",
    description: "Explicit heavy/debug export of project prompt and every package file in the project.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  export_plan_package: {
    title: "Export PlanWeave Package",
    description: "Compatibility alias for export_plan_package_summary by default. includeFiles true remains available for compatibility; prefer explicit full/files tools.",
    inputSchema: { ...projectCanvasInput, includeFiles: z.boolean().optional() },
    annotations: readOnlyAnnotations
  },
  export_plan_package_summary: {
    title: "Export PlanWeave Package Summary",
    description: "Return package file inventory without file contents.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  export_plan_package_files: {
    title: "Export Selected PlanWeave Package Files",
    description: "Return file contents only for explicitly requested package paths.",
    inputSchema: { ...projectCanvasInput, paths: z.array(z.string().min(1)).min(1) },
    annotations: readOnlyAnnotations
  },
  export_plan_package_full: {
    title: "Export PlanWeave Package Full Debug",
    description: "Explicit heavy/debug export of every file in the selected package.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  import_plan_package: {
    title: "Import PlanWeave Package",
    description: "Compatibility file-set import into a managed project. Prefer validate_package_draft, preview_package_import, and import_package_draft for draft roots.",
    inputSchema: {
      name: z.string().min(1),
      files: z.array(packageFileSchema).min(1),
      overwrite: z.boolean().optional()
    },
    annotations: writeAnnotations
  },
  validate_package_draft: {
    title: "Validate PlanWeave Package Draft",
    description: "Validate a package-shaped draft root without writing active project files.",
    inputSchema: { draftRoot: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  preview_package_import: {
    title: "Preview PlanWeave Package Draft Import",
    description: "Dry-run a package draft import and return validation, quality, and file diff summaries.",
    inputSchema: { ...projectCanvasInput, draftRoot: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  import_package_draft: {
    title: "Import PlanWeave Package Draft",
    description: "Apply a validated package draft import transaction. Requires apply: true.",
    inputSchema: { ...projectCanvasInput, draftRoot: z.string().min(1), apply: z.literal(true) },
    annotations: writeAnnotations
  }
};

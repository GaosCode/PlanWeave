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

export const planweaveToolDefinitions: Record<PlanweaveToolName, ToolDefinition> = {
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
  get_plan_package_example: {
    title: "Get PlanWeave Package Example",
    description: "Return a small importable PlanWeave package file set.",
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
    description: "List registered PlanWeave projects with projectId, name, active canvas, and canvas summaries. Use this for lightweight project discovery.",
    annotations: readOnlyAnnotations
  },
  open_project: {
    title: "Open PlanWeave Project",
    description: "Return one registered PlanWeave project's metadata and canvases by projectId.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  init_project: {
    title: "Initialize PlanWeave Project",
    description: "Create or open a managed PlanWeave project by name.",
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
    description: "Return one canvas DAG with task nodes, dependency edges, block previews, and diagnostics. Use this after choosing projectId and canvasId.",
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
    description: "Return a block's prompt, rendered prompt surface, status, dependencies, run/review refs, and review gate metadata.",
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
    description: "Add a task dependency edge from fromTaskId to toTaskId.",
    inputSchema: { ...projectCanvasInput, fromTaskId: z.string().min(1), toTaskId: z.string().min(1) },
    annotations: writeAnnotations
  },
  remove_dependency: {
    title: "Remove PlanWeave Dependency",
    description: "Remove a task dependency edge from fromTaskId to toTaskId.",
    inputSchema: { ...projectCanvasInput, fromTaskId: z.string().min(1), toTaskId: z.string().min(1) },
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
    description: "Read project, task, or block prompt markdown.",
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
  update_project_prompt: {
    title: "Update PlanWeave Project Prompt",
    description: "Replace the project-level prompt policy markdown.",
    inputSchema: { ...projectInput, markdown: z.string() },
    annotations: writeAnnotations
  },
  refresh_prompts: {
    title: "Refresh PlanWeave Prompts",
    description: "Render block prompt surfaces for the selected canvas.",
    inputSchema: projectCanvasInput,
    annotations: writeAnnotations
  },
  export_project: {
    title: "Export PlanWeave Project",
    description: "Export project prompt and all PlanWeave package file sets as structured content.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  export_plan_package: {
    title: "Export PlanWeave Package",
    description: "Export the selected canvas PlanWeave package file set as structured content.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  import_plan_package: {
    title: "Import PlanWeave Package",
    description: "Validate and import a structured PlanWeave package file set into a managed project.",
    inputSchema: {
      name: z.string().min(1),
      files: z.array(packageFileSchema).min(1),
      overwrite: z.boolean().optional()
    },
    annotations: writeAnnotations
  }
};

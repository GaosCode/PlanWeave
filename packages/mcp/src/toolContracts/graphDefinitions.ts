import * as z from "zod/v4";
import {
  blockDependencyRefSchema,
  blockDependencyUpdateSchema,
  blockRefInput,
  blockTypeSchema,
  bulkCreateBlockSchema,
  bulkCreateTaskSchema,
  bulkUpdateBlockSchema,
  bulkUpdateTaskSchema,
  createTaskInputShape,
  graphGatePolicySchema,
  graphHeuristicsSchema,
  graphReadInput,
  graphReviewPolicySchema,
  graphSliceInput,
  parallelBlockPolicySchema,
  projectCanvasInput,
  reviewHookSchema,
  reviewPipelineBulkUpdateSchema,
  semanticTaskDependencyInput,
  taskDependencyEdgeSchema,
  taskDependencyUpdateSchema,
  updateBlockInputShape,
  updateReviewPipelineInputShape,
  updateTaskInputShape
} from "./inputShapes.js";
import {
  readOnlyAnnotations,
  writeAnnotations,
  type PlanweavePartialToolDefinitionRegistry
} from "./types.js";

export const graphToolDefinitions = {
  preview_execution_graph: {
    title: "Preview PlanWeave Execution Graph",
    description:
      "Compatibility alias for get_project_graph. Returns the canvas DAG without per-task promptMarkdown bodies. Prefer get_graph_summary, list_tasks, or get_graph_slice; use read_prompt_source or get_rendered_prompt for prompt bodies, or get_project_graph_full_debug for the heavy full dump.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  get_project_graph: {
    title: "Get PlanWeave Project Graph",
    description:
      "Legacy graph DTO without per-task promptMarkdown bodies (contentIncluded=false). Prefer get_graph_summary, list_tasks, or get_graph_slice for bounded runtime graph inspection. Use read_prompt_source or get_rendered_prompt for prompt bodies, or get_project_graph_full_debug for the heavy full dump.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  get_graph_summary: {
    title: "Get PlanWeave Graph Summary",
    description:
      "Return a bounded runtime graph summary without prompt bodies or Desktop-only DTO fields.",
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
    description:
      "Run runtime graph quality diagnostics for a canvas, including review, gate, dependency, layout, and heuristic rules.",
    inputSchema: {
      ...projectCanvasInput,
      reviewPolicy: graphReviewPolicySchema.optional(),
      gatePolicy: graphGatePolicySchema.optional(),
      heuristics: graphHeuristicsSchema.optional(),
      strict: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  get_task_detail: {
    title: "Get PlanWeave Task Detail",
    description:
      "Return a task's prompt, acceptance criteria, status, executor, and ordered block refs.",
    inputSchema: { ...projectCanvasInput, taskId: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  get_block_detail: {
    title: "Get PlanWeave Block Detail",
    description:
      "Compatibility detail tool. Defaults to legacy full block fields, including prompt markdown and rendered prompt surface. Use view: summary or get_block_summary for bounded output.",
    inputSchema: {
      ...projectCanvasInput,
      ...blockRefInput,
      view: z.enum(["legacy", "summary", "content"]).optional()
    },
    annotations: readOnlyAnnotations
  },
  get_block_summary: {
    title: "Get PlanWeave Block Summary",
    description:
      "Return bounded block metadata without promptMarkdown, promptSurfaceMarkdown, or promptSources.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput },
    annotations: readOnlyAnnotations
  },
  get_review_pipeline: {
    title: "Get PlanWeave Review Pipeline",
    description:
      "Return review gates configured for a task, including presets, pass criteria, feedback format, and prompt markdown.",
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
    description:
      "Update a task title, prompt markdown, or executor. Use promptMarkdown here instead of a separate prompt-writing tool.",
    inputSchema: updateTaskInputShape,
    annotations: writeAnnotations
  },
  update_task_acceptance: {
    title: "Update PlanWeave Task Acceptance",
    description: "Replace a task's acceptance criteria.",
    inputSchema: {
      ...projectCanvasInput,
      taskId: z.string().min(1),
      acceptance: z.array(z.string().min(1)).min(1)
    },
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
    description:
      "Update a block title, prompt markdown, or executor. Use promptMarkdown here instead of a separate prompt-writing tool.",
    inputSchema: updateBlockInputShape,
    annotations: writeAnnotations
  },
  update_canvas_execution_policy: {
    title: "Update PlanWeave Canvas Execution Policy",
    description:
      "Update selected top-level manifest execution policy fields for one canvas. Use this for execution.defaultExecutor and execution.parallel; use update_block_planning for per-block exclusive/locks.",
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
      "Update per-block planning fields: exclusive lock / locks, or review block planning fields. Use update_canvas_execution_policy for the canvas-level parallel enable/maxConcurrent switch. parallelSafe is a deprecated alias for exclusive (inverted).",
    inputSchema: {
      ...projectCanvasInput,
      ...blockRefInput,
      exclusive: z.boolean().optional(),
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
    description:
      "Compatibility alias for set_block_dependencies. Replace a block's intra-task depends_on block id list.",
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
    description:
      "Compatibility task dependency tool using manifest-oriented fromTaskId/toTaskId. Prefer add_task_dependency.",
    inputSchema: {
      ...projectCanvasInput,
      fromTaskId: z.string().min(1),
      toTaskId: z.string().min(1)
    },
    annotations: writeAnnotations
  },
  remove_dependency: {
    title: "Remove PlanWeave Dependency",
    description:
      "Compatibility task dependency tool using manifest-oriented fromTaskId/toTaskId. Prefer remove_task_dependency.",
    inputSchema: {
      ...projectCanvasInput,
      fromTaskId: z.string().min(1),
      toTaskId: z.string().min(1)
    },
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
    inputSchema: {
      ...projectCanvasInput,
      taskId: z.string().min(1),
      dependsOn: z.array(z.string().min(1))
    },
    annotations: writeAnnotations
  },
  bulk_create_tasks: {
    title: "Bulk Create PlanWeave Tasks",
    description:
      "Create multiple task nodes in one runtime mutation. Returns a lightweight bulk edit summary.",
    inputSchema: { ...projectCanvasInput, tasks: z.array(bulkCreateTaskSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_create_blocks: {
    title: "Bulk Create PlanWeave Blocks",
    description:
      "Create multiple blocks in one runtime mutation. Returns a lightweight bulk edit summary.",
    inputSchema: { ...projectCanvasInput, blocks: z.array(bulkCreateBlockSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_update_tasks: {
    title: "Bulk Update PlanWeave Tasks",
    description:
      "Update multiple task titles, prompt markdown bodies, executors, or acceptance criteria in one runtime mutation.",
    inputSchema: { ...projectCanvasInput, updates: z.array(bulkUpdateTaskSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_update_blocks: {
    title: "Bulk Update PlanWeave Blocks",
    description:
      "Update multiple block titles, prompt markdown bodies, executors, dependencies, parallel policy fields, or review gate fields in one runtime mutation.",
    inputSchema: { ...projectCanvasInput, updates: z.array(bulkUpdateBlockSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_remove_graph_items: {
    title: "Bulk Remove PlanWeave Graph Items",
    description:
      "Remove task nodes, blocks, task dependency edges, and block dependency references in one runtime mutation.",
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
    description:
      "Replace review gate steps and package review defaults for multiple tasks after validating all inputs.",
    inputSchema: { ...projectCanvasInput, updates: z.array(reviewPipelineBulkUpdateSchema).min(1) },
    annotations: writeAnnotations
  },
  bulk_update_parallel_policy: {
    title: "Bulk Update PlanWeave Parallel Policy",
    description:
      "Update canvas-level parallel settings and per-block parallel safety/locks after validating all inputs.",
    inputSchema: {
      ...projectCanvasInput,
      canvasPolicy: z
        .object({
          defaultExecutor: z.string().min(1).nullable().optional(),
          parallelEnabled: z.boolean().optional(),
          maxConcurrent: z.number().int().positive().optional()
        })
        .optional(),
      blocks: z.array(parallelBlockPolicySchema).optional()
    },
    annotations: writeAnnotations
  },
  apply_canvas_lane_layout: {
    title: "Apply PlanWeave Canvas Lane Layout",
    description:
      "Generate and save a desktop lane layout for the selected canvas from task dependency depth. Returns a lightweight node count and bounds summary by default.",
    inputSchema: {
      ...projectCanvasInput,
      columnWidth: z.number().positive().optional(),
      rowHeight: z.number().positive().optional(),
      startX: z.number().optional(),
      startY: z.number().optional()
    },
    annotations: writeAnnotations
  }
} satisfies PlanweavePartialToolDefinitionRegistry;

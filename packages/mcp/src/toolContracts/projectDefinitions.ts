import * as z from "zod/v4";
import { projectInput } from "./inputShapes.js";
import {
  readOnlyAnnotations,
  writeAnnotations,
  type PlanweavePartialToolDefinitionRegistry
} from "./types.js";

export const projectToolDefinitions = {
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
    description:
      "List registered PlanWeave projects with projectId, name, active canvas, canvas count, and diagnostics counts.",
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
    description:
      "Return one registered PlanWeave project's metadata and canvas summaries by projectId.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  list_canvases: {
    title: "List PlanWeave Canvases",
    description:
      "List canvas summaries for one registered PlanWeave project without returning task or prompt bodies.",
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
    description:
      "Compatibility alias for open_project. Return a registered PlanWeave project's canvases and high-level summary.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  add_canvas_dependency: {
    title: "Add PlanWeave Canvas Dependency",
    description: "Add a project graph dependency edge from one canvas to another canvas.",
    inputSchema: {
      ...projectInput,
      fromCanvasId: z.string().min(1),
      toCanvasId: z.string().min(1)
    },
    annotations: writeAnnotations
  },
  remove_canvas_dependency: {
    title: "Remove PlanWeave Canvas Dependency",
    description: "Remove a project graph dependency edge from one canvas to another canvas.",
    inputSchema: {
      ...projectInput,
      fromCanvasId: z.string().min(1),
      toCanvasId: z.string().min(1)
    },
    annotations: writeAnnotations
  },
  add_cross_task_dependency: {
    title: "Add PlanWeave Cross-Task Dependency",
    description:
      "Add a project graph dependency from a task in one canvas to a task in another canvas.",
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
    description:
      "Remove a project graph dependency from a task in one canvas to a task in another canvas.",
    inputSchema: {
      ...projectInput,
      fromCanvasId: z.string().min(1),
      fromTaskId: z.string().min(1),
      toCanvasId: z.string().min(1),
      toTaskId: z.string().min(1)
    },
    annotations: writeAnnotations
  }
} satisfies PlanweavePartialToolDefinitionRegistry;

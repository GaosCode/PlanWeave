import * as z from "zod/v4";
import {
  planweaveContextProjectSchema,
  projectGraphEditOutputSchema,
  sanitizedProjectSchema,
  taskCanvasSummarySchema
} from "./outputShapes.js";
import type { PlanweavePartialToolOutputSchemaRegistry } from "./types.js";

export const projectToolOutputSchemas = {
  get_project_tree: {
    generatedAt: z.string(),
    desktopSelection: z.null(),
    guidance: z.array(z.string()),
    projects: z.array(planweaveContextProjectSchema),
    errors: z.array(
      z
        .object({
          scope: z.string(),
          message: z.string()
        })
        .passthrough()
    )
  },
  list_projects: {
    projects: z.array(sanitizedProjectSchema)
  },
  list_projects_summary: {
    projects: z.array(sanitizedProjectSchema)
  },
  open_project: {
    project: sanitizedProjectSchema
  },
  open_project_summary: {
    project: sanitizedProjectSchema
  },
  list_canvases: {
    projectId: z.string(),
    canvases: z.array(taskCanvasSummarySchema)
  },
  create_project: {
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
  add_canvas_dependency: projectGraphEditOutputSchema,
  remove_canvas_dependency: projectGraphEditOutputSchema,
  add_cross_task_dependency: projectGraphEditOutputSchema,
  remove_cross_task_dependency: projectGraphEditOutputSchema
} satisfies PlanweavePartialToolOutputSchemaRegistry;

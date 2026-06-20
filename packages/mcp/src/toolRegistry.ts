import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { planweaveToolOutputSchemas } from "./toolSchemas.js";
import { handlePlanweaveTool } from "./tools.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false
} as const;

export function registerPlanweaveTools(server: McpServer): void {
  server.registerTool(
    "get_schema",
    {
      title: "Get PlanWeave Schema",
      description: "Return PlanWeave runtime schema documents.",
      inputSchema: {
        topic: z.enum(["manifest", "project"]).optional()
      },
      outputSchema: planweaveToolOutputSchemas.get_schema,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("get_schema", args)
  );

  server.registerTool(
    "list_projects",
    {
      title: "List PlanWeave Projects",
      description: "List registered PlanWeave projects.",
      outputSchema: planweaveToolOutputSchemas.list_projects,
      annotations: readOnlyAnnotations
    },
    async () => handlePlanweaveTool("list_projects", undefined)
  );

  server.registerTool(
    "open_project",
    {
      title: "Open PlanWeave Project",
      description: "Open a registered PlanWeave project by projectId.",
      inputSchema: {
        projectId: z.string().min(1)
      },
      outputSchema: planweaveToolOutputSchemas.open_project,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("open_project", args)
  );

  server.registerTool(
    "validate_project",
    {
      title: "Validate PlanWeave Project",
      description: "Validate a registered PlanWeave project by projectId.",
      inputSchema: {
        projectId: z.string().min(1)
      },
      outputSchema: planweaveToolOutputSchemas.validate_project,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("validate_project", args)
  );

  server.registerTool(
    "get_project_overview",
    {
      title: "Get PlanWeave Project Overview",
      description: "Return a registered PlanWeave project's canvases and high-level summary.",
      inputSchema: {
        projectId: z.string().min(1)
      },
      outputSchema: planweaveToolOutputSchemas.get_project_overview,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("get_project_overview", args)
  );

  server.registerTool(
    "get_project_graph",
    {
      title: "Get PlanWeave Project Graph",
      description: "Return the selected canvas DAG with task nodes, dependency edges, block previews, and diagnostics.",
      inputSchema: {
        projectId: z.string().min(1),
        canvasId: z.string().min(1).optional()
      },
      outputSchema: planweaveToolOutputSchemas.get_project_graph,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("get_project_graph", args)
  );

  server.registerTool(
    "get_task_detail",
    {
      title: "Get PlanWeave Task Detail",
      description: "Return a task's prompt, acceptance criteria, status, executor, and ordered block refs.",
      inputSchema: {
        projectId: z.string().min(1),
        canvasId: z.string().min(1).optional(),
        taskId: z.string().min(1)
      },
      outputSchema: planweaveToolOutputSchemas.get_task_detail,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("get_task_detail", args)
  );

  server.registerTool(
    "get_block_detail",
    {
      title: "Get PlanWeave Block Detail",
      description: "Return a block's prompt, rendered prompt surface, status, dependencies, run/review refs, and review gate metadata.",
      inputSchema: {
        projectId: z.string().min(1),
        canvasId: z.string().min(1).optional(),
        blockRef: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        blockId: z.string().min(1).optional()
      },
      outputSchema: planweaveToolOutputSchemas.get_block_detail,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("get_block_detail", args)
  );

  server.registerTool(
    "get_review_pipeline",
    {
      title: "Get PlanWeave Review Pipeline",
      description: "Return review gates configured for a task, including presets, pass criteria, feedback format, and prompt markdown.",
      inputSchema: {
        projectId: z.string().min(1),
        canvasId: z.string().min(1).optional(),
        taskId: z.string().min(1)
      },
      outputSchema: planweaveToolOutputSchemas.get_review_pipeline,
      annotations: readOnlyAnnotations
    },
    async (args) => handlePlanweaveTool("get_review_pipeline", args)
  );
}

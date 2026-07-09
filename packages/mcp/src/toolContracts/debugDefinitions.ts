import { blockRefInput, projectCanvasInput, projectInput } from "./inputShapes.js";
import {
  readOnlyAnnotations,
  writeAnnotations,
  type PlanweavePartialToolDefinitionRegistry
} from "./types.js";

export const debugToolDefinitions = {
  get_project_graph_full_debug: {
    title: "Get PlanWeave Project Graph Full Debug",
    description:
      "Explicit heavy/debug project graph dump that includes every task's full promptMarkdown. Prefer get_graph_summary, list_tasks, get_graph_slice, read_prompt_source, or get_rendered_prompt for normal agent workflows.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  get_block_detail_full_debug: {
    title: "Get PlanWeave Block Detail Full Debug",
    description:
      "Explicit heavy/debug block detail tool that returns source prompt, rendered prompt surface, and prompt sources.",
    inputSchema: { ...projectCanvasInput, ...blockRefInput },
    annotations: readOnlyAnnotations
  },
  refresh_prompts_full_debug: {
    title: "Refresh PlanWeave Prompts Full Debug",
    description:
      "Explicit heavy/debug prompt refresh that includes rendered markdown for every block.",
    inputSchema: projectCanvasInput,
    annotations: writeAnnotations
  },
  export_project_full_debug: {
    title: "Export PlanWeave Project Full Debug",
    description:
      "Explicit heavy/debug export of project prompt and every package file in the project.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  export_plan_package_full: {
    title: "Export PlanWeave Package Full Debug",
    description: "Explicit heavy/debug export of every file in the selected package.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  }
} satisfies PlanweavePartialToolDefinitionRegistry;

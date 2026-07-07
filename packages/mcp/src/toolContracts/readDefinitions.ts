import * as z from "zod/v4";
import { optionalProjectCanvasInput, projectCanvasInput, projectInput, searchResultKindSchema } from "./inputShapes.js";
import { readOnlyAnnotations, type PlanweavePartialToolDefinitionRegistry } from "./types.js";

export const readToolDefinitions = {
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
  validate_execution_readiness: {
    title: "Validate PlanWeave Execution Readiness",
    description: "Check whether a canvas is currently runnable using runtime status and claim readiness.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  }
} satisfies PlanweavePartialToolDefinitionRegistry;

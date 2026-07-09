import * as z from "zod/v4";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";
import { readOnlyAnnotations, type PlanweavePartialToolDefinitionRegistry } from "./types.js";

export const authoringToolDefinitions = {
  list_tool_groups: {
    title: "List PlanWeave Tool Groups",
    description:
      "Return recommended lightweight PlanWeave MCP tool groups and identify legacy compatibility aliases.",
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
    description:
      "Return official package example templates by default; pass template to include the selected file set.",
    inputSchema: { template: z.string().min(1).optional() },
    annotations: readOnlyAnnotations
  },
  get_plan_package_example: {
    title: "Get PlanWeave Package Example",
    description:
      "Compatibility alias that returns the basic importable PlanWeave package file set. Prefer get_plan_package_examples for template discovery.",
    annotations: readOnlyAnnotations
  }
} satisfies PlanweavePartialToolDefinitionRegistry;

import * as z from "zod/v4";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";
import {
  packageExampleSummarySchema,
  packageFileSchema,
  planweaveGuideSchema,
  schemaDocumentSchema,
  schemaTopicSummarySchema,
  toolGroupsSchema
} from "./outputShapes.js";
import type { PlanweavePartialToolOutputSchemaRegistry } from "./types.js";

export const authoringToolOutputSchemas = {
  list_tool_groups: {
    groups: z.array(toolGroupsSchema),
    compatOnlyGroups: z.array(toolGroupsSchema).optional()
  },
  get_schema: {
    topic: z.enum(runtimeSchemaTopicOrder).nullable(),
    topics: z.array(schemaTopicSummarySchema).optional(),
    documents: z.record(z.string(), schemaDocumentSchema)
  },
  get_planweave_guide: {
    guide: planweaveGuideSchema
  },
  get_authoring_rules: {
    rules: z.array(z.string())
  },
  get_plan_package_examples: {
    examples: z.array(packageExampleSummarySchema),
    files: z.array(packageFileSchema).optional(),
    notes: z.array(z.string())
  },
  get_plan_package_example: {
    files: z.array(packageFileSchema),
    notes: z.array(z.string())
  }
} satisfies PlanweavePartialToolOutputSchemaRegistry;

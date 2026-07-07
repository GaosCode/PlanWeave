import * as z from "zod/v4";
import { blockDetailSchema, planPackageExportSchema, projectExportFilesSchema } from "./outputShapes.js";
import type { PlanweavePartialToolOutputSchemaRegistry } from "./types.js";

export const debugToolOutputSchemas = {
  get_block_detail_full_debug: {
    block: blockDetailSchema
  },
  refresh_prompts_full_debug: {
    refresh: z.object({
      prompts: z.array(z.object({
        ref: z.string(),
        path: z.string(),
        markdownBytes: z.number(),
        markdown: z.string()
      }).passthrough()),
      promptCount: z.number(),
      contentIncluded: z.boolean()
    }).passthrough()
  },
  export_project_full_debug: {
    projectExport: projectExportFilesSchema,
    heavy: z.boolean()
  },
  export_plan_package_full: {
    planPackage: planPackageExportSchema,
    heavy: z.boolean()
  }
} satisfies PlanweavePartialToolOutputSchemaRegistry;

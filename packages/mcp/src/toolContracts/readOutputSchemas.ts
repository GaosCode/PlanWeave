import * as z from "zod/v4";
import {
  executionReadinessReportSchema,
  executionStatusSchema,
  readyBlockSchema,
  searchResultSchema,
  validationIssueSchema,
  validationReportSchema
} from "./outputShapes.js";
import type { PlanweavePartialToolOutputSchemaRegistry } from "./types.js";

export const readToolOutputSchemas = {
  validate_project: validationReportSchema.shape,
  explain_validation_errors: {
    ok: z.boolean(),
    issues: z.array(validationIssueSchema.passthrough()),
    explanations: z.array(
      z
        .object({
          code: z.string(),
          severity: z.enum(["error", "warning"]),
          path: z.string().nullable(),
          explanation: z.string(),
          suggestedAction: z.string()
        })
        .passthrough()
    )
  },
  get_status: executionStatusSchema,
  search_project: {
    results: z.array(searchResultSchema),
    diagnostics: z.array(validationIssueSchema)
  },
  list_ready_blocks: {
    readyBlocks: z.array(readyBlockSchema)
  },
  validate_execution_readiness: {
    readiness: executionReadinessReportSchema
  }
} satisfies PlanweavePartialToolOutputSchemaRegistry;

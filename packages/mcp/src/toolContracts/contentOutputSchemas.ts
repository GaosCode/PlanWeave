import * as z from "zod/v4";
import {
  graphEditSchema,
  graphEditOutputSchema,
  packageContentReadSchema,
  packageDraftImportApplySchema,
  packageDraftImportPreviewSchema,
  packageDraftValidationSchema,
  packageFileListSchema,
  passthroughObjectSchema,
  planPackageExportSchema,
  planPackageExportSummarySchema,
  projectExportFilesSchema,
  projectExportSummarySchema,
  promptOutputSchema,
  sanitizedProjectSchema,
  validationReportSchema
} from "./outputShapes.js";
import type { PlanweavePartialToolOutputSchemaRegistry } from "./types.js";

export const contentToolOutputSchemas = {
  get_prompt: {
    projectId: z.string(),
    canvasId: z.string().nullable(),
    ref: z.string(),
    markdown: z.string()
  },
  read_prompt: promptOutputSchema,
  read_prompt_source: {
    prompt: packageContentReadSchema
  },
  get_rendered_prompt: {
    prompt: packageContentReadSchema
  },
  get_prompt_sources: {
    promptSources: z
      .object({
        ref: z.string(),
        sources: z.array(passthroughObjectSchema)
      })
      .passthrough()
  },
  list_package_files: packageFileListSchema,
  read_package_file: {
    file: packageContentReadSchema
  },
  write_task_prompt: graphEditOutputSchema,
  write_block_prompt: graphEditOutputSchema,
  write_prompt_source: {
    markdown: z.string().optional(),
    edit: graphEditSchema.optional()
  },
  update_project_prompt: {
    markdown: z.string()
  },
  refresh_prompts: {
    refresh: z
      .object({
        prompts: z.array(
          z
            .object({
              ref: z.string(),
              path: z.string(),
              markdownBytes: z.number(),
              markdown: z.string().optional()
            })
            .passthrough()
        ),
        promptCount: z.number(),
        contentIncluded: z.boolean()
      })
      .passthrough()
  },
  refresh_prompts_summary: {
    refresh: z
      .object({
        prompts: z.array(
          z
            .object({
              ref: z.string(),
              path: z.string(),
              markdownBytes: z.number(),
              markdown: z.string().optional()
            })
            .passthrough()
        ),
        promptCount: z.number(),
        contentIncluded: z.boolean()
      })
      .passthrough()
  },
  export_project: {
    projectExport: projectExportSummarySchema
  },
  export_project_summary: {
    projectExport: projectExportSummarySchema
  },
  export_project_files: {
    projectExport: projectExportFilesSchema
  },
  export_plan_package: {
    planPackage: planPackageExportSummarySchema
  },
  export_plan_package_summary: {
    planPackage: planPackageExportSummarySchema
  },
  export_plan_package_files: {
    planPackage: planPackageExportSchema
  },
  import_plan_package: {
    project: sanitizedProjectSchema,
    validation: validationReportSchema,
    importedFiles: z.number()
  },
  validate_package_draft: {
    draft: packageDraftValidationSchema
  },
  preview_package_import: {
    preview: packageDraftImportPreviewSchema
  },
  import_package_draft: {
    import: packageDraftImportApplySchema
  }
} satisfies PlanweavePartialToolOutputSchemaRegistry;

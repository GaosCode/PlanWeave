import * as z from "zod/v4";
import {
  blockPromptInput,
  graphReadInput,
  optionalProjectCanvasInput,
  packageFileSchema,
  projectCanvasInput,
  projectInput,
  promptSourceInput,
  promptSourceWriteInput,
  taskPromptInput
} from "./inputShapes.js";
import { readOnlyAnnotations, writeAnnotations, type PlanweavePartialToolDefinitionRegistry } from "./types.js";

export const contentToolDefinitions = {
  get_prompt: {
    title: "Get PlanWeave Rendered Prompt",
    description: "Return the rendered prompt markdown for a block without modifying source prompts.",
    inputSchema: { ...optionalProjectCanvasInput, ref: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  read_prompt: {
    title: "Read PlanWeave Prompt",
    description: "Compatibility source/rendered prompt reader. Prefer read_prompt_source or get_rendered_prompt.",
    inputSchema: {
      ...projectCanvasInput,
      target: z.enum(["project", "task", "block"]),
      taskId: z.string().min(1).optional(),
      blockId: z.string().min(1).optional(),
      blockRef: z.string().min(1).optional(),
      rendered: z.boolean().optional()
    },
    annotations: readOnlyAnnotations
  },
  read_prompt_source: {
    title: "Read PlanWeave Prompt Source",
    description: "Read one project, task, or block source prompt by explicit selector.",
    inputSchema: promptSourceInput,
    annotations: readOnlyAnnotations
  },
  get_rendered_prompt: {
    title: "Get PlanWeave Rendered Prompt",
    description: "Render and return one block prompt surface by ref.",
    inputSchema: { ...projectCanvasInput, ref: z.string().min(1), maxBytes: z.number().int().positive().optional() },
    annotations: readOnlyAnnotations
  },
  get_prompt_sources: {
    title: "Get PlanWeave Prompt Sources",
    description: "Return source summaries for one rendered prompt without full source bodies.",
    inputSchema: { ...projectCanvasInput, ref: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  list_package_files: {
    title: "List PlanWeave Package Files",
    description: "List package files with size, hash, owner, preview, and content refs.",
    inputSchema: graphReadInput,
    annotations: readOnlyAnnotations
  },
  read_package_file: {
    title: "Read PlanWeave Package File",
    description: "Read one package file by relative path.",
    inputSchema: { ...projectCanvasInput, path: z.string().min(1), maxBytes: z.number().int().positive().optional() },
    annotations: readOnlyAnnotations
  },
  write_task_prompt: {
    title: "Write PlanWeave Task Prompt",
    description: "Compatibility alias for update_task with promptMarkdown.",
    inputSchema: taskPromptInput,
    annotations: writeAnnotations
  },
  write_block_prompt: {
    title: "Write PlanWeave Block Prompt",
    description: "Compatibility alias for update_block with promptMarkdown.",
    inputSchema: blockPromptInput,
    annotations: writeAnnotations
  },
  write_prompt_source: {
    title: "Write PlanWeave Prompt Source",
    description: "Write one project, task, or block source prompt by explicit selector.",
    inputSchema: promptSourceWriteInput,
    annotations: writeAnnotations
  },
  update_project_prompt: {
    title: "Update PlanWeave Project Prompt",
    description: "Replace the project-level prompt policy markdown.",
    inputSchema: { ...projectInput, markdown: z.string() },
    annotations: writeAnnotations
  },
  refresh_prompts: {
    title: "Refresh PlanWeave Prompts",
    description: "Compatibility alias for refresh_prompts_summary. Returns a bounded summary without markdown.",
    inputSchema: projectCanvasInput,
    annotations: writeAnnotations
  },
  refresh_prompts_summary: {
    title: "Refresh PlanWeave Prompts Summary",
    description: "Render block prompt surfaces for the selected canvas and return counts/refs without markdown.",
    inputSchema: projectCanvasInput,
    annotations: writeAnnotations
  },
  export_project: {
    title: "Export PlanWeave Project",
    description: "Compatibility alias for export_project_summary. Full project content requires export_project_full_debug.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  export_project_summary: {
    title: "Export PlanWeave Project Summary",
    description: "Export project metadata, project prompt metadata, and package file inventories without file contents.",
    inputSchema: projectInput,
    annotations: readOnlyAnnotations
  },
  export_project_files: {
    title: "Export Selected PlanWeave Project Files",
    description: "Return content only for explicitly requested project prompt or package files.",
    inputSchema: {
      ...projectInput,
      includeProjectPrompt: z.boolean().optional(),
      packageFiles: z.array(z.object({
        canvasId: z.string().nullable().optional(),
        path: z.string().min(1)
      })).optional()
    },
    annotations: readOnlyAnnotations
  },
  export_plan_package: {
    title: "Export PlanWeave Package",
    description: "Compatibility alias for export_plan_package_summary by default. includeFiles true remains available for compatibility; prefer explicit full/files tools.",
    inputSchema: { ...projectCanvasInput, includeFiles: z.boolean().optional() },
    annotations: readOnlyAnnotations
  },
  export_plan_package_summary: {
    title: "Export PlanWeave Package Summary",
    description: "Return package file inventory without file contents.",
    inputSchema: projectCanvasInput,
    annotations: readOnlyAnnotations
  },
  export_plan_package_files: {
    title: "Export Selected PlanWeave Package Files",
    description: "Return file contents only for explicitly requested package paths.",
    inputSchema: { ...projectCanvasInput, paths: z.array(z.string().min(1)).min(1) },
    annotations: readOnlyAnnotations
  },
  import_plan_package: {
    title: "Import PlanWeave Package",
    description: "Compatibility file-set import into a managed project. Prefer validate_package_draft, preview_package_import, and import_package_draft for draft roots.",
    inputSchema: {
      name: z.string().min(1),
      files: z.array(packageFileSchema).min(1),
      overwrite: z.boolean().optional()
    },
    annotations: writeAnnotations
  },
  validate_package_draft: {
    title: "Validate PlanWeave Package Draft",
    description: "Validate a package-shaped draft root without writing active project files.",
    inputSchema: { draftRoot: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  preview_package_import: {
    title: "Preview PlanWeave Package Draft Import",
    description: "Dry-run a package draft import and return validation, quality, and file diff summaries.",
    inputSchema: { ...projectCanvasInput, draftRoot: z.string().min(1) },
    annotations: readOnlyAnnotations
  },
  import_package_draft: {
    title: "Import PlanWeave Package Draft",
    description: "Apply a validated package draft import transaction. Requires apply: true.",
    inputSchema: { ...projectCanvasInput, draftRoot: z.string().min(1), apply: z.literal(true) },
    annotations: writeAnnotations
  }
} satisfies PlanweavePartialToolDefinitionRegistry;

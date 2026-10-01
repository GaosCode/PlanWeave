import { projectExportFilesRequestSchema } from "../toolProjectExportSelection.js";
import {
  fullProjectExport,
  summarizePlanPackage,
  summarizePlanPackageInventory,
  summarizeProjectExport
} from "../toolExportResults.js";
import {
  jsonToolResult,
  nonEmptyString,
  optionalStringArray,
  parsePackageFiles,
  parseProjectArgs,
  parseProjectCanvasArgs,
  readObjectArgs,
  sanitizeProject,
  sanitizeValidationReport
} from "../toolHelpers.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";

export const exportToolHandlers = {
  export_plan_package: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      planPackage:
        record.includeFiles === true
          ? summarizePlanPackage(await gateway.exportPlanPackage(projectId, canvasId))
          : summarizePlanPackageInventory(
              await gateway.exportPlanPackageInventory(projectId, canvasId)
            )
    });
  },
  export_plan_package_summary: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      planPackage: summarizePlanPackageInventory(
        await gateway.exportPlanPackageInventory(projectId, canvasId)
      )
    });
  },
  export_plan_package_files: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const requestedPaths = new Set(requiredStringArray(record.paths, "paths"));
    return jsonToolResult({
      planPackage: await gateway.exportPlanPackageFiles(projectId, [...requestedPaths], canvasId)
    });
  },
  export_plan_package_full: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      planPackage: await gateway.exportPlanPackage(projectId, canvasId),
      heavy: true
    });
  },
  export_project: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult({
      projectExport: summarizeProjectExport(await gateway.exportProjectInventory(projectId))
    });
  },
  export_project_summary: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult({
      projectExport: summarizeProjectExport(await gateway.exportProjectInventory(projectId))
    });
  },
  export_project_files: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId } = parseProjectArgs(record);
    const exported = await gateway.exportProjectFiles(
      projectId,
      projectExportFilesRequestSchema.parse(record)
    );
    return jsonToolResult({
      projectExport: { ...exported, project: sanitizeProject(exported.project) }
    });
  },
  export_project_full_debug: async (args, gateway) => {
    const { projectId } = parseProjectArgs(args);
    return jsonToolResult({
      projectExport: fullProjectExport(await gateway.exportProject(projectId)),
      heavy: true
    });
  },
  import_plan_package: async (args, gateway) => {
    const record = readObjectArgs(args);
    const imported = await gateway.importPlanPackage({
      name: nonEmptyString(record.name, "name"),
      files: parsePackageFiles(record.files),
      overwrite: record.overwrite === true
    });
    return jsonToolResult({
      project: sanitizeProject(imported.project),
      validation: sanitizeValidationReport(imported.validation),
      importedFiles: imported.importedFiles
    });
  }
} satisfies PlanweavePartialToolHandlerRegistry;

function requiredStringArray(value: unknown, field: string): string[] {
  const parsed = optionalStringArray(value, field);
  if (!parsed || parsed.length === 0) {
    throw new Error(`${field} must contain at least one string.`);
  }
  return parsed;
}

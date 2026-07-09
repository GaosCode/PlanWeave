import {
  jsonToolResult,
  nonEmptyString,
  parseProjectCanvasArgs,
  readObjectArgs
} from "../toolHelpers.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";

export const packageImportToolHandlers = {
  validate_package_draft: async (args, gateway) => {
    const record = readObjectArgs(args);
    return jsonToolResult({
      draft: await gateway.validatePackageDraft(nonEmptyString(record.draftRoot, "draftRoot"))
    });
  },
  preview_package_import: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      preview: await gateway.previewPackageDraftImport({
        projectId,
        canvasId,
        draftRoot: nonEmptyString(record.draftRoot, "draftRoot")
      })
    });
  },
  import_package_draft: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    if (record.apply !== true) {
      throw new Error("import_package_draft requires apply: true.");
    }
    return jsonToolResult({
      import: await gateway.importPackageDraft({
        projectId,
        canvasId,
        draftRoot: nonEmptyString(record.draftRoot, "draftRoot")
      })
    });
  }
} satisfies PlanweavePartialToolHandlerRegistry;

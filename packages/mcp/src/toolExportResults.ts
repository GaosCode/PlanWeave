import { sanitizeProject } from "./toolHelpers.js";
import type { ExportedPlanPackage, PlanPackageInventory, RuntimeGateway } from "./toolTypes.js";

export function summarizeRefreshPrompts(
  result: Awaited<ReturnType<RuntimeGateway["refreshPrompts"]>>,
  includeMarkdown: boolean
) {
  return {
    promptCount: result.prompts.length,
    contentIncluded: includeMarkdown,
    prompts: result.prompts.map((prompt) => ({
      ref: prompt.ref,
      path: prompt.path,
      markdownBytes: Buffer.byteLength(prompt.markdown, "utf8"),
      ...(includeMarkdown ? { markdown: prompt.markdown } : {})
    }))
  };
}

export function summarizePlanPackage(planPackage: ExportedPlanPackage) {
  return {
    canvasId: planPackage.canvasId,
    fileCount: planPackage.files.length,
    contentIncluded: true,
    files: planPackage.files.map((file) => ({
      path: file.path,
      encoding: file.encoding,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      content: file.content
    }))
  };
}

export function summarizePlanPackageInventory(planPackage: PlanPackageInventory) {
  return {
    canvasId: planPackage.canvasId,
    fileCount: planPackage.files.length,
    contentIncluded: false,
    files: planPackage.files
  };
}

type ExportedProject = Awaited<ReturnType<RuntimeGateway["exportProject"]>>;

export function summarizeProjectExport(
  exported: Awaited<ReturnType<RuntimeGateway["exportProjectInventory"]>>
) {
  return {
    project: sanitizeProject(exported.project),
    projectPrompt: { contentIncluded: false, markdownBytes: exported.projectPromptBytes },
    planPackages: exported.planPackages.map(summarizePlanPackageInventory)
  };
}

export function fullProjectExport(exported: ExportedProject) {
  return {
    project: sanitizeProject(exported.project),
    projectPromptMarkdown: exported.projectPromptMarkdown,
    planPackages: exported.planPackages
  };
}

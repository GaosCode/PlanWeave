import type { ResolvedProjectExportFile } from "./toolProjectExportSelection.js";
import { sanitizeProject } from "./toolHelpers.js";
import type { ExportedPlanPackage, RuntimeGateway } from "./toolTypes.js";

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

export function summarizePlanPackage(planPackage: ExportedPlanPackage, includeFiles: boolean) {
  return {
    canvasId: planPackage.canvasId,
    fileCount: planPackage.files.length,
    contentIncluded: includeFiles,
    files: planPackage.files.map((file) => ({
      path: file.path,
      encoding: file.encoding,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      ...(includeFiles ? { content: file.content } : {})
    }))
  };
}

type ExportedProject = Awaited<ReturnType<RuntimeGateway["exportProject"]>>;

export function summarizeProjectExport(exported: ExportedProject, includeFiles: boolean) {
  return {
    project: sanitizeProject(exported.project),
    projectPrompt: {
      contentIncluded: false,
      markdownBytes: Buffer.byteLength(exported.projectPromptMarkdown, "utf8")
    },
    planPackages: exported.planPackages.map((planPackage) =>
      summarizePlanPackage(planPackage, includeFiles)
    )
  };
}

export function fullProjectExport(exported: ExportedProject) {
  return {
    project: sanitizeProject(exported.project),
    projectPromptMarkdown: exported.projectPromptMarkdown,
    planPackages: exported.planPackages
  };
}

export function selectProjectExportFiles(
  planPackages: ExportedPlanPackage[],
  requestedFiles: ResolvedProjectExportFile[]
): Array<ExportedPlanPackage & { canvasId: string }> {
  const selectedPackages = new Map<string, ExportedPlanPackage & { canvasId: string }>();
  for (const { canvasId, path } of requestedFiles) {
    const planPackage = planPackages.find((candidate) => candidate.canvasId === canvasId);
    if (!planPackage) {
      throw new Error(`Requested project export canvas not found: ${canvasId}`);
    }
    const file = planPackage.files.find((candidate) => candidate.path === path);
    if (!file) {
      throw new Error(`Requested project export file not found: ${canvasId}:${path}`);
    }
    const selected = selectedPackages.get(canvasId) ?? { canvasId, files: [] };
    selected.files.push(file);
    selectedPackages.set(canvasId, selected);
  }
  return [...selectedPackages.values()];
}

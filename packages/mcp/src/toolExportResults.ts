import { nonEmptyString, sanitizeProject } from "./toolHelpers.js";
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
  exported: ExportedProject,
  record: Record<string, unknown>
) {
  const requestedFiles = Array.isArray(record.packageFiles) ? record.packageFiles : [];
  const selectedPackages = new Map<string, ExportedPlanPackage>();
  for (const item of requestedFiles) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("packageFiles entries must be objects.");
    }
    const request = item as Record<string, unknown>;
    const canvasId =
      request.canvasId === null || request.canvasId === undefined
        ? null
        : nonEmptyString(request.canvasId, "packageFiles[].canvasId");
    const path = nonEmptyString(request.path, "packageFiles[].path");
    const planPackage = exported.planPackages.find((candidate) => candidate.canvasId === canvasId);
    if (!planPackage) {
      throw new Error(`Requested project export canvas not found: ${canvasId ?? "default"}`);
    }
    const file = planPackage.files.find((candidate) => candidate.path === path);
    if (!file) {
      throw new Error(`Requested project export file not found: ${canvasId ?? "default"}:${path}`);
    }
    const key = canvasId ?? "";
    const selected = selectedPackages.get(key) ?? { canvasId, files: [] };
    selected.files.push(file);
    selectedPackages.set(key, selected);
  }
  return {
    project: sanitizeProject(exported.project),
    projectPromptMarkdown:
      record.includeProjectPrompt === true ? exported.projectPromptMarkdown : undefined,
    planPackages: [...selectedPackages.values()]
  };
}

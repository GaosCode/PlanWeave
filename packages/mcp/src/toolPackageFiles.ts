import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManagedProjectId,
  initManagedWorkspace,
  initOrOpenProject,
  openProject,
  readPackageFiles,
  replacePackageFiles,
  resolvePlanweaveHome,
  resolveTaskCanvasWorkspace,
  toArchivePath,
  validatePackage,
  type PackageFileEntry,
  type ValidationReport
} from "@planweave-ai/runtime";
import type { ExportedPlanPackage, ExportedPlanPackageFile } from "./toolTypes.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function exportCanvasPackage(
  projectId: string,
  canvasId?: string
): Promise<ExportedPlanPackage> {
  const project = await openProject({ projectId });
  const selectedCanvasId =
    canvasId ?? project.activeCanvasId ?? project.taskCanvases[0]?.canvasId ?? "default";
  const workspace = await resolveTaskCanvasWorkspace(project.rootPath, selectedCanvasId);
  return {
    canvasId: selectedCanvasId,
    files: await readPackageFiles(workspace.packageDir)
  };
}

export async function importPackageFiles(
  name: string,
  files: ExportedPlanPackageFile[],
  overwrite: boolean
): Promise<{
  project: Awaited<ReturnType<typeof initOrOpenProject>>;
  validation: ValidationReport;
  importedFiles: number;
}> {
  if (files.length === 0) {
    throw new Error("files must contain at least one PlanWeave package file.");
  }
  const normalizedFiles: PackageFileEntry[] = files.map((file) => ({
    path: toArchivePath(file.path),
    content: file.content,
    encoding: file.encoding
  }));
  const tempRoot = await mkdtemp(join(tmpdir(), "planweave-mcp-import-"));
  try {
    const tempProjectRoot = join(tempRoot, "project");
    await mkdir(tempProjectRoot, { recursive: true });
    const tempProject = await initOrOpenProject(tempProjectRoot);
    const tempWorkspace = await resolveTaskCanvasWorkspace(tempProject.rootPath, "default");
    await replacePackageFiles(tempWorkspace.packageDir, normalizedFiles);
    const tempValidation = await validatePackage({ projectRoot: tempProject.rootPath });
    if (!tempValidation.ok) {
      throw new Error(validationMessage("Imported PlanWeave package is invalid", tempValidation));
    }

    const projectId = createManagedProjectId(name);
    const projectFile = join(resolvePlanweaveHome(), "projects", projectId, "project.json");
    if ((await exists(projectFile)) && !overwrite) {
      throw new Error(
        "Imported project already exists. Pass overwrite: true to replace its package files."
      );
    }
    const init = await initManagedWorkspace({ name });
    const workspace = await resolveTaskCanvasWorkspace(init.workspace.rootPath, "default");
    await replacePackageFiles(workspace.packageDir, normalizedFiles);
    const validation = await validatePackage({ projectRoot: workspace.rootPath });
    if (!validation.ok) {
      throw new Error(
        validationMessage("Imported PlanWeave package became invalid after install", validation)
      );
    }
    const project = await openProject({ projectId: init.project.id });
    return { project, validation, importedFiles: normalizedFiles.length };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function validationMessage(prefix: string, report: ValidationReport): string {
  const issues = [...report.errors, ...report.warnings]
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join("; ");
  return issues ? `${prefix}: ${issues}` : prefix;
}

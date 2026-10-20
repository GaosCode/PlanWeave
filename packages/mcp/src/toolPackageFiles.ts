import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importManagedPackage,
  openProject,
  readPackageFiles,
  readPackageFileInventory,
  readSelectedPackageFiles,
  replacePackageFiles,
  resolveTaskCanvasWorkspace,
  toArchivePath,
  type PackageFileEntry,
  type ValidationReport
} from "@planweave-ai/runtime";
import type {
  ExportedPlanPackage,
  ExportedPlanPackageFile,
  PlanPackageInventory
} from "./toolTypes.js";

async function resolveExportCanvas(projectId: string, canvasId?: string) {
  const project = await openProject({ projectId });
  const selectedCanvasId =
    canvasId ?? project.activeCanvasId ?? project.taskCanvases[0]?.canvasId ?? "default";
  const workspace = await resolveTaskCanvasWorkspace(project.rootPath, selectedCanvasId);
  return { canvasId: selectedCanvasId, workspace };
}

export async function exportCanvasPackage(
  projectId: string,
  canvasId?: string
): Promise<ExportedPlanPackage> {
  const resolved = await resolveExportCanvas(projectId, canvasId);
  return {
    canvasId: resolved.canvasId,
    files: await readPackageFiles(resolved.workspace.packageDir)
  };
}

export async function exportCanvasPackageInventory(
  projectId: string,
  canvasId?: string
): Promise<PlanPackageInventory> {
  const resolved = await resolveExportCanvas(projectId, canvasId);
  return {
    canvasId: resolved.canvasId,
    files: await readPackageFileInventory(resolved.workspace.packageDir)
  };
}

export async function exportCanvasSelectedPackage(
  projectId: string,
  paths: string[],
  canvasId?: string
): Promise<ExportedPlanPackage> {
  const resolved = await resolveExportCanvas(projectId, canvasId);
  return {
    canvasId: resolved.canvasId,
    files: await readSelectedPackageFiles(resolved.workspace.packageDir, paths, "last")
  };
}

const PROJECT_EXPORT_CONCURRENCY = 2;

/** Fixed two-canvas batches keep result order and observe all failures before leaving a batch. */
export async function readCanvasExports<T>(
  canvasIds: string[],
  read: (canvasId: string) => Promise<T>
): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < canvasIds.length; index += PROJECT_EXPORT_CONCURRENCY) {
    const batch = await Promise.allSettled(
      canvasIds.slice(index, index + PROJECT_EXPORT_CONCURRENCY).map(read)
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

export async function importPackageFiles(
  name: string,
  files: ExportedPlanPackageFile[],
  overwrite: boolean
): Promise<{
  project: Awaited<ReturnType<typeof openProject>>;
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
    const draftRoot = join(tempRoot, "package");
    await replacePackageFiles(draftRoot, normalizedFiles);
    const { workspace, validation } = await importManagedPackage({ name, draftRoot, overwrite });
    const project = await openProject({ projectId: workspace.id });
    return { project, validation, importedFiles: normalizedFiles.length };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

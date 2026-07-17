import { resolve } from "node:path";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../projectGraph/index.js";
import type { LoadedProjectGraph, ProjectCanvasNode } from "../projectGraph/index.js";
import type { ProjectWorkspace } from "../types.js";

export function canvasCommandFlag(canvasId: string | null): string {
  return canvasId ? ` --canvas ${canvasId}` : "";
}

export function findCurrentProjectCanvasByPackageDir(
  projectWorkspace: ProjectWorkspace,
  currentWorkspace: ProjectWorkspace,
  canvases: Iterable<ProjectCanvasNode>
): ProjectCanvasNode | null {
  for (const canvas of canvases) {
    const canvasWorkspace = projectCanvasWorkspace(projectWorkspace, canvas);
    if (resolve(canvasWorkspace.packageDir) === resolve(currentWorkspace.packageDir)) {
      return canvas;
    }
  }
  return null;
}

export async function commandCanvasIdForWorkspace(
  workspace: ProjectWorkspace
): Promise<string | null> {
  const loaded = await loadProjectGraphForWorkspace(workspace);
  return commandCanvasIdForLoadedProjectGraph(workspace, loaded);
}

export function commandCanvasIdForLoadedProjectGraph(
  workspace: ProjectWorkspace,
  loaded: LoadedProjectGraph
): string | null {
  const canvas = findCurrentProjectCanvasByPackageDir(
    loaded.workspace,
    workspace,
    loaded.manifest.canvases
  );
  if (canvas) {
    if (loaded.source === "project_graph") {
      return canvas.id;
    }
    return canvas.id === "default" ? null : canvas.id;
  }
  return null;
}

export async function canvasCommandFlagForWorkspace(workspace: ProjectWorkspace): Promise<string> {
  return canvasCommandFlag(await commandCanvasIdForWorkspace(workspace));
}

export function canvasCommandFlagForLoadedProjectGraph(
  workspace: ProjectWorkspace,
  loaded: LoadedProjectGraph
): string {
  return canvasCommandFlag(commandCanvasIdForLoadedProjectGraph(workspace, loaded));
}

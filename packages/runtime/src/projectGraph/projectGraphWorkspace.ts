import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadProjectGraph } from "./loadProjectGraph.js";
import type { ProjectCanvasNode } from "./types.js";
import type { ProjectWorkspace } from "../types.js";

function fromWorkspaceRelative(workspace: ProjectWorkspace, path: string): string {
  return isAbsolute(path) ? path : join(workspace.workspaceRoot, path);
}

function assertWorkspaceChild(projectWorkspace: ProjectWorkspace, path: string): void {
  const workspaceRoot = resolve(projectWorkspace.workspaceRoot);
  const target = resolve(path);
  const relativeTarget = relative(workspaceRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Project canvas path '${path}' is outside the PlanWeave workspace.`);
  }
}

export function projectCanvasWorkspace(
  projectWorkspace: ProjectWorkspace,
  canvas: ProjectCanvasNode
): ProjectWorkspace {
  const packageDir = fromWorkspaceRelative(projectWorkspace, canvas.packageDir);
  const stateFile = fromWorkspaceRelative(projectWorkspace, canvas.stateFile);
  const resultsDir = fromWorkspaceRelative(projectWorkspace, canvas.resultsDir);
  assertWorkspaceChild(projectWorkspace, packageDir);
  assertWorkspaceChild(projectWorkspace, stateFile);
  assertWorkspaceChild(projectWorkspace, resultsDir);
  return {
    ...projectWorkspace,
    workspaceRoot: dirname(packageDir),
    packageDir,
    manifestFile: join(packageDir, "manifest.json"),
    stateFile,
    resultsDir
  };
}

export async function resolveProjectCanvasWorkspace(
  projectRoot: string,
  canvasId: string
): Promise<ProjectWorkspace> {
  const { workspace, manifest } = await loadProjectGraph(projectRoot);
  const canvas = manifest.canvases.find((candidate) => candidate.id === canvasId);
  if (!canvas) {
    throw new Error(`Project canvas '${canvasId}' does not exist.`);
  }
  return projectCanvasWorkspace(workspace, canvas);
}

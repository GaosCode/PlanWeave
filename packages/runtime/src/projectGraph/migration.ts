import { isAbsolute, relative } from "node:path";
import type { ProjectWorkspace } from "../types.js";
import type { TaskCanvasRegistry } from "../desktop/canvasRegistry.js";
import type { ProjectGraphManifest } from "./types.js";
import { supportedProjectGraphVersion } from "./types.js";

function toWorkspaceRelative(workspace: ProjectWorkspace, path: string): string {
  if (!isAbsolute(path)) {
    return path.split("\\").join("/");
  }
  return relative(workspace.workspaceRoot, path).split("\\").join("/");
}

export function projectGraphFromLegacyRegistry(registry: TaskCanvasRegistry): ProjectGraphManifest {
  return {
    version: supportedProjectGraphVersion,
    canvases: registry.canvases.map((canvas) => ({
      id: canvas.canvasId,
      type: "canvas",
      title: canvas.name,
      packageDir: canvas.packageDir,
      stateFile: canvas.stateFile,
      resultsDir: canvas.resultsDir
    })),
    edges: [],
    crossTaskEdges: []
  };
}

export function defaultCanvasProjectGraph(workspace: ProjectWorkspace, title: string): ProjectGraphManifest {
  return {
    version: supportedProjectGraphVersion,
    canvases: [
      {
        id: "default",
        type: "canvas",
        title,
        packageDir: toWorkspaceRelative(workspace, workspace.packageDir),
        stateFile: toWorkspaceRelative(workspace, workspace.stateFile),
        resultsDir: toWorkspaceRelative(workspace, workspace.resultsDir)
      }
    ],
    edges: [],
    crossTaskEdges: []
  };
}

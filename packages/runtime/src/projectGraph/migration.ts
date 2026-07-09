import type { TaskCanvasRegistry } from "../desktop/canvasRegistry.js";
import type { ProjectCanvasNode, ProjectGraphManifest } from "./types.js";
import { supportedProjectGraphVersion } from "./types.js";
import {
  canonicalProjectCanvasNode,
  type CanonicalCanvasWorkspacePaths
} from "./canonicalWorkspace.js";

export function projectGraphFromLegacyRegistry(registry: TaskCanvasRegistry): ProjectGraphManifest {
  return {
    version: supportedProjectGraphVersion,
    canvases: registry.canvases.map((canvas) =>
      canvas.canvasId === "default"
        ? canonicalProjectCanvasNode({ id: "default", title: canvas.name })
        : {
            id: canvas.canvasId,
            type: "canvas",
            title: canvas.name,
            packageDir: canvas.packageDir,
            stateFile: canvas.stateFile,
            resultsDir: canvas.resultsDir
          }
    ),
    edges: [],
    crossTaskEdges: []
  };
}

export function defaultCanvasProjectGraph(
  title: string,
  paths?: CanonicalCanvasWorkspacePaths
): ProjectGraphManifest {
  const canvas: ProjectCanvasNode = paths
    ? {
        id: "default",
        type: "canvas",
        title,
        ...paths
      }
    : canonicalProjectCanvasNode({ id: "default", title });
  return {
    version: supportedProjectGraphVersion,
    canvases: [canvas],
    edges: [],
    crossTaskEdges: []
  };
}

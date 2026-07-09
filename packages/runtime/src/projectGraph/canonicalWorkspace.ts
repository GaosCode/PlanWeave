import type { ProjectCanvasNode } from "./types.js";

export type CanonicalCanvasWorkspacePaths = {
  packageDir: string;
  stateFile: string;
  resultsDir: string;
};

export function canonicalCanvasWorkspacePaths(canvasId: string): CanonicalCanvasWorkspacePaths {
  const canvasRoot = `canvases/${canvasId}`;
  return {
    packageDir: `${canvasRoot}/package`,
    stateFile: `${canvasRoot}/state.json`,
    resultsDir: `${canvasRoot}/results`
  };
}

export function canonicalProjectCanvasNode(input: {
  id: string;
  title: string;
  description?: string;
}): ProjectCanvasNode {
  return {
    id: input.id,
    type: "canvas",
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...canonicalCanvasWorkspacePaths(input.id)
  };
}

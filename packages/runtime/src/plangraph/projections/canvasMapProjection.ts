import type { DesktopCanvasGraphViewModel } from "../../desktop/types.js";
import { buildCanvasHealth } from "../../desktop/graph/canvasHealthModel.js";
import type { ValidationIssue } from "../../types.js";
import type { ProjectTodoContext } from "./todoProjection.js";

export type CanvasMapProjection = {
  graphVersion: string;
  viewModel: DesktopCanvasGraphViewModel;
};

function diagnosticsForCanvas(canvasId: string, diagnostics: ValidationIssue[]): ValidationIssue[] {
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.path === canvasId) {
      return true;
    }
    return (
      diagnostic.message.includes(`'${canvasId}'`) ||
      diagnostic.message.includes(`${canvasId}::`) ||
      diagnostic.message.includes(`::${canvasId}`)
    );
  });
}

export function buildCanvasMapProjection(options: {
  graphVersion: string;
  context: ProjectTodoContext;
  projectId: string;
  projectTitle: string;
}): CanvasMapProjection {
  const { graph, canvasesById } = options.context.aggregation;
  const diagnostics = [...graph.diagnostics.errors, ...graph.diagnostics.warnings];
  const canvases = graph.canvasIdsInOrder.map((canvasId) => {
    const canvas = canvasesById.get(canvasId);
    if (!canvas) {
      throw new Error(`Project canvas '${canvasId}' does not exist.`);
    }
    return {
      canvasId: canvas.canvasId,
      title: canvas.canvasName,
      packageDir: canvas.projectCanvas.packageDir,
      executionPolicy: canvas.canvas.executionPolicy,
      diagnostics: [
        ...canvas.canvas.diagnostics,
        ...diagnosticsForCanvas(canvas.canvasId, diagnostics)
      ]
    };
  });
  return {
    graphVersion: options.graphVersion,
    viewModel: {
      projectId: options.projectId,
      projectTitle: options.projectTitle,
      canvases,
      edges: graph.manifest.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        type: edge.type
      })),
      crossTaskEdges: graph.crossTaskEdges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        type: edge.type
      })),
      diagnostics,
      health: buildCanvasHealth(options.context)
    }
  };
}

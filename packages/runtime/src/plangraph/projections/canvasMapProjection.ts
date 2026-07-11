import type {
  DesktopCanvasDiagnosticIssue,
  DesktopCanvasGraphViewModel
} from "../../desktop/types.js";
import { buildCanvasHealth } from "../../desktop/graph/canvasHealthModel.js";
import type { TaskStatus, ValidationIssue } from "../../types.js";
import type { CanvasExecutionSnapshot, ProjectTodoContext } from "./todoProjection.js";

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

function withSeverity(
  diagnostics: ValidationIssue[],
  severity: DesktopCanvasDiagnosticIssue["severity"]
): DesktopCanvasDiagnosticIssue[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic, severity }));
}

function canvasExecutionStatus(snapshot: CanvasExecutionSnapshot): TaskStatus | null {
  if (!snapshot.status) {
    return null;
  }
  const statuses = snapshot.status.tasks.map((task) => task.status);
  if (statuses.includes("in_progress")) {
    return "in_progress";
  }
  if (statuses.length > 0 && statuses.every((status) => status === "implemented")) {
    return "implemented";
  }
  if (statuses.includes("ready")) {
    return "ready";
  }
  return "planned";
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
    const snapshot = options.context.snapshotsByCanvas.get(canvasId);
    if (!canvas) {
      throw new Error(`Project canvas '${canvasId}' does not exist.`);
    }
    if (!snapshot) {
      throw new Error(`Project canvas '${canvasId}' execution snapshot does not exist.`);
    }
    return {
      canvasId: canvas.canvasId,
      title: canvas.canvasName,
      status: canvasExecutionStatus(snapshot),
      packageDir: canvas.projectCanvas.packageDir,
      executionPolicy: canvas.canvas.executionPolicy,
      diagnostics: [
        ...canvas.canvas.diagnostics,
        ...withSeverity(diagnosticsForCanvas(canvas.canvasId, graph.diagnostics.errors), "error"),
        ...withSeverity(
          diagnosticsForCanvas(canvas.canvasId, graph.diagnostics.warnings),
          "warning"
        )
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

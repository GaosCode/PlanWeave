import {
  loadProjectCanvasRuntimeAggregation,
  projectBlockersForTask,
  projectGraphDiagnosticNote,
  runtimeSnapshotFromGraphState,
  type ProjectCanvasRuntimeAggregationContext,
  type ProjectCanvasRuntimeContext,
  type ProjectCanvasRuntimeSnapshot
} from "../../projectGraph/runtimeAggregation.js";
import type { ProjectCanvasNode } from "../../projectGraph/index.js";
import type { ProjectWorkspace, ValidationIssue } from "../../types.js";
import { summarizeTaskCanvasFromPackage } from "../canvasSummaryModel.js";
import type { DesktopTaskCanvasSummary } from "../types.js";

export type ProjectTaskCanvasContext = {
  canvasId: string;
  canvasName: string;
  canvas: DesktopTaskCanvasSummary;
  workspace: ProjectWorkspace;
};

export type ProjectCanvasAggregationCanvas = ProjectTaskCanvasContext & ProjectCanvasRuntimeContext;

export type ProjectCanvasAggregationContext = Omit<
  ProjectCanvasRuntimeAggregationContext,
  "canvases" | "canvasesById"
> & {
  canvases: ProjectCanvasAggregationCanvas[];
  canvasesById: Map<string, ProjectCanvasAggregationCanvas>;
};

export type { ProjectCanvasRuntimeSnapshot };
export { projectBlockersForTask, runtimeSnapshotFromGraphState };

type ProjectCanvasAggregationOptions = {
  loadRuntimeSnapshot?: (
    workspace: ProjectWorkspace,
    canvasId: string
  ) => Promise<ProjectCanvasRuntimeSnapshot>;
};

async function canvasSummary(
  workspace: ProjectWorkspace,
  canvas: ProjectCanvasNode
): Promise<DesktopTaskCanvasSummary> {
  return summarizeTaskCanvasFromPackage({
    canvasId: canvas.id,
    name: canvas.title,
    packageDir: canvas.packageDir,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    workspace
  });
}

export function projectCanvasDiagnosticNote(diagnostic: ValidationIssue): string {
  return projectGraphDiagnosticNote(diagnostic);
}

export async function loadProjectCanvasAggregation(
  projectRootOrWorkspace: string | ProjectWorkspace,
  options: ProjectCanvasAggregationOptions = {}
): Promise<ProjectCanvasAggregationContext> {
  const runtime = await loadProjectCanvasRuntimeAggregation(projectRootOrWorkspace, options);
  const canvases: ProjectCanvasAggregationCanvas[] = [];
  const canvasesById = new Map<string, ProjectCanvasAggregationCanvas>();

  for (const runtimeCanvas of runtime.canvases) {
    const context: ProjectCanvasAggregationCanvas = {
      ...runtimeCanvas,
      canvas: await canvasSummary(runtimeCanvas.workspace, runtimeCanvas.projectCanvas)
    };
    canvases.push(context);
    canvasesById.set(context.canvasId, context);
  }

  return { ...runtime, canvases, canvasesById };
}

function hasPackageDiagnostics(canvas: DesktopTaskCanvasSummary): boolean {
  return canvas.diagnostics.some(
    (diagnostic) =>
      diagnostic.code === "manifest_schema" || diagnostic.code === "manifest_read_failed"
  );
}

export async function mapProjectTaskCanvases<T>(
  projectRoot: string,
  mapper: (context: ProjectTaskCanvasContext, index: number) => Promise<T>
): Promise<T[]> {
  const context = await loadProjectCanvasAggregation(projectRoot);
  const results: T[] = [];
  for (const canvas of context.canvases) {
    if (hasPackageDiagnostics(canvas.canvas)) {
      continue;
    }
    results.push(await mapper(canvas, results.length));
  }
  return results;
}

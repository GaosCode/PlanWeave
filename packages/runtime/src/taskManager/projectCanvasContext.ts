import { compileProjectGraph, loadProjectGraphForWorkspace } from "../projectGraph/index.js";
import type {
  CompiledProjectGraph,
  LoadedProjectGraph,
  ProjectGraphSource,
  ProjectTaskRef
} from "../projectGraph/index.js";
import { findCurrentProjectCanvasByPackageDir } from "./canvasCommandScope.js";
import type { RuntimeContext } from "./runtimeContext.js";

export type ProjectCanvasContext = {
  markdown: string;
  missing: boolean;
  disabledReason: string | null;
};

type ProjectCanvasContextSnapshot = {
  loaded: LoadedProjectGraph;
  graph: CompiledProjectGraph;
};

function projectGraphSourceLabel(source: ProjectGraphSource): string {
  if (source === "project_graph") {
    return "project-graph.json";
  }
  if (source === "legacy_registry") {
    return "legacy desktop/canvases.json";
  }
  return "legacy default canvas";
}

function canvasDisplayName(graph: CompiledProjectGraph, canvasId: string): string {
  const canvas = graph.canvasesById.get(canvasId);
  return canvas ? `${canvas.title} (${canvas.id})` : canvasId;
}

function taskRefDisplayName(ref: ProjectTaskRef): string {
  return `${ref.canvasId}:${ref.taskId}`;
}

function issueDisplayName(issue: { code: string; message: string; path?: string }): string {
  return `${issue.code}${issue.path ? ` [${issue.path}]` : ""}: ${issue.message}`;
}

export async function renderProjectCanvasContext(
  context: RuntimeContext,
  taskId: string
): Promise<ProjectCanvasContext> {
  const loaded = await loadProjectGraphForWorkspace(context.workspace);
  const graph = await compileProjectGraph(loaded);
  return renderProjectCanvasContextFromSnapshot(context, { loaded, graph }, taskId);
}

export function renderProjectCanvasContextFromSnapshot(
  context: RuntimeContext,
  snapshot: ProjectCanvasContextSnapshot,
  taskId: string
): ProjectCanvasContext {
  const { loaded, graph } = snapshot;
  if (graph.diagnostics.errors.length > 0) {
    throw new Error(
      [
        "Project graph is invalid; prompt context cannot be rendered.",
        ...graph.diagnostics.errors.map((error) => `- ${issueDisplayName(error)}`)
      ].join("\n")
    );
  }
  const currentCanvas = findCurrentProjectCanvasByPackageDir(
    loaded.workspace,
    context.workspace,
    graph.canvasIdsInOrder.flatMap((canvasId) => graph.canvasesById.get(canvasId) ?? [])
  );
  const missing = loaded.source !== "project_graph";
  const disabledReason = missing
    ? `Formal project-graph.json is missing; using ${projectGraphSourceLabel(loaded.source)}.`
    : null;
  if (!currentCanvas) {
    return {
      markdown: [
        `- Project graph source: ${projectGraphSourceLabel(loaded.source)}`,
        "- Current canvas: not listed in project graph.",
        ...graph.diagnostics.warnings.map((warning) => `- Warning: ${issueDisplayName(warning)}`)
      ].join("\n"),
      missing,
      disabledReason
    };
  }
  const currentRef = { canvasId: currentCanvas.id, taskId };
  const upstreamCanvases = graph.canvasDependenciesByCanvas.get(currentCanvas.id) ?? [];
  const downstreamCanvases = graph.canvasDependentsByCanvas.get(currentCanvas.id) ?? [];
  const crossTaskBlockers = graph.crossTaskDependencies(currentRef);
  const crossTaskDependents = graph.crossTaskDependents(currentRef);
  return {
    markdown: [
      `- Project graph source: ${projectGraphSourceLabel(loaded.source)}`,
      `- Current canvas: ${currentCanvas.title} (${currentCanvas.id})`,
      `- Upstream canvases: ${upstreamCanvases.length > 0 ? upstreamCanvases.map((canvasId) => canvasDisplayName(graph, canvasId)).join(", ") : "None."}`,
      `- Downstream canvases: ${downstreamCanvases.length > 0 ? downstreamCanvases.map((canvasId) => canvasDisplayName(graph, canvasId)).join(", ") : "None."}`,
      `- Explicit cross-task blockers for ${taskRefDisplayName(currentRef)}: ${crossTaskBlockers.length > 0 ? crossTaskBlockers.map(taskRefDisplayName).join(", ") : "None."}`,
      `- Explicit cross-task dependents for ${taskRefDisplayName(currentRef)}: ${crossTaskDependents.length > 0 ? crossTaskDependents.map(taskRefDisplayName).join(", ") : "None."}`,
      ...graph.diagnostics.warnings.map((warning) => `- Warning: ${issueDisplayName(warning)}`)
    ].join("\n"),
    missing,
    disabledReason
  };
}

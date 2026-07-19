import { resolve } from "node:path";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { ensureStateForManifest, readState } from "../state.js";
import { requireTaskState } from "../taskManager/selectors.js";
import type {
  CompiledExecutionGraph,
  ProjectWorkspace,
  RuntimeState,
  TaskStatus,
  ValidationIssue
} from "../types.js";
import { compileProjectGraph, type ProjectCanvasPackageSnapshot } from "./compileProjectGraph.js";
import { loadProjectGraph, loadProjectGraphForWorkspace } from "./loadProjectGraph.js";
import { projectCanvasWorkspace } from "./projectGraphWorkspace.js";
import type {
  CompiledProjectGraph,
  LoadedProjectGraph,
  ProjectCanvasNode,
  ProjectTaskRef
} from "./types.js";

export type ProjectCanvasRuntimeSnapshot = {
  taskCount: number;
  taskStatusById: Map<string, TaskStatus>;
  complete: boolean;
};

export type ProjectCanvasRuntimeContext = {
  canvasId: string;
  canvasName: string;
  projectCanvas: ProjectCanvasNode;
  runtimeSnapshot: ProjectCanvasRuntimeSnapshot;
  workspace: ProjectWorkspace;
};

export type ProjectCanvasRuntimeAggregationContext = {
  loaded: LoadedProjectGraph;
  graph: CompiledProjectGraph;
  orderedCanvasIds: string[];
  canvases: ProjectCanvasRuntimeContext[];
  canvasesById: Map<string, ProjectCanvasRuntimeContext>;
  runtimeSnapshotsByCanvas: Map<string, ProjectCanvasRuntimeSnapshot>;
  notes: string[];
};

type ProjectCanvasRuntimeAggregationOptions = {
  loadRuntimeSnapshot?: (
    workspace: ProjectWorkspace,
    canvasId: string
  ) => Promise<ProjectCanvasRuntimeSnapshot>;
  runtimeSnapshotsByPackageDir?: ReadonlyMap<string, ProjectCanvasRuntimeSnapshot>;
  packageSnapshotsByPackageDir?: ReadonlyMap<string, ProjectCanvasPackageSnapshot>;
};

function emptyRuntimeSnapshot(): ProjectCanvasRuntimeSnapshot {
  return {
    taskCount: 0,
    taskStatusById: new Map(),
    complete: false
  };
}

export function runtimeSnapshotFromGraphState(
  graph: Pick<CompiledExecutionGraph, "taskNodesInManifestOrder">,
  state: RuntimeState
): ProjectCanvasRuntimeSnapshot {
  const taskStatusById = new Map(
    graph.taskNodesInManifestOrder.map((taskId) => [taskId, requireTaskState(state, taskId).status])
  );
  return {
    taskCount: graph.taskNodesInManifestOrder.length,
    taskStatusById,
    complete: graph.taskNodesInManifestOrder.every(
      (taskId) => requireTaskState(state, taskId).status === "implemented"
    )
  };
}

export function projectGraphDiagnosticNote(diagnostic: ValidationIssue): string {
  return `${diagnostic.code}${diagnostic.path ? ` [${diagnostic.path}]` : ""}: ${diagnostic.message}`;
}

export function projectCanvasExecutionOrder(graph: CompiledProjectGraph): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];

  const visit = (canvasId: string) => {
    if (visited.has(canvasId)) {
      return;
    }
    if (visiting.has(canvasId)) {
      return;
    }
    visiting.add(canvasId);
    for (const dependency of graph.canvasDependenciesByCanvas.get(canvasId) ?? []) {
      visit(dependency);
    }
    visiting.delete(canvasId);
    visited.add(canvasId);
    ordered.push(canvasId);
  };

  for (const canvasId of graph.canvasIdsInOrder) {
    visit(canvasId);
  }
  return ordered;
}

function taskRefLabel(ref: ProjectTaskRef): string {
  return `${ref.canvasId}:${ref.taskId}`;
}

async function canvasRuntimeSnapshot(
  workspace: ProjectWorkspace
): Promise<ProjectCanvasRuntimeSnapshot> {
  const { manifest } = await loadPackage(workspace);
  const graph = compileTaskGraph(manifest);
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  return runtimeSnapshotFromGraphState(graph, state);
}

export async function loadProjectCanvasRuntimeAggregation(
  projectRootOrWorkspace: string | ProjectWorkspace,
  options: ProjectCanvasRuntimeAggregationOptions = {}
): Promise<ProjectCanvasRuntimeAggregationContext> {
  const loaded =
    typeof projectRootOrWorkspace === "string"
      ? await loadProjectGraph(projectRootOrWorkspace)
      : await loadProjectGraphForWorkspace(projectRootOrWorkspace);
  const graph = await compileProjectGraph(loaded, {
    packageSnapshotsByPackageDir: options.packageSnapshotsByPackageDir
  });
  const orderedCanvasIds = projectCanvasExecutionOrder(graph);
  const notes = [
    "Project graph dependencies gate ready queues; canvases without upstream blockers may run in parallel.",
    ...graph.diagnostics.warnings.map(
      (warning) => `Warning: ${projectGraphDiagnosticNote(warning)}`
    ),
    ...graph.diagnostics.errors.map((error) => `Error: ${projectGraphDiagnosticNote(error)}`)
  ];
  const canvases: ProjectCanvasRuntimeContext[] = [];
  const canvasesById = new Map<string, ProjectCanvasRuntimeContext>();
  const runtimeSnapshotsByCanvas = new Map<string, ProjectCanvasRuntimeSnapshot>();

  for (const canvasId of orderedCanvasIds) {
    const projectCanvas = graph.canvasesById.get(canvasId);
    if (!projectCanvas) {
      continue;
    }
    let workspace: ProjectWorkspace;
    try {
      workspace = projectCanvasWorkspace(loaded.workspace, projectCanvas);
    } catch (caught) {
      notes.push(
        `Error: ${canvasId}: ${caught instanceof Error ? caught.message : String(caught)}`
      );
      runtimeSnapshotsByCanvas.set(canvasId, emptyRuntimeSnapshot());
      continue;
    }
    let runtimeSnapshot = emptyRuntimeSnapshot();
    try {
      runtimeSnapshot =
        options.runtimeSnapshotsByPackageDir?.get(resolve(workspace.packageDir)) ??
        (await (options.loadRuntimeSnapshot ?? canvasRuntimeSnapshot)(workspace, canvasId));
    } catch (caught) {
      notes.push(
        `Error: ${canvasId}: ${caught instanceof Error ? caught.message : String(caught)}`
      );
    }
    const context: ProjectCanvasRuntimeContext = {
      canvasId,
      canvasName: projectCanvas.title,
      projectCanvas,
      runtimeSnapshot,
      workspace
    };
    canvases.push(context);
    canvasesById.set(canvasId, context);
    runtimeSnapshotsByCanvas.set(canvasId, runtimeSnapshot);
  }

  return {
    loaded,
    graph,
    orderedCanvasIds,
    canvases,
    canvasesById,
    runtimeSnapshotsByCanvas,
    notes
  };
}

export function projectBlockersForTask(
  context: ProjectCanvasRuntimeAggregationContext,
  canvasId: string,
  taskId: string
): string[] {
  const canvasBlockers = (context.graph.canvasDependenciesByCanvas.get(canvasId) ?? [])
    .filter(
      (dependencyCanvasId) =>
        !(context.runtimeSnapshotsByCanvas.get(dependencyCanvasId)?.complete ?? false)
    )
    .map((dependencyCanvasId) => `canvas:${dependencyCanvasId}`);
  const taskBlockers = context.graph
    .crossTaskDependencies({ canvasId, taskId })
    .filter((dependency) => dependency.canvasId !== canvasId)
    .filter(
      (dependency) =>
        context.runtimeSnapshotsByCanvas
          .get(dependency.canvasId)
          ?.taskStatusById.get(dependency.taskId) !== "implemented"
    )
    .map(taskRefLabel);
  return Array.from(new Set([...canvasBlockers, ...taskBlockers]));
}

export function projectBlockerReasonForTask(
  context: ProjectCanvasRuntimeAggregationContext,
  canvasId: string,
  taskId: string
): string | null {
  const blockers = projectBlockersForTask(context, canvasId, taskId);
  return blockers.length > 0
    ? `Project graph blockers are not complete: ${blockers.join(", ")}.`
    : null;
}

export function currentProjectCanvasForWorkspace(
  context: ProjectCanvasRuntimeAggregationContext,
  workspace: ProjectWorkspace
): ProjectCanvasRuntimeContext | null {
  for (const canvasId of context.graph.canvasIdsInOrder) {
    const canvas = context.canvasesById.get(canvasId);
    if (canvas && resolve(canvas.workspace.packageDir) === resolve(workspace.packageDir)) {
      return canvas;
    }
  }
  return null;
}

import { resolve } from "node:path";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { compileProjectGraph, loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../projectGraph/index.js";
import type { CompiledProjectGraph, ProjectCanvasNode, ProjectTaskRef } from "../projectGraph/index.js";
import { ensureStateForManifest, readState } from "../state.js";
import type { ProjectWorkspace, TaskStatus, ValidationIssue } from "../types.js";
import type { RuntimeContext } from "./runtimeContext.js";

export type ProjectGraphClaimGuard = {
  blockerReasonForTask(taskId: string): string | null;
};

type CanvasRuntimeSnapshot = {
  complete: boolean;
  taskStatusById: Map<string, TaskStatus>;
};

const noProjectGraphBlockers: ProjectGraphClaimGuard = {
  blockerReasonForTask: () => null
};

function issueDisplayName(issue: ValidationIssue): string {
  return `${issue.code}${issue.path ? ` [${issue.path}]` : ""}: ${issue.message}`;
}

function findCurrentProjectCanvas(projectWorkspace: ProjectWorkspace, currentWorkspace: ProjectWorkspace, graph: CompiledProjectGraph): ProjectCanvasNode | null {
  for (const canvasId of graph.canvasIdsInOrder) {
    const canvas = graph.canvasesById.get(canvasId);
    if (!canvas) {
      continue;
    }
    const canvasWorkspace = projectCanvasWorkspace(projectWorkspace, canvas);
    if (resolve(canvasWorkspace.packageDir) === resolve(currentWorkspace.packageDir)) {
      return canvas;
    }
  }
  return null;
}

function taskRefLabel(ref: ProjectTaskRef): string {
  return `${ref.canvasId}:${ref.taskId}`;
}

async function canvasRuntimeSnapshot(projectWorkspace: ProjectWorkspace, canvas: ProjectCanvasNode): Promise<CanvasRuntimeSnapshot> {
  const workspace = projectCanvasWorkspace(projectWorkspace, canvas);
  const { manifest } = await loadPackage(workspace);
  const graph = compileTaskGraph(manifest);
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  const taskStatusById = new Map(graph.taskNodesInManifestOrder.map((taskId) => [taskId, state.tasks[taskId]?.status ?? "planned"]));
  return {
    complete: graph.taskNodesInManifestOrder.every((taskId) => state.tasks[taskId]?.status === "implemented"),
    taskStatusById
  };
}

export async function createProjectGraphClaimGuard(context: RuntimeContext): Promise<ProjectGraphClaimGuard> {
  const loaded = await loadProjectGraphForWorkspace(context.workspace);
  if (loaded.source !== "project_graph") {
    return noProjectGraphBlockers;
  }
  const graph = await compileProjectGraph(loaded);
  if (graph.diagnostics.errors.length > 0) {
    const reason = ["Project graph is invalid; no task canvas work can be claimed.", ...graph.diagnostics.errors.map((error) => `- ${issueDisplayName(error)}`)].join(
      "\n"
    );
    return { blockerReasonForTask: () => reason };
  }
  const currentCanvas = findCurrentProjectCanvas(loaded.workspace, context.workspace, graph);
  if (!currentCanvas) {
    return {
      blockerReasonForTask: () => "Current task canvas is not listed in project-graph.json."
    };
  }
  const snapshotsByCanvas = new Map<string, CanvasRuntimeSnapshot>();
  for (const canvasId of graph.canvasIdsInOrder) {
    const canvas = graph.canvasesById.get(canvasId);
    if (canvas) {
      snapshotsByCanvas.set(canvasId, await canvasRuntimeSnapshot(loaded.workspace, canvas));
    }
  }

  return {
    blockerReasonForTask: (taskId: string) => {
      const canvasBlockers = (graph.canvasDependenciesByCanvas.get(currentCanvas.id) ?? [])
        .filter((dependencyCanvasId) => !(snapshotsByCanvas.get(dependencyCanvasId)?.complete ?? false))
        .map((dependencyCanvasId) => `canvas:${dependencyCanvasId}`);
      const taskBlockers = graph
        .crossTaskDependencies({ canvasId: currentCanvas.id, taskId })
        .filter((dependency) => dependency.canvasId !== currentCanvas.id)
        .filter((dependency) => snapshotsByCanvas.get(dependency.canvasId)?.taskStatusById.get(dependency.taskId) !== "implemented")
        .map(taskRefLabel);
      const blockers = Array.from(new Set([...canvasBlockers, ...taskBlockers]));
      return blockers.length > 0 ? `Project graph blockers are not complete: ${blockers.join(", ")}.` : null;
    }
  };
}

import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { compileTaskGraph } from "./graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "./json.js";
import type { ManifestTaskNode, PlanPackageManifest, RuntimeState, TaskState } from "./types.js";

export function createEmptyState(): RuntimeState {
  return {
    currentTaskId: null,
    tasks: {}
  };
}

export async function readState(stateFile: string): Promise<RuntimeState> {
  try {
    await access(stateFile, constants.R_OK);
  } catch {
    return createEmptyState();
  }
  return readJsonFile<RuntimeState>(stateFile);
}

export async function writeState(stateFile: string, state: RuntimeState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeJsonFile(stateFile, state);
}

export function taskNodes(manifest: PlanPackageManifest): ManifestTaskNode[] {
  return compileTaskGraph(manifest).tasksInManifestOrder;
}

export function dependencyIds(manifest: PlanPackageManifest, taskId: string, graph = compileTaskGraph(manifest)): string[] {
  return graph.dependenciesByTask.get(taskId) ?? [];
}

export function dependenciesSatisfied(
  manifest: PlanPackageManifest,
  state: RuntimeState,
  taskId: string,
  graph = compileTaskGraph(manifest)
): boolean {
  return dependencyIds(manifest, taskId, graph).every((id) => {
    const status = state.tasks[id]?.status;
    return status === "implemented" || status === "verified";
  });
}

export function createDefaultTaskState(
  manifest: PlanPackageManifest,
  state: RuntimeState,
  taskId: string,
  graph = compileTaskGraph(manifest)
): TaskState {
  const blockedBy = dependencyIds(manifest, taskId, graph).filter((id) => {
    const status = state.tasks[id]?.status;
    return status !== "implemented" && status !== "verified";
  });
  return {
    status: blockedBy.length === 0 ? "ready" : "planned",
    claimedBy: null,
    lastRunId: null,
    blockedBy
  };
}

export function ensureStateForManifest(manifest: PlanPackageManifest, state: RuntimeState): RuntimeState {
  const graph = compileTaskGraph(manifest);
  const taskIds = new Set(graph.tasksInManifestOrder.map((task) => task.id));
  const next: RuntimeState = {
    currentTaskId: state.currentTaskId && taskIds.has(state.currentTaskId) ? state.currentTaskId : null,
    tasks: {}
  };

  for (const task of graph.tasksInManifestOrder) {
    next.tasks[task.id] = state.tasks[task.id] ?? createDefaultTaskState(manifest, next, task.id, graph);
    if (
      (next.tasks[task.id].status === "planned" || next.tasks[task.id].status === "ready") &&
      dependenciesSatisfied(manifest, next, task.id, graph)
    ) {
      next.tasks[task.id] = {
        ...next.tasks[task.id],
        status: "ready",
        blockedBy: []
      };
    } else if (next.tasks[task.id].status === "planned" || next.tasks[task.id].status === "ready") {
      next.tasks[task.id] = {
        ...next.tasks[task.id],
        status: "planned",
        blockedBy: dependencyIds(manifest, task.id, graph).filter((id) => {
          const status = next.tasks[id]?.status;
          return status !== "implemented" && status !== "verified";
        })
      };
    }
  }

  if (next.currentTaskId && next.tasks[next.currentTaskId]?.status !== "in_progress") {
    next.currentTaskId = null;
  }

  return next;
}

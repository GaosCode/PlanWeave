import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { loadPackage } from "../../package/loadPackage.js";
import { compileProjectGraph, loadProjectGraph, projectCanvasWorkspace } from "../../projectGraph/index.js";
import type { CompiledProjectGraph, ProjectTaskRef } from "../../projectGraph/index.js";
import { getExecutionStatus } from "../../taskManager/index.js";
import type { PackageWorkspaceRef, ProjectWorkspace, TaskStatus, ValidationIssue } from "../../types.js";
import type { DesktopProjectExecutionPhase, DesktopProjectExecutionPlan, DesktopTodoGroups, DesktopTodoItem } from "../types.js";
import { getBlock } from "./graphHelpers.js";

function emptyTodoGroups(): DesktopTodoGroups {
  return {
    planned: [],
    ready: [],
    in_progress: [],
    completed: [],
    needs_changes: [],
    blocked: [],
    diverged: [],
    implemented: []
  };
}

async function getTodoGroupsForWorkspace(
  projectRoot: PackageWorkspaceRef,
  canvasMeta?: { canvasId: string; canvasName: string }
): Promise<DesktopTodoGroups> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const status = await getExecutionStatus({ projectRoot });
  const taskStatusById = new Map(status.tasks.map((task) => [task.taskId, task.status]));
  const claimHintByRef = new Map(status.claimHints.map((hint) => [hint.ref, hint]));
  const groups = emptyTodoGroups();
  for (const blockStatus of status.blocks) {
    const block = getBlock(graph, blockStatus.ref);
    const taskDependencyBlockers = (graph.taskDependenciesByTask.get(blockStatus.taskId) ?? []).filter((taskId) => taskStatusById.get(taskId) !== "implemented");
    const blockDependencyBlockers = (graph.blockDependenciesByRef.get(blockStatus.ref) ?? []).filter((dependency) => {
      const dependencyStatus = status.blocks.find((candidate) => candidate.ref === dependency)?.status;
      return dependencyStatus !== "completed";
    });
    const dependencyBlockers = [...taskDependencyBlockers, ...blockDependencyBlockers];
    const displayStatus = blockStatus.status === "ready" && dependencyBlockers.length > 0 ? "planned" : blockStatus.status;
    const groupName: keyof DesktopTodoGroups = taskStatusById.get(blockStatus.taskId) === "implemented" ? "implemented" : displayStatus;
    const item: DesktopTodoItem = {
      canvasId: canvasMeta?.canvasId,
      canvasName: canvasMeta?.canvasName,
      ref: blockStatus.ref,
      taskId: blockStatus.taskId,
      blockId: blockStatus.blockId,
      title: block.title,
      status: displayStatus,
      dependencyBlockers,
      parallelSafe: graph.parallelSafeByBlockRef.get(blockStatus.ref) ?? false,
      locks: graph.locksByBlockRef.get(blockStatus.ref) ?? [],
      reviewGate: claimHintByRef.get(blockStatus.ref)?.reviewGate ?? null
    };
    groups[groupName].push(item);
  }
  return groups;
}

function executionPhaseFromGroups(
  phaseIndex: number,
  canvasId: string,
  canvasName: string,
  taskCount: number,
  groups: DesktopTodoGroups,
  projectBlockedReadyCount = 0
): DesktopProjectExecutionPhase {
  const readyQueue = groups.ready;
  return {
    phaseIndex,
    canvasId,
    canvasName,
    taskCount,
    readyQueue,
    parallelReadyQueue: readyQueue.filter((item) => item.parallelSafe),
    sequentialReadyQueue: readyQueue.filter((item) => !item.parallelSafe),
    blockedCount: groups.blocked.length + groups.diverged.length + groups.needs_changes.length + projectBlockedReadyCount,
    inProgressCount: groups.in_progress.length,
    completedCount: groups.completed.length + groups.implemented.length
  };
}

type CanvasExecutionSnapshot = {
  groups: DesktopTodoGroups;
  taskCount: number;
  taskStatusById: Map<string, TaskStatus>;
  complete: boolean;
};

type ProjectTodoContext = {
  graph: CompiledProjectGraph;
  orderedCanvasIds: string[];
  snapshotsByCanvas: Map<string, CanvasExecutionSnapshot>;
  notes: string[];
};

function taskRefLabel(ref: ProjectTaskRef): string {
  return `${ref.canvasId}:${ref.taskId}`;
}

function diagnosticNote(diagnostic: ValidationIssue): string {
  return `${diagnostic.code}${diagnostic.path ? ` [${diagnostic.path}]` : ""}: ${diagnostic.message}`;
}

function projectCanvasExecutionOrder(graph: CompiledProjectGraph): string[] {
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

async function canvasExecutionSnapshot(workspace: ProjectWorkspace, canvasMeta: { canvasId: string; canvasName: string }): Promise<CanvasExecutionSnapshot> {
  const [groups, status] = await Promise.all([
    getTodoGroupsForWorkspace(workspace, canvasMeta),
    getExecutionStatus({ projectRoot: workspace })
  ]);
  const taskStatusById = new Map(status.tasks.map((task) => [task.taskId, task.status]));
  return {
    groups,
    taskCount: status.tasks.length,
    taskStatusById,
    complete: status.tasks.every((task) => task.status === "implemented")
  };
}

function projectBlockersForTask(
  graph: CompiledProjectGraph,
  canvasId: string,
  taskId: string,
  snapshotsByCanvas: Map<string, CanvasExecutionSnapshot>
): string[] {
  const canvasBlockers = (graph.canvasDependenciesByCanvas.get(canvasId) ?? [])
    .filter((dependencyCanvasId) => !(snapshotsByCanvas.get(dependencyCanvasId)?.complete ?? false))
    .map((dependencyCanvasId) => `canvas:${dependencyCanvasId}`);
  const taskBlockers = graph.crossTaskDependencies({ canvasId, taskId })
    .filter((dependency) => dependency.canvasId !== canvasId)
    .filter((dependency) => snapshotsByCanvas.get(dependency.canvasId)?.taskStatusById.get(dependency.taskId) !== "implemented")
    .map(taskRefLabel);
  return Array.from(new Set([...canvasBlockers, ...taskBlockers]));
}

function applyProjectBlockers(
  graph: CompiledProjectGraph,
  canvasId: string,
  groups: DesktopTodoGroups,
  snapshotsByCanvas: Map<string, CanvasExecutionSnapshot>
): { groups: DesktopTodoGroups; blockedReadyCount: number } {
  const next = emptyTodoGroups();
  let blockedReadyCount = 0;
  for (const [groupName, items] of Object.entries(groups) as Array<[keyof DesktopTodoGroups, DesktopTodoItem[]]>) {
    for (const item of items) {
      const projectBlockers = projectBlockersForTask(graph, canvasId, item.taskId, snapshotsByCanvas);
      const nextItem = projectBlockers.length > 0
        ? { ...item, dependencyBlockers: Array.from(new Set([...item.dependencyBlockers, ...projectBlockers])) }
        : item;
      if (groupName === "ready" && projectBlockers.length > 0) {
        next.planned.push({ ...nextItem, status: "planned" });
        blockedReadyCount += 1;
      } else {
        next[groupName].push(nextItem);
      }
    }
  }
  return { groups: next, blockedReadyCount };
}

async function getProjectTodoContext(projectRoot: string): Promise<ProjectTodoContext> {
  const loaded = await loadProjectGraph(projectRoot);
  const graph = await compileProjectGraph(loaded);
  const orderedCanvasIds = projectCanvasExecutionOrder(graph);
  const snapshotsByCanvas = new Map<string, CanvasExecutionSnapshot>();
  const notes = [
    "Project graph dependencies gate ready queues; canvases without upstream blockers may run in parallel.",
    ...graph.diagnostics.warnings.map((warning) => `Warning: ${diagnosticNote(warning)}`),
    ...graph.diagnostics.errors.map((error) => `Error: ${diagnosticNote(error)}`)
  ];

  for (const canvasId of orderedCanvasIds) {
    const canvas = graph.canvasesById.get(canvasId);
    if (!canvas) {
      continue;
    }
    try {
      snapshotsByCanvas.set(
        canvasId,
        await canvasExecutionSnapshot(projectCanvasWorkspace(loaded.workspace, canvas), {
          canvasId,
          canvasName: canvas.title
        })
      );
    } catch (caught) {
      notes.push(`Error: ${canvasId}: ${caught instanceof Error ? caught.message : String(caught)}`);
      snapshotsByCanvas.set(canvasId, {
        groups: emptyTodoGroups(),
        taskCount: 0,
        taskStatusById: new Map(),
        complete: false
      });
    }
  }
  return { graph, orderedCanvasIds, snapshotsByCanvas, notes };
}

export async function getTodoGroups(projectRoot: string): Promise<DesktopTodoGroups> {
  const { graph, orderedCanvasIds, snapshotsByCanvas } = await getProjectTodoContext(projectRoot);
  const groups = emptyTodoGroups();
  for (const canvasId of orderedCanvasIds) {
    const snapshot = snapshotsByCanvas.get(canvasId);
    if (!snapshot) {
      continue;
    }
    const projectAwareGroups = applyProjectBlockers(graph, canvasId, snapshot.groups, snapshotsByCanvas).groups;
    for (const [groupName, items] of Object.entries(projectAwareGroups) as Array<[keyof DesktopTodoGroups, DesktopTodoItem[]]>) {
      groups[groupName].push(...items);
    }
  }
  return groups;
}

export async function getProjectExecutionPlan(projectRoot: string): Promise<DesktopProjectExecutionPlan> {
  const { graph, orderedCanvasIds, snapshotsByCanvas, notes } = await getProjectTodoContext(projectRoot);
  const phases = orderedCanvasIds.flatMap((canvasId, index) => {
    const canvas = graph.canvasesById.get(canvasId);
    const snapshot = snapshotsByCanvas.get(canvasId);
    if (!canvas || !snapshot) {
      return [];
    }
    const { groups, blockedReadyCount } = applyProjectBlockers(graph, canvasId, snapshot.groups, snapshotsByCanvas);
    return [executionPhaseFromGroups(index + 1, canvasId, canvas.title, snapshot.taskCount, groups, blockedReadyCount)];
  });
  return {
    phases,
    readyQueue: phases.flatMap((phase) => phase.readyQueue),
    notes
  };
}

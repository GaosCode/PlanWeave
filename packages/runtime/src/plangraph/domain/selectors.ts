import type {
  BlockRef,
  PlanGraph,
  PlanGraphBlockNode,
  PlanGraphTaskNode,
  TaskId
} from "./types.js";

export function selectTask(graph: PlanGraph, taskId: TaskId): PlanGraphTaskNode | undefined {
  return graph.tasks.get(taskId);
}

export function selectBlock(graph: PlanGraph, blockRef: BlockRef): PlanGraphBlockNode | undefined {
  return graph.blocks.get(blockRef);
}

export function selectTaskBlocks(graph: PlanGraph, taskId: TaskId): PlanGraphBlockNode[] {
  const task = selectTask(graph, taskId);
  if (!task) {
    return [];
  }
  return task.blockRefs
    .map((ref) => graph.blocks.get(ref))
    .filter((block): block is PlanGraphBlockNode => block !== undefined);
}

export function selectUpstreamTasks(graph: PlanGraph, taskId: TaskId): PlanGraphTaskNode[] {
  return graph.edges.flatMap((edge) => {
    if (edge.type !== "taskDependsOn" || edge.fromTaskId !== taskId) {
      return [];
    }
    const task = graph.tasks.get(edge.toTaskId);
    return task ? [task] : [];
  });
}

export function selectDownstreamTasks(graph: PlanGraph, taskId: TaskId): PlanGraphTaskNode[] {
  return graph.edges.flatMap((edge) => {
    if (edge.type !== "taskDependsOn" || edge.toTaskId !== taskId) {
      return [];
    }
    const task = graph.tasks.get(edge.fromTaskId);
    return task ? [task] : [];
  });
}

export function selectCanvasTasks(graph: PlanGraph, canvasId: string | null): PlanGraphTaskNode[] {
  return [...graph.tasks.values()].filter((task) => task.canvasId === canvasId);
}

export function selectBlockedReason(graph: PlanGraph, taskId: TaskId): string | null {
  if (!graph.tasks.has(taskId)) {
    return `Task '${taskId}' does not exist.`;
  }
  const missingDependency = graph.edges.find(
    (edge) =>
      edge.type === "taskDependsOn" && edge.fromTaskId === taskId && !graph.tasks.has(edge.toTaskId)
  );
  if (missingDependency) {
    if (missingDependency.type !== "taskDependsOn") {
      return null;
    }
    return `Task '${taskId}' depends on missing task '${missingDependency.toTaskId}'.`;
  }
  return null;
}

export function selectClaimableTasks(graph: PlanGraph): PlanGraphTaskNode[] {
  return [...graph.tasks.values()].filter(
    (task) => selectUpstreamTasks(graph, task.taskId).length === 0
  );
}

export function selectReviewReadyBlocks(graph: PlanGraph): PlanGraphBlockNode[] {
  return [...graph.blocks.values()].filter(
    (block) => block.type === "review" && block.dependsOn.every((ref) => graph.blocks.has(ref))
  );
}

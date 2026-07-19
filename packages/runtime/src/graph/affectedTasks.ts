import { compileTaskGraph } from "./compileTaskGraph.js";
import { requireMapValue } from "./requireMapValue.js";
import type {
  CompiledTaskGraph,
  ManifestEdge,
  ManifestNode,
  PlanPackageManifest
} from "../types.js";

function nodeChanged(left: ManifestNode | undefined, right: ManifestNode | undefined): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function addTaskDependents(graph: CompiledTaskGraph, taskId: string, affected: Set<string>): void {
  const stack = [taskId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || affected.has(current)) {
      continue;
    }
    affected.add(current);
    stack.push(
      ...requireMapValue(graph.taskDependentsByTask, current, "taskDependentsByTask")
    );
  }
}

function affectedTaskIdsForEdge(
  edge: ManifestEdge,
  graph: CompiledTaskGraph,
  affected: Set<string>
): void {
  if (edge.type === "depends_on") {
    if (graph.tasksById.has(edge.from)) {
      addTaskDependents(graph, edge.from, affected);
    }
    return;
  }
  if (graph.tasksById.has(edge.from)) {
    affected.add(edge.from);
  }
  if (graph.tasksById.has(edge.to)) {
    affected.add(edge.to);
  }
}

export function affectedTaskIdsForManifestChange(
  before: PlanPackageManifest,
  after: PlanPackageManifest,
  beforeGraph: CompiledTaskGraph = compileTaskGraph(before),
  afterGraph: CompiledTaskGraph = compileTaskGraph(after)
): string[] {
  const affected = new Set<string>();
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const nodeIds = new Set([...beforeNodes.keys(), ...afterNodes.keys()]);
  for (const nodeId of nodeIds) {
    const beforeNode = beforeNodes.get(nodeId);
    const afterNode = afterNodes.get(nodeId);
    if (!nodeChanged(beforeNode, afterNode)) {
      continue;
    }
    if (beforeGraph.tasksById.has(nodeId)) {
      addTaskDependents(beforeGraph, nodeId, affected);
    }
    if (afterGraph.tasksById.has(nodeId)) {
      addTaskDependents(afterGraph, nodeId, affected);
    }
    if (!beforeGraph.tasksById.has(nodeId) && !afterGraph.tasksById.has(nodeId)) {
      for (const edge of [...before.edges, ...after.edges].filter(
        (edge) => edge.from === nodeId || edge.to === nodeId
      )) {
        affectedTaskIdsForEdge(edge, beforeGraph, affected);
        affectedTaskIdsForEdge(edge, afterGraph, affected);
      }
    }
  }

  const beforeEdges = new Map(
    before.edges.map((edge) => [`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge])
  );
  const afterEdges = new Map(
    after.edges.map((edge) => [`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge])
  );
  const edgeKeys = new Set([...beforeEdges.keys(), ...afterEdges.keys()]);
  for (const key of edgeKeys) {
    if (beforeEdges.has(key) && afterEdges.has(key)) {
      continue;
    }
    const edge = beforeEdges.get(key) ?? afterEdges.get(key);
    if (!edge) {
      continue;
    }
    affectedTaskIdsForEdge(edge, beforeGraph, affected);
    affectedTaskIdsForEdge(edge, afterGraph, affected);
  }

  return [...affected].filter(
    (taskId) => beforeGraph.tasksById.has(taskId) || afterGraph.tasksById.has(taskId)
  );
}

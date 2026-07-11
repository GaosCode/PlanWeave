import type {
  CompiledExecutionGraph,
  ExecutionGraphSession,
  ManifestBlock,
  ManifestEdge,
  ManifestTaskNode,
  PlanPackageManifest,
  ValidationIssue
} from "../../types.js";
import {
  blockUsesDeprecatedParallelSafe,
  deprecatedParallelSafeWarning,
  effectiveLocksForBlock,
  sharedResourcesForBlock
} from "../parallelLocks.js";

export function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

export function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

function reachable(adjacency: Map<string, string[]>, from: string, to: string): boolean {
  const visited = new Set<string>();
  const stack = [...(adjacency.get(from) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || visited.has(id)) {
      continue;
    }
    if (id === to) {
      return true;
    }
    visited.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  return false;
}

export function refreshReachability(graph: CompiledExecutionGraph): void {
  graph.taskReachable = (from, to) => reachable(graph.taskDependenciesByTask, from, to);
  graph.blockReachable = (fromRef, toRef) =>
    reachable(graph.blockDependenciesByRef, fromRef, toRef);
}

function addBlockIndexes(
  graph: CompiledExecutionGraph,
  taskId: string,
  block: ManifestBlock
): void {
  const ref = blockRef(taskId, block.id);
  graph.blockRefsInManifestOrder.push(ref);
  graph.blocksByRef.set(ref, block);
  graph.blockTaskByRef.set(ref, taskId);
  graph.blocksByTask.get(taskId)?.push(ref);
  graph.blockDependenciesByRef.set(
    ref,
    block.depends_on.map((dependencyId) => blockRef(taskId, dependencyId))
  );
  graph.blockDependentsByRef.set(ref, []);
  for (const dependencyRef of graph.blockDependenciesByRef.get(ref) ?? []) {
    graph.blockDependentsByRef.get(dependencyRef)?.push(ref);
  }
  if (block.type === "review") {
    graph.reviewBlocksByTask.get(taskId)?.push(ref);
  }
  graph.locksByBlockRef.set(ref, effectiveLocksForBlock(block));
  graph.sharedResourcesByBlockRef.set(ref, sharedResourcesForBlock(block));
  if (blockUsesDeprecatedParallelSafe(block)) {
    graph.diagnostics.warnings.push(deprecatedParallelSafeWarning(ref));
  }
}

export function removeTaskIndexes(graph: CompiledExecutionGraph, taskId: string): string[] {
  const removedRefs = graph.blocksByTask.get(taskId) ?? [];
  for (const ref of removedRefs) {
    graph.blocksByRef.delete(ref);
    graph.blockTaskByRef.delete(ref);
    graph.blockDependenciesByRef.delete(ref);
    graph.blockDependentsByRef.delete(ref);
    graph.locksByBlockRef.delete(ref);
    graph.sharedResourcesByBlockRef.delete(ref);
  }
  for (const dependents of graph.blockDependentsByRef.values()) {
    for (let index = dependents.length - 1; index >= 0; index -= 1) {
      if (removedRefs.includes(dependents[index])) {
        dependents.splice(index, 1);
      }
    }
  }
  graph.blockRefsInManifestOrder.splice(
    0,
    graph.blockRefsInManifestOrder.length,
    ...graph.blockRefsInManifestOrder.filter((ref) => !removedRefs.includes(ref))
  );
  graph.nodesById.delete(taskId);
  graph.tasksById.delete(taskId);
  graph.taskNodesInManifestOrder.splice(
    0,
    graph.taskNodesInManifestOrder.length,
    ...graph.taskNodesInManifestOrder.filter((id) => id !== taskId)
  );
  graph.taskDependenciesByTask.delete(taskId);
  graph.taskDependentsByTask.delete(taskId);
  graph.blocksByTask.delete(taskId);
  graph.reviewBlocksByTask.delete(taskId);
  return removedRefs;
}

export function addTaskIndexes(graph: CompiledExecutionGraph, task: ManifestTaskNode): void {
  graph.nodesById.set(task.id, task);
  graph.tasksById.set(task.id, task);
  if (!graph.taskNodesInManifestOrder.includes(task.id)) {
    graph.taskNodesInManifestOrder.push(task.id);
  }
  graph.taskDependenciesByTask.set(task.id, graph.taskDependenciesByTask.get(task.id) ?? []);
  graph.taskDependentsByTask.set(task.id, graph.taskDependentsByTask.get(task.id) ?? []);
  graph.blocksByTask.set(task.id, []);
  graph.reviewBlocksByTask.set(task.id, []);
  for (const block of task.blocks) {
    addBlockIndexes(graph, task.id, block);
  }
}

export function validateTaskBlocks(task: ManifestTaskNode): ValidationIssue[] {
  const diagnostics: ValidationIssue[] = [];
  const blockIds = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const block of task.blocks) {
    if (blockIds.has(block.id)) {
      diagnostics.push(
        issue(
          "block_id_duplicate",
          `Block id '${block.id}' is duplicated in task '${task.id}'.`,
          `nodes.${task.id}.blocks`
        )
      );
    }
    blockIds.add(block.id);
    adjacency.set(block.id, []);
  }
  for (const block of task.blocks) {
    for (const dependencyId of block.depends_on) {
      if (!blockIds.has(dependencyId)) {
        diagnostics.push(
          issue(
            "block_dependency_missing",
            `Block '${task.id}#${block.id}' depends on missing block '${dependencyId}' in the same task node.`,
            blockRef(task.id, block.id)
          )
        );
        continue;
      }
      if (dependencyId === block.id || reachable(adjacency, dependencyId, block.id)) {
        diagnostics.push(
          issue(
            "block_depends_on_cycle",
            `Block dependency cycle detected in task '${task.id}'.`,
            `nodes.${task.id}.blocks`
          )
        );
        continue;
      }
      adjacency.get(block.id)?.push(dependencyId);
    }
  }
  return diagnostics;
}

export function sameEdge(left: ManifestEdge, right: ManifestEdge): boolean {
  return left.from === right.from && left.to === right.to && left.type === right.type;
}

export function alignGraphOrder(
  graph: CompiledExecutionGraph,
  manifest: PlanPackageManifest
): void {
  graph.taskNodesInManifestOrder.splice(
    0,
    graph.taskNodesInManifestOrder.length,
    ...manifest.nodes
      .filter((node): node is ManifestTaskNode => node.type === "task")
      .map((node) => node.id)
  );
  graph.blockRefsInManifestOrder.splice(
    0,
    graph.blockRefsInManifestOrder.length,
    ...manifest.nodes
      .filter((node): node is ManifestTaskNode => node.type === "task")
      .flatMap((node) => node.blocks.map((block) => blockRef(node.id, block.id)))
  );
}

export function validateEdge(graph: CompiledExecutionGraph, edge: ManifestEdge): ValidationIssue[] {
  const from = graph.nodesById.get(edge.from);
  const to = graph.nodesById.get(edge.to);
  if (!from) {
    return [
      issue("edge_from_missing", `Edge references missing from node '${edge.from}'.`, "edges")
    ];
  }
  if (!to) {
    return [issue("edge_to_missing", `Edge references missing to node '${edge.to}'.`, "edges")];
  }
  if (edge.type === "depends_on" && (from.type !== "task" || to.type !== "task")) {
    return [issue("depends_on_non_task", "depends_on edges must connect task nodes.", "edges")];
  }
  if (
    edge.type === "depends_on" &&
    (edge.from === edge.to || graph.taskReachable(edge.to, edge.from))
  ) {
    return [
      issue(
        "depends_on_cycle",
        `Task dependency cycle detected by edge '${edge.from}' -> '${edge.to}'.`,
        "edges"
      )
    ];
  }
  return [];
}

export function addEdgeIndexes(graph: CompiledExecutionGraph, edge: ManifestEdge): void {
  graph.taskDependenciesByTask.get(edge.from)?.push(edge.to);
  graph.taskDependentsByTask.get(edge.to)?.push(edge.from);
}

export function removeEdgeIndexes(graph: CompiledExecutionGraph, edge: ManifestEdge): void {
  const remove = (items: string[] | undefined, value: string) => {
    if (!items) {
      return;
    }
    const index = items.indexOf(value);
    if (index >= 0) {
      items.splice(index, 1);
    }
  };
  remove(graph.taskDependenciesByTask.get(edge.from), edge.to);
  remove(graph.taskDependentsByTask.get(edge.to), edge.from);
}

export function rebuildEdgeIndexes(
  graph: CompiledExecutionGraph,
  manifest: PlanPackageManifest
): void {
  for (const taskId of graph.taskNodesInManifestOrder) {
    graph.taskDependenciesByTask.set(taskId, []);
    graph.taskDependentsByTask.set(taskId, []);
  }
  for (const edge of manifest.edges) {
    if (graph.nodesById.has(edge.from) && graph.nodesById.has(edge.to)) {
      addEdgeIndexes(graph, edge);
    }
  }
}

export function removeDirtyRefs(session: ExecutionGraphSession, refs: string[]): void {
  for (const ref of refs) {
    session.dirtyPromptRefs.delete(ref);
  }
}

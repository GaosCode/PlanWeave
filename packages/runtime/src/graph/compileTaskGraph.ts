import {
  capturePackagePrompts,
  packagePromptOwners,
  originalPromptPaths,
  resolvePackagePromptTargets
} from "../package/promptInventory.js";
import { edgeTypes } from "../types.js";
import type {
  CompiledExecutionGraph,
  EdgeType,
  ManifestBlock,
  ManifestEdge,
  ManifestNode,
  ManifestTaskNode,
  PlanPackageManifest,
  ValidationIssue
} from "../types.js";
import { parseBlockRef } from "./blockRef.js";
import { requireMapValue } from "./requireMapValue.js";
import { sharedResourcesForBlock } from "./sharedResources.js";
import { requiredCapabilitiesForBlock } from "./requiredCapabilities.js";

export { parseBlockRef } from "./blockRef.js";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

function edgeKey(edge: ManifestEdge): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
}

function findCycle(adjacency: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const id of adjacency.keys()) {
    if (visited.has(id)) {
      continue;
    }
    const stack: Array<{ id: string; nextIndex: number }> = [{ id, nextIndex: 0 }];
    visiting.add(id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = requireMapValue(adjacency, frame.id, "adjacency");
      const next = neighbors[frame.nextIndex];
      if (next === undefined) {
        visiting.delete(frame.id);
        visited.add(frame.id);
        stack.pop();
        continue;
      }
      frame.nextIndex += 1;
      if (!adjacency.has(next)) {
        continue;
      }
      if (visiting.has(next)) {
        const cycleStart = stack.findIndex((item) => item.id === next);
        return stack
          .slice(cycleStart)
          .map((item) => item.id)
          .concat(next);
      }
      if (!visited.has(next)) {
        visiting.add(next);
        stack.push({ id: next, nextIndex: 0 });
      }
    }
  }
  return null;
}

function reachable(adjacency: Map<string, string[]>, from: string, to: string): boolean {
  if (!adjacency.has(from) || !adjacency.has(to)) {
    return false;
  }
  const visited = new Set<string>();
  const stack = [...requireMapValue(adjacency, from, "adjacency")];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || visited.has(id)) {
      continue;
    }
    if (id === to) {
      return true;
    }
    visited.add(id);
    stack.push(...requireMapValue(adjacency, id, "adjacency"));
  }
  return false;
}

function validateEdgeEndpointTypes(
  edge: ManifestEdge,
  from: ManifestNode,
  to: ManifestNode
): ValidationIssue[] {
  if (edge.type === "depends_on") {
    return from.type === "task" && to.type === "task"
      ? []
      : [issue("depends_on_non_task", "depends_on edges must connect task nodes.", "edges")];
  }
  return [issue("edge_type_invalid", `Edge type '${edge.type}' is not supported.`, "edges")];
}

export function compileTaskGraph(manifest: PlanPackageManifest): CompiledExecutionGraph {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodesById = new Map<string, ManifestNode>();
  const tasksById = new Map<string, ManifestTaskNode>();
  const taskNodesInManifestOrder: string[] = [];
  const duplicateNodeIds = new Set<string>();

  for (const node of manifest.nodes) {
    if (nodesById.has(node.id)) {
      duplicateNodeIds.add(node.id);
    }
    nodesById.set(node.id, node);
    if (node.type === "task") {
      tasksById.set(node.id, node);
      taskNodesInManifestOrder.push(node.id);
    }
  }
  for (const id of duplicateNodeIds) {
    errors.push(issue("node_id_duplicate", `Node id '${id}' is duplicated.`, "nodes"));
  }

  const taskDependenciesByTask = new Map<string, string[]>();
  const taskDependentsByTask = new Map<string, string[]>();
  const taskAdjacency = new Map<string, string[]>();
  const blockRefsInManifestOrder: string[] = [];
  const blocksByRef = new Map<string, ManifestBlock>();
  const blockTaskByRef = new Map<string, string>();
  const blocksByTask = new Map<string, string[]>();
  const blockDependenciesByRef = new Map<string, string[]>();
  const blockDependentsByRef = new Map<string, string[]>();
  const reviewBlocksByTask = new Map<string, string[]>();
  const sharedResourcesByBlockRef = new Map<string, string[]>();
  const requiredCapabilitiesByBlockRef = new Map<string, string[]>();

  for (const taskId of taskNodesInManifestOrder) {
    taskDependenciesByTask.set(taskId, []);
    taskDependentsByTask.set(taskId, []);
    taskAdjacency.set(taskId, []);
    blocksByTask.set(taskId, []);
    reviewBlocksByTask.set(taskId, []);

    const task = requireMapValue(tasksById, taskId, "tasksById");
    const blockIds = new Set<string>();
    for (const block of task.blocks) {
      const ref = blockRef(taskId, block.id);
      if (blockIds.has(block.id)) {
        errors.push(
          issue(
            "block_id_duplicate",
            `Block id '${block.id}' is duplicated in task '${taskId}'.`,
            `nodes.${taskId}.blocks`
          )
        );
      }
      blockIds.add(block.id);
      blockRefsInManifestOrder.push(ref);
      blocksByRef.set(ref, block);
      blockTaskByRef.set(ref, taskId);
      requireMapValue(blocksByTask, taskId, "blocksByTask").push(ref);
      blockDependenciesByRef.set(ref, []);
      blockDependentsByRef.set(ref, []);
      if (block.type === "review") {
        requireMapValue(reviewBlocksByTask, taskId, "reviewBlocksByTask").push(ref);
      }
      sharedResourcesByBlockRef.set(ref, sharedResourcesForBlock(block));
      requiredCapabilitiesByBlockRef.set(ref, requiredCapabilitiesForBlock(block));
    }
  }

  for (const taskId of taskNodesInManifestOrder) {
    const knownBlockIds = new Set(
      requireMapValue(blocksByTask, taskId, "blocksByTask").map((ref) => parseBlockRef(ref).blockId)
    );
    for (const block of requireMapValue(tasksById, taskId, "tasksById").blocks) {
      const ref = blockRef(taskId, block.id);
      for (const dependencyBlockId of block.depends_on) {
        if (!knownBlockIds.has(dependencyBlockId)) {
          errors.push(
            issue(
              "block_dependency_missing",
              `Block '${ref}' depends on missing block '${dependencyBlockId}' in the same task node.`,
              ref
            )
          );
          continue;
        }
        const dependencyRef = blockRef(taskId, dependencyBlockId);
        requireMapValue(blockDependenciesByRef, ref, "blockDependenciesByRef").push(dependencyRef);
        requireMapValue(blockDependentsByRef, dependencyRef, "blockDependentsByRef").push(ref);
      }
    }
  }

  const edgesByType = new Map<EdgeType, ManifestEdge[]>();
  for (const type of edgeTypes) {
    edgesByType.set(type, []);
  }
  const outgoingEdgesByNode = new Map<string, ManifestEdge[]>();
  const incomingEdgesByNode = new Map<string, ManifestEdge[]>();
  for (const node of manifest.nodes) {
    outgoingEdgesByNode.set(node.id, []);
    incomingEdgesByNode.set(node.id, []);
  }
  const seenEdges = new Set<string>();
  for (const edge of manifest.edges) {
    const key = edgeKey(edge);
    if (seenEdges.has(key)) {
      errors.push(
        issue(
          "edge_duplicate",
          `Edge '${edge.from} --${edge.type}--> ${edge.to}' is duplicated.`,
          "edges"
        )
      );
    }
    seenEdges.add(key);
    if (edgesByType.has(edge.type)) {
      requireMapValue(edgesByType, edge.type, "edgesByType").push(edge);
    }
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from) {
      errors.push(
        issue("edge_from_missing", `Edge references missing from node '${edge.from}'.`, "edges")
      );
    }
    if (!to) {
      errors.push(
        issue("edge_to_missing", `Edge references missing to node '${edge.to}'.`, "edges")
      );
    }
    if (!from || !to) {
      continue;
    }
    requireMapValue(outgoingEdgesByNode, edge.from, "outgoingEdgesByNode").push(edge);
    requireMapValue(incomingEdgesByNode, edge.to, "incomingEdgesByNode").push(edge);
    const endpointIssues = validateEdgeEndpointTypes(edge, from, to);
    if (endpointIssues.length > 0) {
      errors.push(...endpointIssues);
      continue;
    }
    requireMapValue(taskDependenciesByTask, edge.from, "taskDependenciesByTask").push(edge.to);
    requireMapValue(taskDependentsByTask, edge.to, "taskDependentsByTask").push(edge.from);
    requireMapValue(taskAdjacency, edge.from, "taskAdjacency").push(edge.to);
  }

  const taskCycle = findCycle(taskAdjacency);
  if (taskCycle) {
    errors.push(
      issue(
        "depends_on_cycle",
        `Task dependency cycle detected: ${taskCycle.join(" -> ")}.`,
        "edges"
      )
    );
  }
  const blockCycle = findCycle(blockDependenciesByRef);
  if (blockCycle) {
    errors.push(
      issue(
        "block_depends_on_cycle",
        `Block dependency cycle detected: ${blockCycle.join(" -> ")}.`,
        "blocks"
      )
    );
  }

  for (const taskId of taskNodesInManifestOrder) {
    const blocks = requireMapValue(blocksByTask, taskId, "blocksByTask");
    if (
      !blocks.some(
        (ref) => requireMapValue(blocksByRef, ref, "blocksByRef").type === "implementation"
      )
    ) {
      errors.push(
        issue(
          "task_without_implementation_block",
          `Task '${taskId}' must contain an implementation block.`,
          taskId
        )
      );
    }
  }

  return {
    nodesById,
    taskNodesInManifestOrder,
    tasksById,
    taskDependenciesByTask,
    taskDependentsByTask,
    blockRefsInManifestOrder,
    blocksByRef,
    blockTaskByRef,
    blocksByTask,
    blockDependenciesByRef,
    blockDependentsByRef,
    reviewBlocksByTask,
    sharedResourcesByBlockRef,
    requiredCapabilitiesByBlockRef,
    diagnostics: { errors, warnings },
    taskReachable: (from, to) => reachable(taskAdjacency, from, to),
    blockReachable: (fromRef, toRef) => reachable(blockDependenciesByRef, fromRef, toRef)
  };
}

export { promptReferenceKey } from "../package/promptInventory.js";

export async function compilePackageGraph(
  manifest: PlanPackageManifest,
  packageDir: string,
  options: { validatePromptContents?: boolean } = {}
): Promise<CompiledExecutionGraph> {
  const owners = packagePromptOwners(manifest);
  const targets = await resolvePackagePromptTargets(packageDir, owners.keys(), {
    includeOrphans: true,
    manifestPaths: originalPromptPaths(owners)
  });
  const captured = await capturePackagePrompts(
    targets,
    options.validatePromptContents === false ? "stat" : "content",
    owners
  );
  return compilePackageGraphFromPrompts(
    manifest,
    owners,
    targets.paths.keys(),
    captured.diagnostics
  );
}

export function compilePackageGraphFromPrompts(
  manifest: PlanPackageManifest,
  owners: ReturnType<typeof packagePromptOwners>,
  paths: Iterable<string>,
  diagnostics: ValidationIssue[]
): CompiledExecutionGraph {
  const graph = compileTaskGraph(manifest);
  graph.diagnostics.errors.push(...diagnostics);
  for (const path of paths) {
    if (!owners.has(path)) {
      graph.diagnostics.warnings.push(
        issue("stale_prompt_reference", `Prompt '${path}' is not referenced.`, path)
      );
    }
  }
  return graph;
}

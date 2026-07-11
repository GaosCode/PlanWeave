import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { PackagePathError, resolvePackagePath } from "../package/resolvePackagePath.js";
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
import {
  blockUsesDeprecatedParallelSafe,
  deprecatedParallelSafeWarning,
  effectiveLocksForBlock,
  sharedResourcesForBlock
} from "./parallelLocks.js";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function nodeFileErrorSummary(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return error instanceof Error && error.message ? error.message : "unknown error";
}

async function listMarkdownFiles(
  packageDir: string,
  root: string,
  errors: ValidationIssue[]
): Promise<string[]> {
  const promptPath = relative(packageDir, root) || ".";
  let entries;
  try {
    entries = await optionalReaddir(root, { withFileTypes: true });
  } catch (error) {
    errors.push(
      issue(
        "prompt_directory_read_failed",
        `Prompt directory '${promptPath}' could not be read: ${nodeFileErrorSummary(error)}.`,
        promptPath
      )
    );
    return [];
  }
  if (!entries) {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(packageDir, path, errors)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

export function parseBlockRef(ref: string): { taskId: string; blockId: string } {
  const parts = ref.split("#");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid block ref '${ref}'. Expected '<task-id>#<block-id>'.`);
  }
  return { taskId: parts[0], blockId: parts[1] };
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
      const next = adjacency.get(frame.id)?.[frame.nextIndex];
      if (!next) {
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
  const locksByBlockRef = new Map<string, string[]>();
  const sharedResourcesByBlockRef = new Map<string, string[]>();

  for (const taskId of taskNodesInManifestOrder) {
    taskDependenciesByTask.set(taskId, []);
    taskDependentsByTask.set(taskId, []);
    taskAdjacency.set(taskId, []);
    blocksByTask.set(taskId, []);
    reviewBlocksByTask.set(taskId, []);

    const task = tasksById.get(taskId);
    const blockIds = new Set<string>();
    for (const block of task?.blocks ?? []) {
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
      blocksByTask.get(taskId)?.push(ref);
      blockDependenciesByRef.set(ref, []);
      blockDependentsByRef.set(ref, []);
      if (block.type === "review") {
        reviewBlocksByTask.get(taskId)?.push(ref);
      }
      locksByBlockRef.set(ref, effectiveLocksForBlock(block));
      sharedResourcesByBlockRef.set(ref, sharedResourcesForBlock(block));
      if (blockUsesDeprecatedParallelSafe(block)) {
        warnings.push(deprecatedParallelSafeWarning(ref));
      }
    }
  }

  for (const taskId of taskNodesInManifestOrder) {
    const knownBlockIds = new Set(
      (blocksByTask.get(taskId) ?? []).map((ref) => parseBlockRef(ref).blockId)
    );
    for (const block of tasksById.get(taskId)?.blocks ?? []) {
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
        blockDependenciesByRef.get(ref)?.push(dependencyRef);
        blockDependentsByRef.get(dependencyRef)?.push(ref);
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
    edgesByType.get(edge.type)?.push(edge);
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
    outgoingEdgesByNode.get(edge.from)?.push(edge);
    incomingEdgesByNode.get(edge.to)?.push(edge);
    const endpointIssues = validateEdgeEndpointTypes(edge, from, to);
    if (endpointIssues.length > 0) {
      errors.push(...endpointIssues);
      continue;
    }
    taskDependenciesByTask.get(edge.from)?.push(edge.to);
    taskDependentsByTask.get(edge.to)?.push(edge.from);
    taskAdjacency.get(edge.from)?.push(edge.to);
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
    const blocks = blocksByTask.get(taskId) ?? [];
    if (!blocks.some((ref) => blocksByRef.get(ref)?.type === "implementation")) {
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
    locksByBlockRef,
    sharedResourcesByBlockRef,
    diagnostics: { errors, warnings },
    taskReachable: (from, to) => reachable(taskAdjacency, from, to),
    blockReachable: (fromRef, toRef) => reachable(blockDependenciesByRef, fromRef, toRef)
  };
}

async function validatePromptReference(
  packageDir: string,
  prompt: string,
  errors: ValidationIssue[]
): Promise<void> {
  try {
    const promptPath = await resolvePackagePath(packageDir, prompt);
    const promptMetadata = await optionalStat(promptPath);
    if (!promptMetadata) {
      errors.push(issue("prompt_missing", `Prompt file '${prompt}' does not exist.`, prompt));
    }
  } catch (error) {
    if (error instanceof PackagePathError) {
      errors.push(issue(error.code, error.message, prompt));
    } else {
      errors.push(
        issue(
          "prompt_access_failed",
          `Prompt file '${prompt}' could not be checked: ${nodeFileErrorSummary(error)}.`,
          prompt
        )
      );
    }
  }
}

export async function compilePackageGraph(
  manifest: PlanPackageManifest,
  packageDir: string,
  options: { validatePromptContents?: boolean } = {}
): Promise<CompiledExecutionGraph> {
  const graph = compileTaskGraph(manifest);
  const validatePromptContents = options.validatePromptContents ?? true;
  const referencedPrompts = new Set<string>();

  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = graph.tasksById.get(taskId);
    if (!task) {
      continue;
    }
    referencedPrompts.add(task.prompt);
    await validatePromptReference(packageDir, task.prompt, graph.diagnostics.errors);
    for (const block of task.blocks) {
      referencedPrompts.add(block.prompt);
      await validatePromptReference(packageDir, block.prompt, graph.diagnostics.errors);
    }
  }

  for (const file of await listMarkdownFiles(
    packageDir,
    join(packageDir, "nodes"),
    graph.diagnostics.errors
  )) {
    const promptPath = relative(packageDir, file);
    if (!referencedPrompts.has(promptPath)) {
      graph.diagnostics.warnings.push(
        issue("stale_prompt_reference", `Prompt '${promptPath}' is not referenced.`, promptPath)
      );
      continue;
    }
    if (!validatePromptContents) {
      continue;
    }
    try {
      await readFile(file, "utf8");
    } catch (error) {
      graph.diagnostics.errors.push(
        issue(
          "prompt_read_failed",
          `Prompt '${promptPath}' could not be read: ${nodeFileErrorSummary(error)}.`,
          promptPath
        )
      );
    }
  }

  return graph;
}

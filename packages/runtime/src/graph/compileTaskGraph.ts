import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative } from "node:path";
import { PackagePathError, resolvePackagePath } from "../package/resolvePackagePath.js";
import { findPromptSectionBoundaryIssues, hasUserSection } from "../prompt/sections.js";
import { edgeTypes } from "../types.js";
import type {
  ClaimBuckets,
  CompiledTaskGraph,
  EdgeType,
  GraphContext,
  ManifestEdge,
  ManifestNode,
  ManifestTaskNode,
  PlanPackageManifest,
  RuntimeState,
  TaskStatus,
  ValidationIssue
} from "../types.js";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listMarkdownFiles(path)));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function emptyGraphContext(): GraphContext {
  return {
    goals: [],
    requirements: [],
    constraints: [],
    decisions: [],
    components: [],
    conflicts: [],
    supersedes: [],
    supersededBy: []
  };
}

function addUniqueNode(nodes: ManifestNode[], node: ManifestNode): void {
  if (!nodes.some((item) => item.id === node.id)) {
    nodes.push(node);
  }
}

function edgeKey(edge: ManifestEdge): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
}

function isDependencySatisfied(status: TaskStatus | undefined): boolean {
  return status === "implemented" || status === "verified";
}

export function validateEdgeEndpointTypes(edge: ManifestEdge, from: ManifestNode, to: ManifestNode): ValidationIssue[] {
  if (edge.type === "depends_on") {
    return from.type === "task" && to.type === "task"
      ? []
      : [issue("depends_on_non_task", "depends_on edges must connect task nodes.", "edges")];
  }

  if (edge.type === "implements") {
    return from.type === "task" && (to.type === "goal" || to.type === "requirement")
      ? []
      : [issue("edge_endpoint_type_invalid", "implements edges must connect task -> goal/requirement.", "edges")];
  }

  if (edge.type === "constrained_by") {
    return from.type === "task" && to.type === "constraint"
      ? []
      : [issue("edge_endpoint_type_invalid", "constrained_by edges must connect task -> constraint.", "edges")];
  }

  if (edge.type === "touches") {
    return from.type === "task" && to.type === "component"
      ? []
      : [issue("edge_endpoint_type_invalid", "touches edges must connect task -> component.", "edges")];
  }

  if (edge.type === "conflicts_with") {
    return to.type === "risk" || to.type === "constraint" || to.type === "task"
      ? []
      : [issue("edge_endpoint_type_invalid", "conflicts_with edges must point to risk/constraint/task.", "edges")];
  }

  return [];
}

function findDependsOnCycle(dependencyAdjacency: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const id of dependencyAdjacency.keys()) {
    if (visited.has(id)) {
      continue;
    }

    const stack: Array<{ id: string; nextIndex: number }> = [{ id, nextIndex: 0 }];
    visiting.add(id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = dependencyAdjacency.get(frame.id)?.[frame.nextIndex];

      if (!next) {
        visiting.delete(frame.id);
        visited.add(frame.id);
        stack.pop();
        continue;
      }

      frame.nextIndex += 1;
      if (!dependencyAdjacency.has(next)) {
        continue;
      }
      if (visiting.has(next)) {
        const cycleStart = stack.findIndex((item) => item.id === next);
        return stack.slice(cycleStart).map((item) => item.id).concat(next);
      }
      if (!visited.has(next)) {
        visiting.add(next);
        stack.push({ id: next, nextIndex: 0 });
      }
    }
  }
  return null;
}

export function compileTaskGraph(manifest: PlanPackageManifest): CompiledTaskGraph {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodesById = new Map<string, ManifestNode>();
  const duplicateNodeIds = new Set<string>();

  for (const node of manifest.nodes) {
    if (nodesById.has(node.id)) {
      duplicateNodeIds.add(node.id);
    }
    nodesById.set(node.id, node);
  }

  for (const id of duplicateNodeIds) {
    errors.push(issue("node_id_duplicate", `Node id '${id}' is duplicated.`, "nodes"));
  }

  const tasksInManifestOrder = manifest.nodes.filter((node): node is ManifestTaskNode => node.type === "task");
  const taskIds = new Set(tasksInManifestOrder.map((task) => task.id));
  const manifestOrderByTask = new Map<string, number>();
  const dependenciesByTask = new Map<string, string[]>();
  const dependentsByTask = new Map<string, string[]>();
  const contextEdgesByTask = new Map<string, ManifestEdge[]>();
  const locksByTask = new Map<string, Set<string>>();
  const dependencyAdjacency = new Map<string, string[]>();
  const reverseDependencyAdjacency = new Map<string, string[]>();

  for (const [index, task] of tasksInManifestOrder.entries()) {
    manifestOrderByTask.set(task.id, index);
    dependenciesByTask.set(task.id, []);
    dependentsByTask.set(task.id, []);
    contextEdgesByTask.set(task.id, []);
    locksByTask.set(task.id, new Set(task.parallel.locks));
    dependencyAdjacency.set(task.id, []);
    reverseDependencyAdjacency.set(task.id, []);
  }

  const edgesByType = new Map<EdgeType, ManifestEdge[]>();
  for (const type of edgeTypes) {
    edgesByType.set(type, []);
  }
  const seenEdges = new Set<string>();
  const duplicateEdges = new Set<string>();
  for (const edge of manifest.edges) {
    const key = edgeKey(edge);
    if (seenEdges.has(key)) {
      duplicateEdges.add(key);
    }
    seenEdges.add(key);
  }
  for (const key of duplicateEdges) {
    const [from, type, to] = key.split("\u0000");
    errors.push(issue("edge_duplicate", `Edge '${from} --${type}--> ${to}' is duplicated.`, "edges"));
  }

  const outgoingEdgesByNode = new Map<string, ManifestEdge[]>();
  const incomingEdgesByNode = new Map<string, ManifestEdge[]>();
  for (const node of manifest.nodes) {
    outgoingEdgesByNode.set(node.id, []);
    incomingEdgesByNode.set(node.id, []);
  }

  for (const edge of manifest.edges) {
    edgesByType.get(edge.type)?.push(edge);

    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from) {
      errors.push(issue("edge_from_missing", `Edge references missing from node '${edge.from}'.`, "edges"));
    }
    if (!to) {
      errors.push(issue("edge_to_missing", `Edge references missing to node '${edge.to}'.`, "edges"));
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

    if (edge.type === "depends_on") {
      dependenciesByTask.get(edge.from)?.push(edge.to);
      dependentsByTask.get(edge.to)?.push(edge.from);
      dependencyAdjacency.get(edge.from)?.push(edge.to);
      reverseDependencyAdjacency.get(edge.to)?.push(edge.from);
    } else {
      if (taskIds.has(edge.from)) {
        contextEdgesByTask.get(edge.from)?.push(edge);
      }
      if (taskIds.has(edge.to)) {
        contextEdgesByTask.get(edge.to)?.push(edge);
      }
    }
  }

  const cycle = findDependsOnCycle(dependencyAdjacency);
  if (cycle) {
    errors.push(issue("depends_on_cycle", `depends_on cycle detected: ${cycle.join(" -> ")}.`, "edges"));
  }

  for (const edge of edgesByType.get("conflicts_with") ?? []) {
    warnings.push(issue("conflict_edge_warning", `Conflict edge present: ${edge.from} conflicts with ${edge.to}.`, "edges"));
  }

  for (const task of tasksInManifestOrder) {
    const hasGoalOrRequirement = (contextEdgesByTask.get(task.id) ?? []).some((edge) => {
      const otherId = edge.from === task.id ? edge.to : edge.from;
      const other = nodesById.get(otherId);
      return other?.type === "goal" || other?.type === "requirement";
    });
    if (!hasGoalOrRequirement) {
      warnings.push(issue("task_without_goal_or_requirement", `Task '${task.id}' has no goal or requirement relationship.`, task.id));
    }
  }

  for (const node of manifest.nodes) {
    if (node.type === "task") {
      continue;
    }
    const hasIncoming = (incomingEdgesByNode.get(node.id) ?? []).length > 0;
    const hasOutgoing = (outgoingEdgesByNode.get(node.id) ?? []).length > 0;
    if (!hasIncoming && !hasOutgoing) {
      warnings.push(issue("orphan_context_node", `Context node '${node.id}' has no graph relationships.`, node.id));
    }
  }

  const reachableMemo = new Map<string, Set<string>>();

  function reachable(from: string, to: string): boolean {
    if (!dependencyAdjacency.has(from) || !dependencyAdjacency.has(to)) {
      return false;
    }
    const memo = reachableMemo.get(from);
    if (memo) {
      return memo.has(to);
    }

    const reachableSet = new Set<string>();
    const visited = new Set<string>();
    const stack = [...(dependencyAdjacency.get(from) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || visited.has(id)) {
        continue;
      }
      visited.add(id);
      reachableSet.add(id);
      for (const next of dependencyAdjacency.get(id) ?? []) {
        stack.push(next);
      }
    }
    reachableMemo.set(from, reachableSet);
    return reachableSet.has(to);
  }

  function explainBlocked(taskId: string, state: RuntimeState): string[] {
    return (dependenciesByTask.get(taskId) ?? [])
      .filter((id) => !isDependencySatisfied(state.tasks[id]?.status))
      .map((id) => `${id}: ${state.tasks[id]?.status ?? "unknown"}`);
  }

  function blockedReasonByTask(state: RuntimeState): Map<string, string[]> {
    const reasons = new Map<string, string[]>();
    for (const task of tasksInManifestOrder) {
      reasons.set(task.id, explainBlocked(task.id, state));
    }
    return reasons;
  }

  function taskDependenciesSatisfied(taskId: string, state: RuntimeState): boolean {
    return (dependenciesByTask.get(taskId) ?? []).every((id) => isDependencySatisfied(state.tasks[id]?.status));
  }

  function claimBuckets(state: RuntimeState): ClaimBuckets {
    const buckets: ClaimBuckets = { needsChanges: [], ready: [] };
    for (const task of tasksInManifestOrder) {
      const status = state.tasks[task.id]?.status;
      if (!taskDependenciesSatisfied(task.id, state)) {
        continue;
      }
      if (status === "needs_changes") {
        buckets.needsChanges.push(task);
      } else if (status === "ready" || status === "planned") {
        buckets.ready.push(task);
      }
    }
    return buckets;
  }

  function relatedContext(taskId: string): GraphContext {
    const context = emptyGraphContext();
    for (const edge of contextEdgesByTask.get(taskId) ?? []) {
      const otherId = edge.from === taskId ? edge.to : edge.from;
      const other = nodesById.get(otherId);
      if (!other) {
        continue;
      }
      if (edge.type === "conflicts_with") {
        addUniqueNode(context.conflicts, other);
        continue;
      }
      if (edge.type === "supersedes") {
        if (edge.from === taskId) {
          addUniqueNode(context.supersedes, other);
        } else {
          addUniqueNode(context.supersededBy, other);
        }
        continue;
      }
      if (edge.type === "constrained_by" || other.type === "constraint") {
        addUniqueNode(context.constraints, other);
        continue;
      }
      if (edge.type === "touches" || other.type === "component") {
        addUniqueNode(context.components, other);
        continue;
      }
      if (other.type === "goal") {
        addUniqueNode(context.goals, other);
      } else if (other.type === "requirement") {
        addUniqueNode(context.requirements, other);
      } else if (other.type === "decision") {
        addUniqueNode(context.decisions, other);
      }
    }
    return context;
  }

  return {
    nodesById,
    tasksInManifestOrder,
    manifestOrderByTask,
    edgesByType,
    outgoingEdgesByNode,
    incomingEdgesByNode,
    dependenciesByTask,
    dependentsByTask,
    contextEdgesByTask,
    locksByTask,
    dependencyAdjacency,
    reverseDependencyAdjacency,
    diagnostics: { errors, warnings },
    reachable,
    invalidateReachability: () => reachableMemo.clear(),
    blockedReasonByTask,
    claimBuckets,
    explainBlocked,
    relatedContext
  };
}

export async function compilePackageGraph(manifest: PlanPackageManifest, packageDir: string): Promise<CompiledTaskGraph> {
  const graph = compileTaskGraph(manifest);
  const referencedPrompts = new Set<string>();

  for (const task of graph.tasksInManifestOrder) {
    referencedPrompts.add(task.prompt);
    let promptPath: string;
    try {
      promptPath = await resolvePackagePath(packageDir, task.prompt);
    } catch (error) {
      if (error instanceof PackagePathError) {
        graph.diagnostics.errors.push(issue(error.code, error.message, task.prompt));
        continue;
      }
      throw error;
    }
    if (!(await exists(promptPath))) {
      graph.diagnostics.errors.push(issue("prompt_missing", `Prompt Surface file for '${task.id}' does not exist.`, task.prompt));
      continue;
    }
    const prompt = await readFile(promptPath, "utf8");
    const boundaryIssues = findPromptSectionBoundaryIssues(prompt, task.prompt);
    graph.diagnostics.errors.push(...boundaryIssues);
    if (!hasUserSection(prompt, "task-body")) {
      graph.diagnostics.errors.push(
        issue("task_body_missing", `Prompt Surface for '${task.id}' is missing user section 'task-body'.`, task.prompt)
      );
    }
  }

  for (const file of await listMarkdownFiles(join(packageDir, "nodes"))) {
    const promptPath = relative(packageDir, file);
    if (!referencedPrompts.has(promptPath)) {
      graph.diagnostics.warnings.push(
        issue("stale_prompt_reference", `Prompt Surface '${promptPath}' is not referenced by any task.`, promptPath)
      );
    }
  }

  return graph;
}

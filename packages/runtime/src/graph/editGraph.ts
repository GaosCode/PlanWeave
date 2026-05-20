import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { PackagePathError, resolvePackagePath } from "../package/resolvePackagePath.js";
import { findPromptSectionBoundaryIssues, getPromptSection, replacePromptSection } from "../prompt/sections.js";
import { manifestSchema } from "../schema/manifest.js";
import { compileTaskGraph, validateEdgeEndpointTypes } from "./compileTaskGraph.js";
import type {
  CompiledTaskGraph,
  GraphEditResult,
  ManifestEdge,
  ManifestNode,
  ManifestTaskNode,
  PlanPackageManifest,
  ValidationIssue
} from "../types.js";

export type PackageFileChange =
  | { kind: "manifest"; before: PlanPackageManifest; after: PlanPackageManifest; graph?: CompiledTaskGraph }
  | { kind: "global-prompt"; manifest: PlanPackageManifest; graph?: CompiledTaskGraph }
  | { kind: "prompt"; manifest: PlanPackageManifest; taskId: string; graph?: CompiledTaskGraph };

export type PackageChangeImpact = GraphEditResult & {
  fullRefresh: boolean;
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function validateManifestForWrite(manifest: PlanPackageManifest): { ok: true; manifest: PlanPackageManifest } | { ok: false; diagnostics: ValidationIssue[] } {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((item) =>
        issue("manifest_schema_invalid", item.message, item.path.length > 0 ? item.path.join(".") : "manifest.json")
      )
    };
  }
  return { ok: true, manifest: parsed.data };
}

function isTaskNode(node: ManifestNode): node is ManifestTaskNode {
  return node.type === "task";
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function sameEdge(left: ManifestEdge, right: ManifestEdge): boolean {
  return left.from === right.from && left.to === right.to && left.type === right.type;
}

function edgeKey(edge: ManifestEdge): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
}

function sameNodeContent(left: ManifestNode, right: ManifestNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findDuplicateNodeIds(nodes: ManifestNode[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      duplicates.add(node.id);
    }
    seen.add(node.id);
  }
  return [...duplicates];
}

function findDuplicateEdges(edges: ManifestEdge[]): ManifestEdge[] {
  const seen = new Set<string>();
  const duplicates = new Map<string, ManifestEdge>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) {
      duplicates.set(key, edge);
    }
    seen.add(key);
  }
  return [...duplicates.values()];
}

function findDependsOnCycleInAdjacency(adjacency: Map<string, string[]>): string[] | null {
  const inDegree = new Map<string, number>();
  for (const [id, dependencies] of adjacency) {
    inDegree.set(id, inDegree.get(id) ?? 0);
    for (const dependency of dependencies) {
      inDegree.set(dependency, (inDegree.get(dependency) ?? 0) + 1);
    }
  }

  const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) {
      continue;
    }
    visited += 1;
    for (const dependency of adjacency.get(id) ?? []) {
      const nextDegree = (inDegree.get(dependency) ?? 0) - 1;
      inDegree.set(dependency, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependency);
      }
    }
  }

  if (visited === inDegree.size) {
    return null;
  }
  return [...inDegree.entries()].filter(([, degree]) => degree > 0).map(([id]) => id);
}

function validateManifestGraphSemantics(manifest: PlanPackageManifest): ValidationIssue[] {
  const diagnostics: ValidationIssue[] = [];
  const nodesById = new Map(manifest.nodes.map((node) => [node.id, node]));
  const duplicateNodeIds = findDuplicateNodeIds(manifest.nodes);
  for (const id of duplicateNodeIds) {
    diagnostics.push(issue("node_id_duplicate", `Node id '${id}' is duplicated.`, "nodes"));
  }
  for (const edge of findDuplicateEdges(manifest.edges)) {
    diagnostics.push(issue("edge_duplicate", `Edge '${edge.from} --${edge.type}--> ${edge.to}' is duplicated.`, "edges"));
  }

  const dependencyAdjacency = new Map<string, string[]>();
  for (const node of manifest.nodes) {
    if (node.type === "task") {
      dependencyAdjacency.set(node.id, []);
    }
  }

  for (const edge of manifest.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from) {
      diagnostics.push(issue("edge_from_missing", `Edge references missing from node '${edge.from}'.`, "edges"));
    }
    if (!to) {
      diagnostics.push(issue("edge_to_missing", `Edge references missing to node '${edge.to}'.`, "edges"));
    }
    if (!from || !to) {
      continue;
    }

    const endpointIssues = validateEdgeEndpointTypes(edge, from, to);
    diagnostics.push(...endpointIssues);
    if (endpointIssues.length === 0 && edge.type === "depends_on") {
      dependencyAdjacency.get(edge.from)?.push(edge.to);
    }
  }

  if (diagnostics.length === 0) {
    const cycle = findDependsOnCycleInAdjacency(dependencyAdjacency);
    if (cycle) {
      diagnostics.push(issue("depends_on_cycle", `depends_on cycle detected: ${cycle.join(" -> ")}.`, "edges"));
    }
  }

  return diagnostics;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectDependentsFromGraph(graph: CompiledTaskGraph, startTaskIds: string[]): string[] {
  const affected = new Set<string>();
  const stack = [...startTaskIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || affected.has(id)) {
      continue;
    }
    affected.add(id);
    for (const dependent of graph.dependentsByTask.get(id) ?? []) {
      stack.push(dependent);
    }
  }
  return [...affected];
}

function affectedByEdgeInGraph(graph: CompiledTaskGraph, edge: ManifestEdge): string[] {
  if (edge.type === "depends_on") {
    return unique([...collectDependentsFromGraph(graph, [edge.from]), edge.to]);
  }
  return unique([edge.from, edge.to].filter((id) => graph.nodesById.get(id)?.type === "task"));
}

function resultForGraph(graph: CompiledTaskGraph, affectedTasks: string[], diagnostics: ValidationIssue[] = []): GraphEditResult {
  const allDiagnostics = [...diagnostics, ...graph.diagnostics.errors];
  return {
    ok: allDiagnostics.length === 0,
    affectedTasks,
    diagnostics: allDiagnostics,
    graph
  };
}

function appendMapArray<TKey, TValue>(map: Map<TKey, TValue[]>, key: TKey, value: TValue): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

function removeMapEdge(map: Map<string, ManifestEdge[]>, key: string, edge: ManifestEdge): void {
  const values = map.get(key);
  if (!values) {
    return;
  }
  map.set(
    key,
    values.filter((item) => !sameEdge(item, edge))
  );
}

function removeMapString(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key);
  if (!values) {
    return;
  }
  map.set(
    key,
    values.filter((item) => item !== value)
  );
}

function refreshManifestOrder(graph: CompiledTaskGraph): void {
  graph.manifestOrderByTask.clear();
  for (const [index, task] of graph.tasksInManifestOrder.entries()) {
    graph.manifestOrderByTask.set(task.id, index);
  }
}

function addTaskIndexes(graph: CompiledTaskGraph, task: ManifestTaskNode): void {
  graph.tasksInManifestOrder.push(task);
  refreshManifestOrder(graph);
  graph.dependenciesByTask.set(task.id, []);
  graph.dependentsByTask.set(task.id, []);
  graph.contextEdgesByTask.set(task.id, []);
  graph.locksByTask.set(task.id, new Set(task.parallel.locks));
  graph.dependencyAdjacency.set(task.id, []);
  graph.reverseDependencyAdjacency.set(task.id, []);
  graph.invalidateReachability();
}

function removeTaskIndexes(graph: CompiledTaskGraph, taskId: string): void {
  const index = graph.tasksInManifestOrder.findIndex((task) => task.id === taskId);
  if (index >= 0) {
    graph.tasksInManifestOrder.splice(index, 1);
  }
  refreshManifestOrder(graph);
  graph.dependenciesByTask.delete(taskId);
  graph.dependentsByTask.delete(taskId);
  graph.contextEdgesByTask.delete(taskId);
  graph.locksByTask.delete(taskId);
  graph.dependencyAdjacency.delete(taskId);
  graph.reverseDependencyAdjacency.delete(taskId);
  for (const dependencies of graph.dependenciesByTask.values()) {
    const filtered = dependencies.filter((id) => id !== taskId);
    dependencies.splice(0, dependencies.length, ...filtered);
  }
  for (const dependents of graph.dependentsByTask.values()) {
    const filtered = dependents.filter((id) => id !== taskId);
    dependents.splice(0, dependents.length, ...filtered);
  }
  for (const dependencies of graph.dependencyAdjacency.values()) {
    const filtered = dependencies.filter((id) => id !== taskId);
    dependencies.splice(0, dependencies.length, ...filtered);
  }
  for (const dependents of graph.reverseDependencyAdjacency.values()) {
    const filtered = dependents.filter((id) => id !== taskId);
    dependents.splice(0, dependents.length, ...filtered);
  }
  graph.invalidateReachability();
}

function addContextEdgeIndexes(graph: CompiledTaskGraph, edge: ManifestEdge): void {
  if (graph.nodesById.get(edge.from)?.type === "task") {
    appendMapArray(graph.contextEdgesByTask, edge.from, edge);
  }
  if (graph.nodesById.get(edge.to)?.type === "task") {
    appendMapArray(graph.contextEdgesByTask, edge.to, edge);
  }
}

function removeContextEdgeIndexes(graph: CompiledTaskGraph, edge: ManifestEdge): void {
  removeMapEdge(graph.contextEdgesByTask, edge.from, edge);
  removeMapEdge(graph.contextEdgesByTask, edge.to, edge);
}

function addDependencyEdgeIndexes(graph: CompiledTaskGraph, edge: ManifestEdge): void {
  appendMapArray(graph.dependenciesByTask, edge.from, edge.to);
  appendMapArray(graph.dependentsByTask, edge.to, edge.from);
  appendMapArray(graph.dependencyAdjacency, edge.from, edge.to);
  appendMapArray(graph.reverseDependencyAdjacency, edge.to, edge.from);
  graph.invalidateReachability();
}

function removeDependencyEdgeIndexes(graph: CompiledTaskGraph, edge: ManifestEdge): void {
  removeMapString(graph.dependenciesByTask, edge.from, edge.to);
  removeMapString(graph.dependentsByTask, edge.to, edge.from);
  removeMapString(graph.dependencyAdjacency, edge.from, edge.to);
  removeMapString(graph.reverseDependencyAdjacency, edge.to, edge.from);
  graph.invalidateReachability();
}

function applyNodeAdded(graph: CompiledTaskGraph, node: ManifestNode): void {
  graph.nodesById.set(node.id, node);
  graph.outgoingEdgesByNode.set(node.id, []);
  graph.incomingEdgesByNode.set(node.id, []);
  if (isTaskNode(node)) {
    addTaskIndexes(graph, node);
  }
}

function applyNodeUpdated(graph: CompiledTaskGraph, before: ManifestNode, after: ManifestNode): void {
  graph.nodesById.set(after.id, after);
  if (isTaskNode(before) && isTaskNode(after)) {
    const index = graph.tasksInManifestOrder.findIndex((task) => task.id === after.id);
    if (index >= 0) {
      graph.tasksInManifestOrder[index] = after;
    }
    graph.locksByTask.set(after.id, new Set(after.parallel.locks));
  }
}

function applyEdgeAdded(graph: CompiledTaskGraph, edge: ManifestEdge): void {
  appendMapArray(graph.edgesByType, edge.type, edge);
  appendMapArray(graph.outgoingEdgesByNode, edge.from, edge);
  appendMapArray(graph.incomingEdgesByNode, edge.to, edge);
  if (edge.type === "depends_on") {
    addDependencyEdgeIndexes(graph, edge);
  } else {
    addContextEdgeIndexes(graph, edge);
  }
}

function applyEdgeRemoved(graph: CompiledTaskGraph, edge: ManifestEdge): void {
  const edgesByType = graph.edgesByType.get(edge.type) ?? [];
  graph.edgesByType.set(
    edge.type,
    edgesByType.filter((item) => !sameEdge(item, edge))
  );
  removeMapEdge(graph.outgoingEdgesByNode, edge.from, edge);
  removeMapEdge(graph.incomingEdgesByNode, edge.to, edge);
  if (edge.type === "depends_on") {
    removeDependencyEdgeIndexes(graph, edge);
  } else {
    removeContextEdgeIndexes(graph, edge);
  }
}

function applyNodeRemoved(graph: CompiledTaskGraph, node: ManifestNode): void {
  const relatedEdges = (graph.incomingEdgesByNode.get(node.id) ?? []).concat(graph.outgoingEdgesByNode.get(node.id) ?? []);
  for (const edge of relatedEdges) {
    applyEdgeRemoved(graph, edge);
  }
  graph.nodesById.delete(node.id);
  graph.outgoingEdgesByNode.delete(node.id);
  graph.incomingEdgesByNode.delete(node.id);
  if (isTaskNode(node)) {
    removeTaskIndexes(graph, node.id);
  }
}

async function validateTaskPrompt(packageDir: string, task: ManifestTaskNode, promptMarkdown?: string): Promise<ValidationIssue[]> {
  let promptPath: string;
  try {
    promptPath = await resolvePackagePath(packageDir, task.prompt);
  } catch (error) {
    if (error instanceof PackagePathError) {
      return [issue(error.code, error.message, task.prompt)];
    }
    throw error;
  }
  if (promptMarkdown === undefined && !(await exists(promptPath))) {
    return [issue("prompt_missing", `Prompt Surface file for '${task.id}' does not exist.`, task.prompt)];
  }

  const markdown = promptMarkdown ?? (await readFile(promptPath, "utf8"));
  const boundaryIssues = findPromptSectionBoundaryIssues(markdown, task.prompt);
  if (boundaryIssues.length > 0) {
    return boundaryIssues;
  }
  if (getPromptSection(markdown, "user", "task-body") === null) {
    return [issue("task_body_missing", `Prompt Surface for '${task.id}' is missing user section 'task-body'.`, task.prompt)];
  }
  return [];
}

function affectedByNodeInGraph(graph: CompiledTaskGraph, nodeId: string): string[] {
  const node = graph.nodesById.get(nodeId);
  if (!node) {
    return [];
  }
  if (node.type === "task") {
    return collectDependentsFromGraph(graph, [node.id]);
  }
  return unique(
    (graph.incomingEdgesByNode.get(nodeId) ?? [])
      .concat(graph.outgoingEdgesByNode.get(nodeId) ?? [])
      .flatMap((edge) => [edge.from, edge.to])
      .filter((id) => graph.nodesById.get(id)?.type === "task")
  );
}

function graphFromManifestChange(before: PlanPackageManifest, after: PlanPackageManifest, baseGraph?: CompiledTaskGraph): PackageChangeImpact {
  const graph = baseGraph ?? compileTaskGraph(before);
  if (graph.diagnostics.errors.length > 0) {
    return {
      ok: false,
      affectedTasks: graph.tasksInManifestOrder.map((task) => task.id),
      diagnostics: graph.diagnostics.errors,
      fullRefresh: true,
      graph
    };
  }

  const preflightDiagnostics = validateManifestGraphSemantics(after);
  if (preflightDiagnostics.length > 0) {
    const fallbackGraph = compileTaskGraph(after);
    return {
      ok: false,
      affectedTasks: fallbackGraph.tasksInManifestOrder.map((task) => task.id),
      diagnostics: fallbackGraph.diagnostics.errors.length > 0 ? fallbackGraph.diagnostics.errors : preflightDiagnostics,
      fullRefresh: true,
      graph: fallbackGraph
    };
  }

  const affected = new Set<string>();
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));

  for (const [id, node] of afterNodes) {
    const beforeNode = beforeNodes.get(id);
    if (beforeNode && beforeNode.type !== node.type) {
      const fallbackGraph = compileTaskGraph(after);
      return {
        ok: fallbackGraph.diagnostics.errors.length === 0,
        affectedTasks: fallbackGraph.tasksInManifestOrder.map((task) => task.id),
        diagnostics: fallbackGraph.diagnostics.errors,
        fullRefresh: true,
        graph: fallbackGraph
      };
    }
  }

  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) {
      for (const taskId of affectedByEdgeInGraph(graph, edge)) {
        affected.add(taskId);
      }
      applyEdgeRemoved(graph, edge);
    }
  }

  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) {
      for (const taskId of affectedByNodeInGraph(graph, id)) {
        affected.add(taskId);
      }
      applyNodeRemoved(graph, node);
    }
  }

  for (const [id, node] of afterNodes) {
    const beforeNode = beforeNodes.get(id);
    if (!beforeNode) {
      applyNodeAdded(graph, node);
      if (node.type === "task") {
        affected.add(node.id);
      }
      continue;
    }
    if (!sameNodeContent(beforeNode, node)) {
      for (const taskId of affectedByNodeInGraph(graph, id)) {
        affected.add(taskId);
      }
      applyNodeUpdated(graph, beforeNode, node);
    }
  }

  const diagnostics: ValidationIssue[] = [];
  for (const [key, edge] of afterEdges) {
    if (beforeEdges.has(key)) {
      continue;
    }

    const from = graph.nodesById.get(edge.from);
    const to = graph.nodesById.get(edge.to);
    if (!from) {
      diagnostics.push(issue("edge_from_missing", `Edge references missing from node '${edge.from}'.`, "edges"));
    }
    if (!to) {
      diagnostics.push(issue("edge_to_missing", `Edge references missing to node '${edge.to}'.`, "edges"));
    }
    if (!from || !to) {
      continue;
    }

    diagnostics.push(...validateEdgeEndpointTypes(edge, from, to));
    if (edge.type === "depends_on" && diagnostics.length === 0 && (edge.from === edge.to || graph.reachable(edge.to, edge.from))) {
      diagnostics.push(issue("depends_on_cycle", `Adding ${edge.from} -> ${edge.to} would create a depends_on cycle.`, "edges"));
    }
    if (diagnostics.length > 0) {
      continue;
    }

    for (const taskId of affectedByEdgeInGraph(graph, edge)) {
      affected.add(taskId);
    }
    applyEdgeAdded(graph, edge);
  }

  if (diagnostics.length > 0) {
    const fallbackGraph = compileTaskGraph(after);
    return {
      ok: false,
      affectedTasks: fallbackGraph.tasksInManifestOrder.map((task) => task.id),
      diagnostics: fallbackGraph.diagnostics.errors.length > 0 ? fallbackGraph.diagnostics.errors : diagnostics,
      fullRefresh: true,
      graph: fallbackGraph
    };
  }

  return { ok: true, affectedTasks: [...affected], diagnostics: [], fullRefresh: false, graph };
}

export function affectedTasksForPackageFileChange(change: PackageFileChange): PackageChangeImpact {
  if (change.kind === "global-prompt") {
    const graph = change.graph ?? compileTaskGraph(change.manifest);
    return {
      ok: graph.diagnostics.errors.length === 0,
      affectedTasks: graph.tasksInManifestOrder.map((task) => task.id),
      diagnostics: graph.diagnostics.errors,
      fullRefresh: false
    };
  }

  if (change.kind === "prompt") {
    const graph = change.graph ?? compileTaskGraph(change.manifest);
    const node = graph.nodesById.get(change.taskId);
    if (!node || node.type !== "task") {
      return {
        ok: false,
        affectedTasks: [],
        diagnostics: [issue("task_missing", `Task '${change.taskId}' does not exist.`, "nodes")],
        fullRefresh: false
      };
    }
    return { ok: true, affectedTasks: [change.taskId], diagnostics: [], fullRefresh: false };
  }

  return graphFromManifestChange(change.before, change.after, change.graph);
}

async function writeManifest(manifestFile: string, manifest: PlanPackageManifest): Promise<void> {
  await writeJsonFile(manifestFile, manifest);
}

async function writeNewTaskPrompt(packageDir: string, task: ManifestTaskNode, promptMarkdown: string): Promise<{ ok: true; path: string } | { ok: false; diagnostics: ValidationIssue[] }> {
  let promptPath: string;
  try {
    promptPath = await resolvePackagePath(packageDir, task.prompt, { forWrite: true });
  } catch (error) {
    if (error instanceof PackagePathError) {
      return { ok: false, diagnostics: [issue(error.code, error.message, task.prompt)] };
    }
    throw error;
  }
  if (await exists(promptPath)) {
    return {
      ok: false,
      diagnostics: [issue("prompt_already_exists", `Prompt Surface file for '${task.id}' already exists.`, task.prompt)]
    };
  }

  try {
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, promptMarkdown, "utf8");
    return { ok: true, path: promptPath };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [issue("prompt_write_failed", `Prompt Surface file for '${task.id}' could not be written: ${errorMessage(error)}`, task.prompt)]
    };
  }
}

function getParsedNode(manifest: PlanPackageManifest, nodeId: string): ManifestNode {
  const node = manifest.nodes.find((item) => item.id === nodeId);
  if (!node) {
    throw new Error(`Parsed manifest is missing node '${nodeId}'.`);
  }
  return node;
}

export async function addNode(options: {
  projectRoot: string;
  node: ManifestNode;
  promptMarkdown?: string;
}): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  if (graph.nodesById.has(options.node.id)) {
    return { ok: false, affectedTasks: [], diagnostics: [issue("node_id_duplicate", `Node '${options.node.id}' already exists.`, "nodes")] };
  }

  const nextManifest = { ...manifest, nodes: [...manifest.nodes, options.node] };
  const parsed = validateManifestForWrite(nextManifest);
  if (!parsed.ok) {
    return { ok: false, affectedTasks: [], diagnostics: parsed.diagnostics };
  }
  const parsedNode = getParsedNode(parsed.manifest, options.node.id);

  if (isTaskNode(parsedNode)) {
    const diagnostics = await validateTaskPrompt(workspace.packageDir, parsedNode, options.promptMarkdown);
    if (diagnostics.length > 0) {
      return { ok: false, affectedTasks: [], diagnostics };
    }
  }

  const promptWrite =
    isTaskNode(parsedNode) && options.promptMarkdown !== undefined
      ? await writeNewTaskPrompt(workspace.packageDir, parsedNode, options.promptMarkdown)
      : null;
  if (promptWrite && !promptWrite.ok) {
    return { ok: false, affectedTasks: [], diagnostics: promptWrite.diagnostics };
  }

  try {
    await writeManifest(workspace.manifestFile, parsed.manifest);
  } catch (error) {
    if (promptWrite?.ok) {
      await rm(promptWrite.path, { force: true });
    }
    throw error;
  }
  applyNodeAdded(graph, parsedNode);

  return resultForGraph(graph, isTaskNode(parsedNode) ? [parsedNode.id] : []);
}

export async function updateNode(options: { projectRoot: string; node: ManifestNode }): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  const current = graph.nodesById.get(options.node.id);
  if (!current) {
    return { ok: false, affectedTasks: [], diagnostics: [issue("node_missing", `Node '${options.node.id}' does not exist.`, "nodes")] };
  }
  if (current.type !== options.node.type) {
    return {
      ok: false,
      affectedTasks: [],
      diagnostics: [issue("node_type_change_unsupported", `Node '${options.node.id}' cannot change type from '${current.type}' to '${options.node.type}'.`, "nodes")]
    };
  }

  const nextManifest = {
    ...manifest,
    nodes: manifest.nodes.map((node) => (node.id === options.node.id ? options.node : node))
  };
  const parsed = validateManifestForWrite(nextManifest);
  if (!parsed.ok) {
    return { ok: false, affectedTasks: [], diagnostics: parsed.diagnostics };
  }
  const parsedNode = getParsedNode(parsed.manifest, options.node.id);

  if (isTaskNode(parsedNode)) {
    const diagnostics = await validateTaskPrompt(workspace.packageDir, parsedNode);
    if (diagnostics.length > 0) {
      return { ok: false, affectedTasks: [], diagnostics };
    }
  }

  await writeManifest(workspace.manifestFile, parsed.manifest);

  const affectedTasks = isTaskNode(parsedNode)
    ? [parsedNode.id]
    : (graph.incomingEdgesByNode.get(options.node.id) ?? [])
        .concat(graph.outgoingEdgesByNode.get(options.node.id) ?? [])
        .flatMap((edge) => [edge.from, edge.to])
        .filter((id) => graph.nodesById.get(id)?.type === "task");

  applyNodeUpdated(graph, current, parsedNode);
  return resultForGraph(graph, unique(affectedTasks));
}

export async function removeNode(options: { projectRoot: string; nodeId: string; removePrompt?: boolean }): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  const node = graph.nodesById.get(options.nodeId);
  if (!node) {
    return { ok: false, affectedTasks: [], diagnostics: [issue("node_missing", `Node '${options.nodeId}' does not exist.`, "nodes")] };
  }

  const relatedEdges = (graph.incomingEdgesByNode.get(options.nodeId) ?? []).concat(graph.outgoingEdgesByNode.get(options.nodeId) ?? []);
  const affectedTasks = unique(
    relatedEdges.flatMap((edge) => affectedByEdgeInGraph(graph, edge)).concat(isTaskNode(node) ? [node.id] : [])
  );
  const nextManifest = {
    ...manifest,
    nodes: manifest.nodes.filter((item) => item.id !== options.nodeId),
    edges: manifest.edges.filter((edge) => edge.from !== options.nodeId && edge.to !== options.nodeId)
  };
  const parsed = validateManifestForWrite(nextManifest);
  if (!parsed.ok) {
    return { ok: false, affectedTasks: [], diagnostics: parsed.diagnostics };
  }
  await writeManifest(workspace.manifestFile, parsed.manifest);

  if (isTaskNode(node) && options.removePrompt) {
    await rm(await resolvePackagePath(workspace.packageDir, node.prompt, { requireExisting: true }), { force: true });
  }
  applyNodeRemoved(graph, node);

  return resultForGraph(graph, affectedTasks);
}

export async function addEdge(options: { projectRoot: string; edge: ManifestEdge }): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  const from = graph.nodesById.get(options.edge.from);
  const to = graph.nodesById.get(options.edge.to);
  const diagnostics: ValidationIssue[] = [];
  if (!from) {
    diagnostics.push(issue("edge_from_missing", `Edge references missing from node '${options.edge.from}'.`, "edges"));
  }
  if (!to) {
    diagnostics.push(issue("edge_to_missing", `Edge references missing to node '${options.edge.to}'.`, "edges"));
  }
  if (manifest.edges.some((edge) => sameEdge(edge, options.edge))) {
    diagnostics.push(issue("edge_duplicate", "Edge already exists.", "edges"));
  }
  if (from && to) {
    diagnostics.push(...validateEdgeEndpointTypes(options.edge, from, to));
  }
  if (options.edge.type === "depends_on") {
    if (from && to && diagnostics.length === 0 && (options.edge.from === options.edge.to || graph.reachable(options.edge.to, options.edge.from))) {
      diagnostics.push(issue("depends_on_cycle", `Adding ${options.edge.from} -> ${options.edge.to} would create a depends_on cycle.`, "edges"));
    }
  }
  if (diagnostics.length > 0) {
    return { ok: false, affectedTasks: [], diagnostics };
  }

  const affectedTasks = affectedByEdgeInGraph(graph, options.edge);
  const nextManifest = { ...manifest, edges: [...manifest.edges, options.edge] };
  const parsed = validateManifestForWrite(nextManifest);
  if (!parsed.ok) {
    return { ok: false, affectedTasks: [], diagnostics: parsed.diagnostics };
  }
  await writeManifest(workspace.manifestFile, parsed.manifest);
  applyEdgeAdded(graph, options.edge);
  return resultForGraph(graph, affectedTasks);
}

export async function removeEdge(options: { projectRoot: string; edge: ManifestEdge }): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  if (!manifest.edges.some((edge) => sameEdge(edge, options.edge))) {
    return { ok: false, affectedTasks: [], diagnostics: [issue("edge_missing", "Edge does not exist.", "edges")] };
  }

  const affectedTasks = affectedByEdgeInGraph(graph, options.edge);
  const nextManifest = {
    ...manifest,
    edges: manifest.edges.filter((edge) => !sameEdge(edge, options.edge))
  };
  const parsed = validateManifestForWrite(nextManifest);
  if (!parsed.ok) {
    return { ok: false, affectedTasks: [], diagnostics: parsed.diagnostics };
  }
  await writeManifest(workspace.manifestFile, parsed.manifest);
  applyEdgeRemoved(graph, options.edge);
  return resultForGraph(graph, affectedTasks);
}

export async function updatePromptSurface(options: {
  projectRoot: string;
  taskId: string;
  taskBody: string;
}): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  const node = graph.nodesById.get(options.taskId);
  if (!node || node.type !== "task") {
    return { ok: false, affectedTasks: [], diagnostics: [issue("task_missing", `Task '${options.taskId}' does not exist.`, "nodes")] };
  }

  const promptPath = await resolvePackagePath(workspace.packageDir, node.prompt, { requireExisting: true });
  const prompt = await readFile(promptPath, "utf8");
  const boundaryIssues = findPromptSectionBoundaryIssues(prompt, node.prompt);
  if (boundaryIssues.length > 0) {
    return { ok: false, affectedTasks: [], diagnostics: boundaryIssues };
  }
  if (getPromptSection(prompt, "user", "task-body") === null) {
    return {
      ok: false,
      affectedTasks: [],
      diagnostics: [issue("task_body_missing", `Prompt Surface for '${options.taskId}' is missing user section 'task-body'.`, node.prompt)]
    };
  }

  await writeFile(promptPath, replacePromptSection(prompt, "user", "task-body", options.taskBody), "utf8");
  return resultForGraph(graph, [options.taskId]);
}

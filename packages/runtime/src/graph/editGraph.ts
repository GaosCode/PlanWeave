import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compileTaskGraph } from "./compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { manifestSchema } from "../schema/manifest.js";
import { buildPlanPackageGraphMutation, type PlanPackageGraphMutation, type PlanPackageGraphMutationSideEffect } from "./mutation.js";
import type {
  CompiledTaskGraph,
  GraphEditResult,
  ManifestEdge,
  ManifestNode,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ValidationIssue
} from "../types.js";

export type PackageFileChange =
  | { kind: "manifest"; before: PlanPackageManifest; after: PlanPackageManifest; graph?: CompiledTaskGraph }
  | { kind: "prompt"; manifest: PlanPackageManifest; ref: string; graph?: CompiledTaskGraph };

export type PackageChangeImpact = GraphEditResult & {
  fullRefresh: boolean;
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function validateForWrite(manifest: PlanPackageManifest): ValidationIssue[] {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return parsed.error.issues.map((item) =>
      issue("manifest_schema_invalid", item.message, item.path.length > 0 ? item.path.join(".") : "manifest.json")
    );
  }
  return compileTaskGraph(manifest).diagnostics.errors;
}

function result(manifest: PlanPackageManifest, affectedTasks: string[], diagnostics: ValidationIssue[] = []): GraphEditResult {
  const graph = compileTaskGraph(manifest);
  const allDiagnostics = [...diagnostics, ...graph.diagnostics.errors];
  return {
    ok: allDiagnostics.length === 0,
    affectedTasks: [...new Set(affectedTasks)],
    diagnostics: allDiagnostics,
    graph
  };
}

async function writeManifest(projectRoot: PackageWorkspaceRef, manifest: PlanPackageManifest): Promise<void> {
  const diagnostics = validateForWrite(manifest);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
  }
  const { workspace } = await loadPackage(projectRoot);
  await writeJsonFile(workspace.manifestFile, manifest);
}

async function applyMutationSideEffects(packageDir: string, sideEffects: PlanPackageGraphMutationSideEffect[]): Promise<void> {
  for (const sideEffect of sideEffects) {
    const targetPath = await resolvePackagePath(packageDir, sideEffect.packagePath, sideEffect.kind === "writePrompt" ? { forWrite: true } : undefined);
    if (sideEffect.kind === "writePrompt") {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, sideEffect.markdown, "utf8");
    } else if (sideEffect.kind === "removeTaskDirectory") {
      await rm(targetPath, { recursive: true, force: true });
    } else {
      await rm(targetPath, { force: true });
    }
  }
}

export async function commitPlanPackageGraphMutation(options: {
  projectRoot: PackageWorkspaceRef;
  mutation: PlanPackageGraphMutation;
}): Promise<GraphEditResult> {
  const diagnostics = validateForWrite(options.mutation.nextManifest);
  if (diagnostics.length > 0) {
    return result(options.mutation.nextManifest, options.mutation.affectedTasks, diagnostics);
  }
  const { workspace } = await loadPackage(options.projectRoot);
  await applyMutationSideEffects(workspace.packageDir, options.mutation.sideEffects);
  await writeManifest(options.projectRoot, options.mutation.nextManifest);
  return result(options.mutation.nextManifest, options.mutation.affectedTasks);
}

function affectedTaskIdsForNode(manifest: PlanPackageManifest, nodeId: string): string[] {
  const graph = compileTaskGraph(manifest);
  if (graph.tasksById.has(nodeId)) {
    return [nodeId];
  }
  return manifest.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .flatMap((edge) => [edge.from, edge.to])
    .filter((id) => graph.tasksById.has(id));
}

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
    stack.push(...(graph.taskDependentsByTask.get(current) ?? []));
  }
}

function affectedTaskIdsForEdge(edge: ManifestEdge, graph: CompiledTaskGraph, affected: Set<string>): void {
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

function affectedTaskIdsForManifestChange(
  before: PlanPackageManifest,
  after: PlanPackageManifest,
  beforeGraph: CompiledTaskGraph,
  afterGraph: CompiledTaskGraph
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
      for (const edge of [...before.edges, ...after.edges].filter((edge) => edge.from === nodeId || edge.to === nodeId)) {
        affectedTaskIdsForEdge(edge, beforeGraph, affected);
        affectedTaskIdsForEdge(edge, afterGraph, affected);
      }
    }
  }

  const beforeEdges = new Map(before.edges.map((edge) => [`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge]));
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

  return [...affected].filter((taskId) => beforeGraph.tasksById.has(taskId) || afterGraph.tasksById.has(taskId));
}

export async function addNode(options: {
  projectRoot: PackageWorkspaceRef;
  node: ManifestNode;
  promptMarkdown?: string;
}): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  if (manifest.nodes.some((node) => node.id === options.node.id)) {
    return result(manifest, [], [issue("node_id_duplicate", `Node '${options.node.id}' already exists.`, "nodes")]);
  }
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "addNode", node: options.node, promptMarkdown: options.promptMarkdown })
  });
}

export async function updateNode(options: { projectRoot: PackageWorkspaceRef; node: ManifestNode }): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  if (!manifest.nodes.some((node) => node.id === options.node.id)) {
    return result(manifest, [], [issue("node_missing", `Node '${options.node.id}' does not exist.`, "nodes")]);
  }
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "updateNode", node: options.node })
  });
}

export async function removeNode(options: {
  projectRoot: PackageWorkspaceRef;
  nodeId: string;
  removePrompt?: boolean;
}): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const node = manifest.nodes.find((item) => item.id === options.nodeId);
  if (!node) {
    return result(manifest, [], [issue("node_missing", `Node '${options.nodeId}' does not exist.`, "nodes")]);
  }
  const mutation = buildPlanPackageGraphMutation(manifest, {
    kind: "removeNode",
    nodeId: options.nodeId,
    removePrompt: options.removePrompt
  });
  return commitPlanPackageGraphMutation({ projectRoot: options.projectRoot, mutation });
}

export async function addEdge(options: { projectRoot: PackageWorkspaceRef; edge: ManifestEdge }): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  if (manifest.edges.some((edge) => edge.from === options.edge.from && edge.to === options.edge.to && edge.type === options.edge.type)) {
    return result(manifest, [], [issue("edge_duplicate", "Edge already exists.", "edges")]);
  }
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "addEdge", edge: options.edge })
  });
}

export async function removeEdge(options: { projectRoot: PackageWorkspaceRef; edge: ManifestEdge }): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "removeEdge", edge: options.edge })
  });
}

export async function updatePromptSurface(options: {
  projectRoot: PackageWorkspaceRef;
  taskId: string;
  taskBody: string;
}): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === options.taskId);
  if (!task || task.type !== "task") {
    return result(manifest, [], [issue("task_missing", `Task '${options.taskId}' does not exist.`, options.taskId)]);
  }
  return commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "writeTaskPrompt", taskId: task.id, markdown: options.taskBody })
  });
}

export function affectedTasksForPackageFileChange(change: PackageFileChange): PackageChangeImpact {
  if (change.kind === "manifest") {
    const beforeGraph = compileTaskGraph(change.before);
    const afterGraph = compileTaskGraph(change.after);
    const affectedTasks = affectedTaskIdsForManifestChange(change.before, change.after, beforeGraph, afterGraph);
    return {
      ok: afterGraph.diagnostics.errors.length === 0,
      affectedTasks,
      diagnostics: afterGraph.diagnostics.errors,
      fullRefresh: affectedTasks.length === 0,
      graph: afterGraph
    };
  }
  const graph = change.graph ?? compileTaskGraph(change.manifest);
  const taskId = graph.blockTaskByRef.get(change.ref) ?? change.ref;
  return {
    ok: graph.diagnostics.errors.length === 0,
    affectedTasks: [taskId],
    diagnostics: graph.diagnostics.errors,
    fullRefresh: false,
    graph
  };
}

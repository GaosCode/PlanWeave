import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { affectedTaskIdsForManifestChange } from "./affectedTasks.js";
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

type SideEffectBackup =
  | { kind: "absent"; targetPath: string }
  | { kind: "file"; targetPath: string; content: Buffer }
  | { kind: "directory"; targetPath: string; backupPath: string };

async function sideEffectTargetPath(packageDir: string, sideEffect: PlanPackageGraphMutationSideEffect): Promise<string> {
  return resolvePackagePath(packageDir, sideEffect.packagePath, sideEffect.kind === "writePrompt" ? { forWrite: true } : undefined);
}

async function backupSideEffectTarget(targetPath: string, temporaryRoot: string): Promise<SideEffectBackup> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isDirectory()) {
      const backupPath = await mkdtemp(`${temporaryRoot}/side-effect-dir-`);
      await rm(backupPath, { recursive: true, force: true });
      await cp(targetPath, backupPath, { recursive: true });
      return { kind: "directory", targetPath, backupPath };
    }
    return { kind: "file", targetPath, content: await readFile(targetPath) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { kind: "absent", targetPath };
    }
    throw error;
  }
}

async function restoreSideEffectBackup(backup: SideEffectBackup): Promise<void> {
  if (backup.kind === "absent") {
    await rm(backup.targetPath, { recursive: true, force: true });
    return;
  }
  await mkdir(dirname(backup.targetPath), { recursive: true });
  if (backup.kind === "directory") {
    await rm(backup.targetPath, { recursive: true, force: true });
    await cp(backup.backupPath, backup.targetPath, { recursive: true });
    return;
  }
  await writeFile(backup.targetPath, backup.content);
}

async function applyMutationSideEffectsWithRollback(
  packageDir: string,
  sideEffects: PlanPackageGraphMutationSideEffect[],
  writeManifestAfterSideEffects: () => Promise<void>
): Promise<void> {
  if (sideEffects.length === 0) {
    await writeManifestAfterSideEffects();
    return;
  }
  const temporaryRoot = await mkdtemp(`${tmpdir()}/planweave-graph-mutation-`);
  const targetPaths = new Map<string, string>();
  for (const sideEffect of sideEffects) {
    const targetPath = await sideEffectTargetPath(packageDir, sideEffect);
    targetPaths.set(targetPath, targetPath);
  }
  const backups = await Promise.all([...targetPaths.values()].map((targetPath) => backupSideEffectTarget(targetPath, temporaryRoot)));

  try {
    for (const sideEffect of sideEffects) {
      const targetPath = await sideEffectTargetPath(packageDir, sideEffect);
      if (sideEffect.kind === "writePrompt") {
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, sideEffect.markdown, "utf8");
      } else if (sideEffect.kind === "removeTaskDirectory") {
        await rm(targetPath, { recursive: true, force: true });
      } else {
        await rm(targetPath, { force: true });
      }
    }
    await writeManifestAfterSideEffects();
  } catch (error) {
    await Promise.all(backups.map((backup) => restoreSideEffectBackup(backup)));
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
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
  await applyMutationSideEffectsWithRollback(workspace.packageDir, options.mutation.sideEffects, () =>
    writeManifest(options.projectRoot, options.mutation.nextManifest)
  );
  return result(options.mutation.nextManifest, options.mutation.affectedTasks);
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

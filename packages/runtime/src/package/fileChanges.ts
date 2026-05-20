import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { compilePackageGraph, compileTaskGraph } from "../graph/compileTaskGraph.js";
import { affectedTasksForPackageFileChange, type PackageChangeImpact } from "../graph/editGraph.js";
import { loadPackage } from "./loadPackage.js";
import { PackagePathError, resolvePackagePath } from "./resolvePackagePath.js";
import { refreshPrompt } from "../prompt/refreshPrompt.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import { findPromptSectionBoundaryIssues, hasUserSection } from "../prompt/sections.js";
import type { CompiledTaskGraph, ManifestTaskNode, PlanPackageManifest, PromptSurface, ValidationIssue } from "../types.js";

type FileFingerprint = {
  path: string;
  hash: string;
  mtimeMs: number;
};

export type PackageFileSnapshot = {
  manifest: PlanPackageManifest;
  graph: CompiledTaskGraph;
  manifestFile: FileFingerprint;
  globalPrompt: FileFingerprint | null;
  promptFiles: Record<string, FileFingerprint>;
};

type PackageFileSnapshotFiles = Omit<PackageFileSnapshot, "graph">;

export type PackageFileSyncResult = {
  snapshot: PackageFileSnapshot | null;
  impact: PackageChangeImpact;
  refreshed: PromptSurface[];
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

async function fingerprint(path: string): Promise<FileFingerprint> {
  const [metadata, content] = await Promise.all([stat(path), readFile(path)]);
  return {
    path,
    hash: createHash("sha256").update(content).digest("hex"),
    mtimeMs: metadata.mtimeMs
  };
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

function sameManifest(left: PlanPackageManifest, right: PlanPackageManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changed(left: FileFingerprint | null | undefined, right: FileFingerprint | null | undefined): boolean {
  return left?.hash !== right?.hash || left?.mtimeMs !== right?.mtimeMs;
}

function mergeImpact(left: PackageChangeImpact, right: PackageChangeImpact): PackageChangeImpact {
  const affectedTasks = [...new Set([...left.affectedTasks, ...right.affectedTasks])];
  return {
    ok: left.ok && right.ok,
    affectedTasks,
    diagnostics: [...left.diagnostics, ...right.diagnostics],
    fullRefresh: left.fullRefresh || right.fullRefresh,
    graph: right.graph ?? left.graph
  };
}

function taskByPromptPath(manifest: PlanPackageManifest): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of manifest.nodes) {
    if (node.type === "task") {
      map.set(node.prompt, node.id);
    }
  }
  return map;
}

function taskById(manifest: PlanPackageManifest): Map<string, ManifestTaskNode> {
  const map = new Map<string, ManifestTaskNode>();
  for (const node of manifest.nodes) {
    if (node.type === "task") {
      map.set(node.id, node);
    }
  }
  return map;
}

async function validatePromptSurfacesForTasks(
  packageDir: string,
  manifest: PlanPackageManifest,
  taskIds: string[]
): Promise<ValidationIssue[]> {
  const tasks = taskById(manifest);
  const diagnostics: ValidationIssue[] = [];
  for (const taskId of new Set(taskIds)) {
    const task = tasks.get(taskId);
    if (!task) {
      continue;
    }
    let prompt: string;
    try {
      prompt = await readFile(await resolvePackagePath(packageDir, task.prompt, { requireExisting: true }), "utf8");
    } catch (error) {
      if (error instanceof PackagePathError) {
        diagnostics.push(issue(error.code, error.message, task.prompt));
        continue;
      }
      diagnostics.push(issue("prompt_missing", `Prompt Surface file for '${task.id}' does not exist.`, task.prompt));
      continue;
    }

    diagnostics.push(...findPromptSectionBoundaryIssues(prompt, task.prompt));
    if (!hasUserSection(prompt, "task-body")) {
      diagnostics.push(issue("task_body_missing", `Prompt Surface for '${task.id}' is missing user section 'task-body'.`, task.prompt));
    }
  }
  return diagnostics;
}

async function createPackageFileSnapshotFiles(projectRoot: string): Promise<PackageFileSnapshotFiles> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const promptFiles: Record<string, FileFingerprint> = {};
  for (const file of await listMarkdownFiles(join(workspace.packageDir, "nodes"))) {
    promptFiles[relative(workspace.packageDir, file)] = await fingerprint(file);
  }

  let globalPrompt: FileFingerprint | null = null;
  try {
    globalPrompt = await fingerprint(await resolvePackagePath(workspace.packageDir, manifest.global_prompt, { requireExisting: true }));
  } catch (error) {
    if (error instanceof PackagePathError) {
      throw error;
    }
    globalPrompt = null;
  }

  return {
    manifest,
    manifestFile: await fingerprint(workspace.manifestFile),
    globalPrompt,
    promptFiles
  };
}

export async function createPackageFileSnapshot(projectRoot: string): Promise<PackageFileSnapshot> {
  const { workspace } = await loadPackage(projectRoot);
  const snapshot = await createPackageFileSnapshotFiles(projectRoot);
  return {
    ...snapshot,
    graph: await compilePackageGraph(snapshot.manifest, workspace.packageDir)
  };
}

export async function detectPackageFileChanges(
  projectRoot: string,
  previous: PackageFileSnapshot
): Promise<{ snapshot: PackageFileSnapshot | null; impact: PackageChangeImpact }> {
  let snapshotFiles: PackageFileSnapshotFiles;
  try {
    snapshotFiles = await createPackageFileSnapshotFiles(projectRoot);
  } catch (error) {
    return {
      snapshot: null,
      impact: {
        ok: false,
        affectedTasks: [],
        diagnostics: [issue("package_change_detection_failed", error instanceof Error ? error.message : String(error))],
        fullRefresh: true
      }
    };
  }

  let impact: PackageChangeImpact = {
    ok: true,
    affectedTasks: [],
    diagnostics: [],
    fullRefresh: false,
    graph: previous.graph
  };

  if (!sameManifest(previous.manifest, snapshotFiles.manifest)) {
    const graph = compileTaskGraph(previous.manifest);
    impact = mergeImpact(
      impact,
      affectedTasksForPackageFileChange({ kind: "manifest", before: previous.manifest, after: snapshotFiles.manifest, graph })
    );
  }

  if (changed(previous.globalPrompt, snapshotFiles.globalPrompt)) {
    impact = mergeImpact(impact, affectedTasksForPackageFileChange({ kind: "global-prompt", manifest: snapshotFiles.manifest, graph: impact.graph }));
  }

  const promptToTask = taskByPromptPath(snapshotFiles.manifest);
  const promptPaths = new Set([...Object.keys(previous.promptFiles), ...Object.keys(snapshotFiles.promptFiles)]);
  for (const path of promptPaths) {
    if (!changed(previous.promptFiles[path], snapshotFiles.promptFiles[path])) {
      continue;
    }
    const taskId = promptToTask.get(path);
    if (!taskId) {
      impact = {
        ...impact,
        diagnostics: [...impact.diagnostics, issue("stale_prompt_reference", `Changed Prompt Surface '${path}' is not referenced by any task.`, path)]
      };
      continue;
    }
    impact = mergeImpact(impact, affectedTasksForPackageFileChange({ kind: "prompt", manifest: snapshotFiles.manifest, taskId, graph: impact.graph }));
  }

  if (impact.ok && !snapshotFiles.globalPrompt) {
    impact = {
      ...impact,
      ok: false,
      diagnostics: [
        ...impact.diagnostics,
        issue("global_prompt_missing", `Global Prompt file '${snapshotFiles.manifest.global_prompt}' does not exist.`, snapshotFiles.manifest.global_prompt)
      ]
    };
  }

  if (impact.ok && impact.affectedTasks.length > 0) {
    const { workspace } = await loadPackage(projectRoot);
    const promptDiagnostics = await validatePromptSurfacesForTasks(workspace.packageDir, snapshotFiles.manifest, impact.affectedTasks);
    if (promptDiagnostics.length > 0) {
      impact = {
        ...impact,
        ok: false,
        diagnostics: [...impact.diagnostics, ...promptDiagnostics]
      };
    }
  }

  if (!impact.ok) {
    return { snapshot: null, impact };
  }

  const snapshot: PackageFileSnapshot = {
    ...snapshotFiles,
    graph: impact.graph ?? previous.graph
  };
  return { snapshot, impact };
}

export async function refreshChangedPackagePrompts(
  projectRoot: string,
  previous: PackageFileSnapshot
): Promise<PackageFileSyncResult> {
  const detected = await detectPackageFileChanges(projectRoot, previous);
  if (!detected.snapshot || !detected.impact.ok) {
    return { ...detected, refreshed: [] };
  }

  if (detected.impact.fullRefresh) {
    const result = await refreshPrompts({ projectRoot });
    return { ...detected, refreshed: result.prompts };
  }

  const refreshed: PromptSurface[] = [];
  for (const taskId of detected.impact.affectedTasks) {
    refreshed.push(await refreshPrompt({ projectRoot, taskId }));
  }
  const snapshot = await createPackageFileSnapshot(projectRoot);
  return {
    snapshot,
    impact: detected.impact,
    refreshed
  };
}

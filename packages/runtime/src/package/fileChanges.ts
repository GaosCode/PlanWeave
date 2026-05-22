import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { compilePackageGraph } from "../graph/compileTaskGraph.js";
import { affectedTasksForPackageFileChange, type PackageChangeImpact } from "../graph/editGraph.js";
import { loadPackage } from "./loadPackage.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import type { CompiledTaskGraph, FileFingerprint, PackageFileSnapshot, PackageWorkspaceRef, PlanPackageManifest, PromptSurface } from "../types.js";

export type PackageFileSyncResult = {
  snapshot: PackageFileSnapshot | null;
  impact: PackageChangeImpact;
  refreshed: PromptSurface[];
};

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

async function snapshotPromptFiles(packageDir: string): Promise<Record<string, FileFingerprint>> {
  const promptFiles: Record<string, FileFingerprint> = {};
  for (const file of await listMarkdownFiles(join(packageDir, "nodes"))) {
    promptFiles[relative(packageDir, file)] = await fingerprint(file);
  }
  return promptFiles;
}

function sameManifest(left: PlanPackageManifest, right: PlanPackageManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changed(left: FileFingerprint | undefined, right: FileFingerprint | undefined): boolean {
  return left?.hash !== right?.hash || left?.mtimeMs !== right?.mtimeMs;
}

function affectedTasksForPromptPaths(graph: CompiledTaskGraph, paths: string[]): string[] {
  const affected = new Set<string>();
  for (const path of paths) {
    for (const taskId of graph.taskNodesInManifestOrder) {
      const task = graph.tasksById.get(taskId);
      if (!task) {
        continue;
      }
      if (task.prompt === path || task.blocks.some((block) => block.prompt === path)) {
        affected.add(taskId);
      }
    }
  }
  return [...affected];
}

export async function createPackageFileSnapshot(projectRoot: PackageWorkspaceRef): Promise<PackageFileSnapshot> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  return {
    manifest,
    graph: await compilePackageGraph(manifest, workspace.packageDir),
    manifestFile: await fingerprint(workspace.manifestFile),
    promptFiles: await snapshotPromptFiles(workspace.packageDir)
  };
}

export async function detectPackageFileChanges(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot
): Promise<{ snapshot: PackageFileSnapshot | null; impact: PackageChangeImpact }> {
  try {
    const snapshot = await createPackageFileSnapshot(projectRoot);
    let impact: PackageChangeImpact = {
      ok: true,
      affectedTasks: [],
      diagnostics: [],
      fullRefresh: false,
      graph: snapshot.graph
    };
    if (!sameManifest(previous.manifest, snapshot.manifest)) {
      impact = affectedTasksForPackageFileChange({
        kind: "manifest",
        before: previous.manifest,
        after: snapshot.manifest,
        graph: snapshot.graph
      });
    } else {
      const promptPaths = new Set([...Object.keys(previous.promptFiles), ...Object.keys(snapshot.promptFiles)]);
      const changedPrompts = [...promptPaths].filter((path) => changed(previous.promptFiles[path], snapshot.promptFiles[path]));
      if (changedPrompts.length > 0) {
        impact = {
          ok: snapshot.graph.diagnostics.errors.length === 0,
          affectedTasks: affectedTasksForPromptPaths(snapshot.graph, changedPrompts),
          diagnostics: snapshot.graph.diagnostics.errors,
          fullRefresh: true,
          graph: snapshot.graph
        };
      }
    }
    return { snapshot: impact.ok ? snapshot : null, impact };
  } catch (error) {
    return {
      snapshot: null,
      impact: {
        ok: false,
        affectedTasks: [],
        diagnostics: [
          {
            code: "package_change_detection_failed",
            message: error instanceof Error ? error.message : String(error)
          }
        ],
        fullRefresh: true
      }
    };
  }
}

export async function refreshChangedPackagePrompts(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot
): Promise<PackageFileSyncResult> {
  const detected = await detectPackageFileChanges(projectRoot, previous);
  if (!detected.snapshot || !detected.impact.ok) {
    return { ...detected, refreshed: [] };
  }
  const result = detected.impact.fullRefresh ? await refreshPrompts({ projectRoot }) : { prompts: [] };
  return {
    snapshot: await createPackageFileSnapshot(projectRoot),
    impact: detected.impact,
    refreshed: result.prompts
  };
}

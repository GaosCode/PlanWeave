import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { optionalReaddir } from "../fs/optionalFile.js";
import { compilePackageGraph } from "../graph/compileTaskGraph.js";
import { affectedTasksForPackageFileChange, type PackageChangeImpact } from "../graph/editGraph.js";
import { loadPackage } from "./loadPackage.js";
import { refreshPrompt } from "../prompt/refreshPrompt.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import type {
  CompiledExecutionGraph,
  CompiledTaskGraph,
  FileFingerprint,
  PackageFileSnapshot,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ProjectWorkspace,
  PromptSurface,
  ValidationIssue
} from "../types.js";

const DEFAULT_PROMPT_REFRESH_CONCURRENCY = 4;
type PromptFingerprintMode = "content" | "stat";

export type PromptRefreshStats = {
  requested: number;
  refreshed: number;
  concurrency: number | null;
  elapsedMs: number;
  changedPathCount: number;
  refreshedRefs: number;
  mode: "incremental" | "full";
};

export type PackageFileSyncResult = {
  snapshot: PackageFileSnapshot | null;
  impact: PackageChangeImpact;
  refreshed: PromptSurface[];
  refreshStats: PromptRefreshStats;
  changedPackagePaths: string[];
  indexPackagePaths: string[];
  incremental: boolean;
};

export type PackageFileRefreshOptions = {
  refreshConcurrency?: number;
};

type NormalizedPackageChangePaths = {
  changedPackagePaths: string[];
  diagnostics: ValidationIssue[];
  incremental: boolean;
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

async function statFingerprint(path: string): Promise<FileFingerprint> {
  const metadata = await stat(path);
  return {
    path,
    hash: `stat:${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}`,
    mtimeMs: metadata.mtimeMs
  };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await optionalReaddir(root, { withFileTypes: true });
  if (!entries) {
    return [];
  }
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
}

async function snapshotPromptFiles(
  packageDir: string,
  mode: PromptFingerprintMode
): Promise<Record<string, FileFingerprint>> {
  const promptFiles: Record<string, FileFingerprint> = {};
  for (const file of await listMarkdownFiles(join(packageDir, "nodes"))) {
    promptFiles[relative(packageDir, file)] =
      mode === "content" ? await fingerprint(file) : await statFingerprint(file);
  }
  return promptFiles;
}

function sameManifest(left: PlanPackageManifest, right: PlanPackageManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changed(left: FileFingerprint | undefined, right: FileFingerprint | undefined): boolean {
  return left?.hash !== right?.hash || left?.mtimeMs !== right?.mtimeMs;
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

function normalizeConcurrency(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function promptRefreshStats(options: {
  requested: number;
  refreshed: number;
  concurrency: number | null;
  changedPathCount: number;
  mode: PromptRefreshStats["mode"];
  startedAt: number;
}): PromptRefreshStats {
  return {
    requested: options.requested,
    refreshed: options.refreshed,
    concurrency: options.concurrency,
    elapsedMs: elapsedMs(options.startedAt),
    changedPathCount: options.changedPathCount,
    refreshedRefs: options.refreshed,
    mode: options.mode
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const concurrency = normalizeConcurrency(limit);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;

  async function worker(): Promise<void> {
    while (nextIndex < items.length && !firstError) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        firstError = error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) {
    throw firstError;
  }
  return results;
}

function normalizeWatcherPath(path: string): string {
  let normalized = path
    .split("\\")
    .join("/")
    .replace(/^\.\/+/, "");
  while (normalized.startsWith("//")) {
    normalized = normalized.slice(1);
  }
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "/") {
    end -= 1;
  }
  return normalized.slice(0, end);
}

export function normalizePackageChangedPaths(
  changedPaths: string[] | undefined
): NormalizedPackageChangePaths {
  if (!changedPaths || changedPaths.length === 0) {
    return {
      changedPackagePaths: ["manifest.json"],
      diagnostics: [
        issue(
          "package_change_paths_empty",
          "Package file refresh did not receive changed paths; falling back to a full refresh."
        )
      ],
      incremental: false
    };
  }

  const changedPackagePaths: string[] = [];
  const diagnostics: ValidationIssue[] = [];

  for (const rawPath of changedPaths) {
    const normalized = normalizeWatcherPath(rawPath);
    if (normalized === "manifest.json" || normalized === "package/manifest.json") {
      changedPackagePaths.push("manifest.json");
      diagnostics.push(
        issue(
          "package_change_manifest_requires_full_refresh",
          "Manifest changes require a full package refresh.",
          normalized
        )
      );
      continue;
    }

    if (normalized === "policy/project-prompt.md") {
      changedPackagePaths.push("policy/project-prompt.md");
      diagnostics.push(
        issue(
          "package_change_non_package_prompt",
          "Project prompt changes are not package prompt changes; falling back to a full refresh.",
          normalized
        )
      );
      continue;
    }

    const packagePath = normalized.startsWith("package/")
      ? normalized.slice("package/".length)
      : normalized;
    if (packagePath === "nodes" || packagePath.startsWith("nodes/")) {
      if (!packagePath.endsWith(".md")) {
        changedPackagePaths.push(packagePath);
        diagnostics.push(
          issue(
            "package_change_coarse_path_requires_full_refresh",
            "Directory-level package changes require a full package refresh.",
            normalized
          )
        );
        continue;
      }
      changedPackagePaths.push(packagePath);
      continue;
    }

    changedPackagePaths.push(packagePath || "manifest.json");
    diagnostics.push(
      issue(
        "package_change_unknown_path_requires_full_refresh",
        "Unknown package watcher path requires a full package refresh.",
        normalized
      )
    );
  }

  return {
    changedPackagePaths: dedupe(changedPackagePaths),
    diagnostics,
    incremental: diagnostics.length === 0
  };
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

function dedupedPromptSurfaceRefsForPromptPaths(
  graph: CompiledTaskGraph,
  paths: string[]
): string[] {
  const refs = new Set<string>();
  for (const path of paths) {
    for (const taskId of graph.taskNodesInManifestOrder) {
      const task = graph.tasksById.get(taskId);
      if (!task) {
        continue;
      }
      if (task.prompt === path) {
        for (const blockRef of graph.blocksByTask.get(taskId) ?? []) {
          refs.add(blockRef);
        }
      }
      for (const block of task.blocks) {
        if (block.prompt === path) {
          refs.add(`${taskId}#${block.id}`);
        }
      }
    }
  }
  return [...refs];
}

function graphPromptPaths(graph: CompiledTaskGraph): Set<string> {
  const paths = new Set<string>();
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = graph.tasksById.get(taskId);
    if (!task) {
      continue;
    }
    paths.add(task.prompt);
    for (const block of task.blocks) {
      paths.add(block.prompt);
    }
  }
  return paths;
}

function incrementalPromptImpact(
  graph: CompiledTaskGraph,
  changedPromptPaths: string[]
): PackageChangeImpact {
  return {
    ok: graph.diagnostics.errors.length === 0,
    affectedTasks: affectedTasksForPromptPaths(graph, changedPromptPaths),
    diagnostics: graph.diagnostics.errors,
    fullRefresh: false,
    graph
  };
}

function changedPackagePaths(previous: PackageFileSnapshot, next: PackageFileSnapshot): string[] {
  const paths = new Set([...Object.keys(previous.promptFiles), ...Object.keys(next.promptFiles)]);
  const changedPaths = [...paths].filter((path) =>
    changed(previous.promptFiles[path], next.promptFiles[path])
  );
  return changed(previous.manifestFile, next.manifestFile)
    ? ["manifest.json", ...changedPaths]
    : changedPaths;
}

export async function createPackageFileSnapshotFromLoadedPackage(input: {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph?: CompiledExecutionGraph;
  promptFingerprintMode?: PromptFingerprintMode;
}): Promise<PackageFileSnapshot> {
  return createPackageFileSnapshotFromPackageRoot({
    packageDir: input.workspace.packageDir,
    manifestFile: input.workspace.manifestFile,
    manifest: input.manifest,
    graph: input.graph,
    promptFingerprintMode: input.promptFingerprintMode
  });
}

export async function createPackageFileSnapshotFromPackageRoot(input: {
  packageDir: string;
  manifestFile: string;
  manifest: PlanPackageManifest;
  graph?: CompiledExecutionGraph;
  promptFingerprintMode?: PromptFingerprintMode;
}): Promise<PackageFileSnapshot> {
  const promptFingerprintMode = input.promptFingerprintMode ?? "content";
  const graph =
    input.graph ??
    (await compilePackageGraph(input.manifest, input.packageDir, {
      validatePromptContents: promptFingerprintMode === "content"
    }));
  return {
    manifest: input.manifest,
    graph,
    manifestFile: await fingerprint(input.manifestFile),
    promptFiles: await snapshotPromptFiles(input.packageDir, promptFingerprintMode)
  };
}

export async function createPackageFileMetadataSnapshot(
  projectRoot: PackageWorkspaceRef
): Promise<PackageFileSnapshot> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  return createPackageFileSnapshotFromLoadedPackage({
    workspace,
    manifest,
    promptFingerprintMode: "stat"
  });
}

export async function createPackageFileSnapshot(
  projectRoot: PackageWorkspaceRef
): Promise<PackageFileSnapshot> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  return createPackageFileSnapshotFromLoadedPackage({ workspace, manifest });
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
      const promptPaths = new Set([
        ...Object.keys(previous.promptFiles),
        ...Object.keys(snapshot.promptFiles)
      ]);
      const changedPrompts = [...promptPaths].filter((path) =>
        changed(previous.promptFiles[path], snapshot.promptFiles[path])
      );
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
  const startedAt = performance.now();
  const detected = await detectPackageFileChanges(projectRoot, previous);
  if (!detected.snapshot || !detected.impact.ok) {
    return {
      ...detected,
      refreshed: [],
      refreshStats: promptRefreshStats({
        requested: 0,
        refreshed: 0,
        concurrency: null,
        changedPathCount: 1,
        mode: "full",
        startedAt
      }),
      changedPackagePaths: ["manifest.json"],
      indexPackagePaths: ["manifest.json"],
      incremental: false
    };
  }
  const result = detected.impact.fullRefresh
    ? await refreshPrompts({ projectRoot })
    : { prompts: [] };
  const snapshot = await createPackageFileSnapshot(projectRoot);
  const indexPackagePaths = changedPackagePaths(previous, snapshot);
  const refreshedCount = result.prompts.length;
  return {
    snapshot,
    impact: detected.impact,
    refreshed: result.prompts,
    refreshStats: promptRefreshStats({
      requested: refreshedCount,
      refreshed: refreshedCount,
      concurrency: detected.impact.fullRefresh ? null : 1,
      changedPathCount: indexPackagePaths.length,
      mode: "full",
      startedAt
    }),
    changedPackagePaths: indexPackagePaths,
    indexPackagePaths,
    incremental: false
  };
}

async function refreshFullWithDiagnostics(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot,
  diagnostics: ValidationIssue[],
  changedPackagePaths: string[],
  startedAt: number
): Promise<PackageFileSyncResult> {
  const full = await refreshChangedPackagePrompts(projectRoot, previous);
  return {
    ...full,
    impact: {
      ...full.impact,
      diagnostics: [...diagnostics, ...full.impact.diagnostics]
    },
    refreshStats: {
      ...full.refreshStats,
      elapsedMs: elapsedMs(startedAt),
      changedPathCount: changedPackagePaths.length,
      mode: "full"
    },
    changedPackagePaths,
    indexPackagePaths: full.indexPackagePaths,
    incremental: false
  };
}

export async function refreshChangedPackagePromptsForPaths(
  projectRoot: PackageWorkspaceRef,
  previous: PackageFileSnapshot,
  changedPaths: string[],
  options: PackageFileRefreshOptions = {}
): Promise<PackageFileSyncResult> {
  const startedAt = performance.now();
  const normalized = normalizePackageChangedPaths(changedPaths);
  if (!normalized.incremental) {
    return refreshFullWithDiagnostics(
      projectRoot,
      previous,
      normalized.diagnostics,
      normalized.changedPackagePaths,
      startedAt
    );
  }

  const knownPromptPaths = graphPromptPaths(previous.graph);
  const unknownPromptPaths = normalized.changedPackagePaths.filter(
    (path) => !knownPromptPaths.has(path)
  );
  if (unknownPromptPaths.length > 0) {
    return refreshFullWithDiagnostics(
      projectRoot,
      previous,
      unknownPromptPaths.map((path) =>
        issue(
          "package_change_prompt_not_in_graph",
          `Prompt '${path}' is not referenced by the current package graph; falling back to a full refresh.`,
          path
        )
      ),
      normalized.changedPackagePaths,
      startedAt
    );
  }

  try {
    const { workspace } = await loadPackage(projectRoot);
    const nextPromptFiles = { ...previous.promptFiles };
    const changedPromptPaths: string[] = [];

    for (const packagePath of normalized.changedPackagePaths) {
      if (!previous.promptFiles[packagePath]) {
        return refreshFullWithDiagnostics(
          projectRoot,
          previous,
          [
            issue(
              "package_change_prompt_added_requires_full_refresh",
              `Prompt '${packagePath}' was added; falling back to a full refresh.`,
              packagePath
            )
          ],
          normalized.changedPackagePaths,
          startedAt
        );
      }

      const nextFingerprint = await fingerprint(join(workspace.packageDir, packagePath));
      nextPromptFiles[packagePath] = nextFingerprint;
      if (changed(previous.promptFiles[packagePath], nextFingerprint)) {
        changedPromptPaths.push(packagePath);
      }
    }

    const impact = incrementalPromptImpact(previous.graph, changedPromptPaths);
    const refsToRefresh = dedupedPromptSurfaceRefsForPromptPaths(
      previous.graph,
      changedPromptPaths
    );
    const refreshConcurrency = normalizeConcurrency(
      options.refreshConcurrency ?? DEFAULT_PROMPT_REFRESH_CONCURRENCY
    );
    const refreshed = await mapWithConcurrency(refsToRefresh, refreshConcurrency, (ref) =>
      refreshPrompt({ projectRoot, ref })
    );
    return {
      snapshot: impact.ok
        ? {
            manifest: previous.manifest,
            graph: previous.graph,
            manifestFile: previous.manifestFile,
            promptFiles: nextPromptFiles
          }
        : null,
      impact,
      refreshed,
      refreshStats: promptRefreshStats({
        requested: refsToRefresh.length,
        refreshed: refreshed.length,
        concurrency: refreshConcurrency,
        changedPathCount: normalized.changedPackagePaths.length,
        mode: "incremental",
        startedAt
      }),
      changedPackagePaths: normalized.changedPackagePaths,
      indexPackagePaths: normalized.changedPackagePaths,
      incremental: true
    };
  } catch (error) {
    return refreshFullWithDiagnostics(
      projectRoot,
      previous,
      [
        issue(
          "package_change_incremental_refresh_failed",
          error instanceof Error ? error.message : String(error),
          normalized.changedPackagePaths[0]
        )
      ],
      normalized.changedPackagePaths,
      startedAt
    );
  }
}

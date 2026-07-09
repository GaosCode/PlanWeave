import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPackageFileSnapshot as createRuntimePackageFileSnapshot,
  detectPackageFileChanges as detectRuntimePackageFileChanges,
  refreshChangedPackagePrompts as refreshRuntimeChangedPackagePrompts,
  refreshChangedPackagePromptsForPaths as refreshRuntimeChangedPackagePromptsForPaths
} from "../package/fileChanges.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import type {
  CompiledExecutionGraph,
  FileFingerprint,
  PackageFileSnapshot,
  PackageWorkspaceRef,
  ProjectWorkspace
} from "../types.js";
import type { PromptRefreshStats } from "../package/fileChanges.js";
import { listTaskCanvasWorkspaces } from "./canvasApi.js";
import {
  invalidateDesktopCanvasProjection,
  invalidateDesktopProjectProjection,
  invalidateDesktopProjectProjectionDerived
} from "./graph/projectProjectionModel.js";
import type {
  DesktopPackageFileRefreshOptions,
  DesktopPackageFileSnapshotRef,
  DesktopPackageFileSyncResult
} from "./types.js";

const MAX_SNAPSHOT_IDS_PER_PROJECT = 5;

const snapshots = new Map<string, PackageFileSnapshot>();
const snapshotsById = new Map<string, { projectKey: string; snapshot: PackageFileSnapshot }>();
const snapshotIdsByProject = new Map<string, string[]>();
const dirtyRefsByProject = new Map<string, string[]>();
let nextSnapshotNumber = 1;

function nextSnapshotId(): string {
  return `PKG-SNAPSHOT-${String(nextSnapshotNumber++).padStart(4, "0")}`;
}

function changed(left: FileFingerprint | undefined, right: FileFingerprint | undefined): boolean {
  return left?.hash !== right?.hash || left?.mtimeMs !== right?.mtimeMs;
}

function promptRefsForPaths(graph: CompiledExecutionGraph, paths: string[]): string[] {
  const refs = new Set<string>();
  for (const path of paths) {
    for (const taskId of graph.taskNodesInManifestOrder) {
      const task = graph.tasksById.get(taskId);
      if (!task) {
        continue;
      }
      if (task.prompt === path) {
        refs.add(taskId);
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

function dirtyPromptRefs(previous: PackageFileSnapshot, next: PackageFileSnapshot): string[] {
  const paths = new Set([...Object.keys(previous.promptFiles), ...Object.keys(next.promptFiles)]);
  return promptRefsForPaths(
    next.graph,
    [...paths].filter((path) => changed(previous.promptFiles[path], next.promptFiles[path]))
  );
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

async function snapshotKey(projectRoot: PackageWorkspaceRef): Promise<string> {
  return (await resolvePackageWorkspace(projectRoot)).workspaceRoot;
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

/** Prompt-only package paths: under nodes/, markdown files (not manifest/policy/results/coarse dirs). */
function isPromptOnlyChangedPath(path: string): boolean {
  const normalized = normalizeWatcherPath(path);
  if (
    normalized === "manifest.json" ||
    normalized === "package/manifest.json" ||
    normalized === "policy/project-prompt.md" ||
    normalized.startsWith("policy/")
  ) {
    return false;
  }
  const packagePath = normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
  return packagePath.startsWith("nodes/") && packagePath.endsWith(".md");
}

function isPromptOnlyPackageRefresh(changedPaths: string[] | undefined): boolean {
  return (
    Array.isArray(changedPaths) &&
    changedPaths.length > 0 &&
    changedPaths.every(isPromptOnlyChangedPath)
  );
}

function stableResolvedPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function resolveCanvasIdForPackageWorkspace(
  workspace: ProjectWorkspace
): Promise<string | null> {
  const packageDir = stableResolvedPath(workspace.packageDir);
  const canvases = await listTaskCanvasWorkspaces(workspace.rootPath);
  const match = canvases.find(
    (canvas) => stableResolvedPath(canvas.workspace.packageDir) === packageDir
  );
  return match?.canvasId ?? null;
}

async function invalidateProjectionForPackageRefresh(
  projectRoot: PackageWorkspaceRef,
  options: DesktopPackageFileRefreshOptions
): Promise<void> {
  if (!isPromptOnlyPackageRefresh(options.changedPaths)) {
    invalidateDesktopProjectProjection(projectRoot);
    return;
  }
  const workspace = await resolvePackageWorkspace(projectRoot);
  const canvasId = await resolveCanvasIdForPackageWorkspace(workspace);
  if (!canvasId) {
    invalidateDesktopProjectProjectionDerived(projectRoot);
    return;
  }
  invalidateDesktopCanvasProjection(projectRoot, canvasId);
}

function displayProjectRoot(projectRoot: PackageWorkspaceRef): string {
  return typeof projectRoot === "string" ? projectRoot : projectRoot.rootPath;
}

function trimSnapshotIds(projectKey: string): void {
  const snapshotIds = snapshotIdsByProject.get(projectKey);
  if (!snapshotIds) {
    return;
  }
  while (snapshotIds.length > MAX_SNAPSHOT_IDS_PER_PROJECT) {
    const expiredId = snapshotIds.shift();
    if (!expiredId) {
      break;
    }
    snapshotsById.delete(expiredId);
  }
}

function snapshotRef(
  projectKey: string,
  projectRoot: string,
  snapshot: PackageFileSnapshot
): DesktopPackageFileSnapshotRef {
  const snapshotId = nextSnapshotId();
  snapshotsById.set(snapshotId, { projectKey, snapshot });
  const snapshotIds = snapshotIdsByProject.get(projectKey) ?? [];
  snapshotIds.push(snapshotId);
  snapshotIdsByProject.set(projectKey, snapshotIds);
  trimSnapshotIds(projectKey);
  return {
    snapshotId,
    projectRoot,
    createdAt: new Date().toISOString(),
    promptFileCount: Object.keys(snapshot.promptFiles).length
  };
}

function previousSnapshot(
  projectKey: string,
  snapshotId?: string | null
): PackageFileSnapshot | null {
  if (!snapshotId) {
    return snapshots.get(projectKey) ?? null;
  }
  const stored = snapshotsById.get(snapshotId);
  if (!stored) {
    throw new Error(`Package file snapshot '${snapshotId}' has expired or does not exist.`);
  }
  if (stored.projectKey !== projectKey) {
    throw new Error(`Package file snapshot '${snapshotId}' belongs to a different project.`);
  }
  return stored.snapshot;
}

function syncResult(options: {
  previous: PackageFileSnapshot;
  next: PackageFileSnapshot | null;
  ok: boolean;
  fullRefresh: boolean;
  affectedTasks: string[];
  diagnostics: DesktopPackageFileSyncResult["diagnostics"];
  refreshStats?: PromptRefreshStats;
  primed?: boolean;
}): DesktopPackageFileSyncResult {
  return {
    ok: options.ok,
    primed: options.primed ?? false,
    fullRefresh: options.fullRefresh,
    affectedTasks: options.affectedTasks,
    dirtyPromptRefs: options.next ? dirtyPromptRefs(options.previous, options.next) : [],
    refreshedPromptCount: options.refreshStats?.refreshed ?? 0,
    refreshConcurrency: options.refreshStats?.concurrency ?? null,
    refreshStats: options.refreshStats,
    diagnostics: options.diagnostics
  };
}

function hasExternalPackageChange(result: DesktopPackageFileSyncResult): boolean {
  return (
    result.fullRefresh ||
    result.affectedTasks.length > 0 ||
    result.dirtyPromptRefs.length > 0 ||
    result.diagnostics.length > 0
  );
}

async function indexPlanGraphExternalChange(
  projectRoot: PackageWorkspaceRef,
  paths: string[],
  result: DesktopPackageFileSyncResult
): Promise<DesktopPackageFileSyncResult> {
  if (!hasExternalPackageChange(result)) {
    return result;
  }
  if (paths.length === 0) {
    return result;
  }
  try {
    const store = await createSqlitePlanGraphStore({ projectRoot });
    const latestOperation = await store.log.latestUndoable();
    const graph = await store.indexChangedPaths(paths);
    if (!latestOperation || latestOperation.graphVersionAfter !== graph.graphVersion) {
      await store.log.clear();
    }
    return result;
  } catch (caught) {
    return {
      ...result,
      ok: false,
      diagnostics: [
        ...result.diagnostics,
        {
          code: "plangraph_index_refresh_failed",
          message: caught instanceof Error ? caught.message : String(caught),
          path: "cache/plangraph.sqlite"
        }
      ]
    };
  }
}

export async function createDesktopPackageFileSnapshot(
  projectRoot: PackageWorkspaceRef
): Promise<DesktopPackageFileSnapshotRef> {
  invalidateDesktopProjectProjection(projectRoot);
  const projectKey = await snapshotKey(projectRoot);
  const snapshot = await createRuntimePackageFileSnapshot(projectRoot);
  snapshots.set(projectKey, snapshot);
  dirtyRefsByProject.set(projectKey, []);
  return snapshotRef(projectKey, displayProjectRoot(projectRoot), snapshot);
}

export async function detectDesktopPackageFileChanges(
  projectRoot: PackageWorkspaceRef,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  invalidateDesktopProjectProjection(projectRoot);
  const projectKey = await snapshotKey(projectRoot);
  const previous = previousSnapshot(projectKey, snapshotId);
  if (!previous) {
    await createDesktopPackageFileSnapshot(projectRoot);
    return {
      ok: true,
      primed: true,
      fullRefresh: false,
      affectedTasks: [],
      dirtyPromptRefs: [],
      refreshedPromptCount: 0,
      refreshConcurrency: null,
      diagnostics: []
    };
  }
  const result = await detectRuntimePackageFileChanges(projectRoot, previous);
  const detected = syncResult({
    previous,
    next: result.snapshot,
    ok: result.impact.ok,
    fullRefresh: result.impact.fullRefresh,
    affectedTasks: result.impact.affectedTasks,
    diagnostics: result.impact.diagnostics
  });
  dirtyRefsByProject.set(projectKey, detected.dirtyPromptRefs);
  return indexPlanGraphExternalChange(
    projectRoot,
    result.snapshot ? changedPackagePaths(previous, result.snapshot) : ["manifest.json"],
    detected
  );
}

export async function refreshChangedDesktopPackagePrompts(
  projectRoot: PackageWorkspaceRef,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  invalidateDesktopProjectProjection(projectRoot);
  const projectKey = await snapshotKey(projectRoot);
  const previous = previousSnapshot(projectKey, snapshotId);
  if (!previous) {
    await createDesktopPackageFileSnapshot(projectRoot);
    return {
      ok: true,
      primed: true,
      fullRefresh: false,
      affectedTasks: [],
      dirtyPromptRefs: [],
      refreshedPromptCount: 0,
      refreshConcurrency: null,
      diagnostics: []
    };
  }
  const result = await refreshRuntimeChangedPackagePrompts(projectRoot, previous);
  if (!result.snapshot) {
    const failed = syncResult({
      previous,
      next: null,
      ok: result.impact.ok,
      fullRefresh: result.impact.fullRefresh,
      affectedTasks: result.impact.affectedTasks,
      diagnostics: result.impact.diagnostics,
      refreshStats: result.refreshStats
    });
    dirtyRefsByProject.set(projectKey, failed.dirtyPromptRefs);
    return indexPlanGraphExternalChange(projectRoot, ["manifest.json"], failed);
  }
  snapshots.set(projectKey, result.snapshot);
  const refreshed = syncResult({
    previous,
    next: result.snapshot,
    ok: result.impact.ok,
    fullRefresh: result.impact.fullRefresh,
    affectedTasks: result.impact.affectedTasks,
    diagnostics: result.impact.diagnostics,
    refreshStats: result.refreshStats
  });
  dirtyRefsByProject.set(projectKey, refreshed.dirtyPromptRefs);
  return indexPlanGraphExternalChange(
    projectRoot,
    changedPackagePaths(previous, result.snapshot),
    refreshed
  );
}

export async function refreshPackageFileChanges(
  projectRoot: PackageWorkspaceRef,
  options: DesktopPackageFileRefreshOptions = {}
): Promise<DesktopPackageFileSyncResult> {
  await invalidateProjectionForPackageRefresh(projectRoot, options);
  const projectKey = await snapshotKey(projectRoot);
  const previous = snapshots.get(projectKey);
  if (!previous) {
    await createDesktopPackageFileSnapshot(projectRoot);
    return {
      ok: true,
      primed: true,
      fullRefresh: false,
      affectedTasks: [],
      dirtyPromptRefs: [],
      refreshedPromptCount: 0,
      refreshConcurrency: null,
      diagnostics: []
    };
  }

  const result = options.changedPaths
    ? await refreshRuntimeChangedPackagePromptsForPaths(projectRoot, previous, options.changedPaths)
    : await refreshRuntimeChangedPackagePrompts(projectRoot, previous);
  if (!result.snapshot) {
    const failed: DesktopPackageFileSyncResult = {
      ok: result.impact.ok,
      primed: false,
      fullRefresh: result.impact.fullRefresh,
      affectedTasks: result.impact.affectedTasks,
      dirtyPromptRefs: [],
      refreshedPromptCount: result.refreshStats.refreshed,
      refreshConcurrency: result.refreshStats.concurrency,
      refreshStats: result.refreshStats,
      diagnostics: result.impact.diagnostics
    };
    dirtyRefsByProject.set(projectKey, failed.dirtyPromptRefs);
    return indexPlanGraphExternalChange(projectRoot, result.indexPackagePaths, failed);
  }
  snapshots.set(projectKey, result.snapshot);
  const dirtyPromptRefsForResult = dirtyPromptRefs(previous, result.snapshot);
  dirtyRefsByProject.set(projectKey, dirtyPromptRefsForResult);
  const refreshed: DesktopPackageFileSyncResult = {
    ok: result.impact.ok,
    primed: false,
    fullRefresh: result.impact.fullRefresh,
    affectedTasks: result.impact.affectedTasks,
    dirtyPromptRefs: dirtyPromptRefsForResult,
    refreshedPromptCount: result.refreshStats.refreshed,
    refreshConcurrency: result.refreshStats.concurrency,
    refreshStats: result.refreshStats,
    diagnostics: result.impact.diagnostics
  };
  return indexPlanGraphExternalChange(projectRoot, result.indexPackagePaths, refreshed);
}

export async function getDirtyPromptRefs(projectRoot: PackageWorkspaceRef): Promise<string[]> {
  return dirtyRefsByProject.get(await snapshotKey(projectRoot)) ?? [];
}

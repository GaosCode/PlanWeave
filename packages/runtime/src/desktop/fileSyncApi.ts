import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  changedPackagePromptOwners,
  normalizePackageChangedPaths,
  createPackageFileSnapshot as createRuntimePackageFileSnapshot,
  detectPackageFileChanges as detectRuntimePackageFileChanges,
  refreshChangedPackagePrompts as refreshRuntimeChangedPackagePrompts,
  refreshChangedPackagePromptsForPaths as refreshRuntimeChangedPackagePromptsForPaths
} from "../package/fileChanges.js";
import { promptWatchAliases } from "../package/promptInventory.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { createSqlitePlanGraphStore, defaultPlanGraphIndexPath } from "../plangraph/sqliteIndex.js";
import { resolveProjectWorkspaceInHome, withCurrentProjectWorkspace } from "../project.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";
import { assertCurrentCanvasWorkspace } from "../package/assertCurrentCanvasWorkspace.js";
import type { PackageFileSnapshot, PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import type { PromptRefreshStats } from "../package/fileChanges.js";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../projectGraph/index.js";
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

async function snapshotKey(projectRoot: PackageWorkspaceRef): Promise<string> {
  return (await resolvePackageWorkspace(projectRoot)).workspaceRoot;
}

async function withFileSyncWorkspace<T>(
  projectRoot: PackageWorkspaceRef,
  apply: (workspace: ProjectWorkspace) => Promise<T>
): Promise<T> {
  const workspace = await resolvePackageWorkspace(projectRoot);
  return withCurrentProjectWorkspace(workspace, () =>
    withPackageFileConsistency(
      [workspace.packageDir, workspace.stateFile, workspace.resultsDir],
      async () => {
        await assertCurrentCanvasWorkspace(workspace);
        return apply(workspace);
      }
    )
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
  const parent = await resolveProjectWorkspaceInHome(workspace.rootPath, workspace.planweaveHome);
  const graph = await loadProjectGraphForWorkspace(parent);
  const match = graph.manifest.canvases.find(
    (canvas) =>
      stableResolvedPath(projectCanvasWorkspace(graph.workspace, canvas).packageDir) === packageDir
  );
  return match?.id ?? null;
}

async function invalidateProjectionForPackageRefresh(
  projectRoot: PackageWorkspaceRef,
  options: DesktopPackageFileRefreshOptions,
  previous: PackageFileSnapshot
): Promise<void> {
  if (
    !normalizePackageChangedPaths(
      options.changedPaths,
      previous.promptTargets && promptWatchAliases(previous.promptTargets)
    ).incremental
  ) {
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
    dirtyPromptRefs: options.next ? changedPackagePromptOwners(options.previous, options.next) : [],
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
  result: DesktopPackageFileSyncResult,
  observedSnapshot?: PackageFileSnapshot
): Promise<DesktopPackageFileSyncResult> {
  if (!hasExternalPackageChange(result)) {
    return result;
  }
  if (paths.length === 0) {
    return result;
  }
  try {
    const workspace = await resolvePackageWorkspace(projectRoot);
    const project = await resolveProjectWorkspaceInHome(
      workspace.rootPath,
      workspace.planweaveHome
    );
    const store = await createSqlitePlanGraphStore({
      projectRoot: workspace,
      indexPath: defaultPlanGraphIndexPath(project)
    });
    const [undo, redo] = await Promise.all([
      store.log.latestUndoable(),
      store.log.latestRedoable()
    ]);
    const graph = await store.indexChangedPaths(paths, {
      snapshot: observedSnapshot && {
        workspace,
        manifest: observedSnapshot.manifest,
        compiledGraph: observedSnapshot.graph,
        promptMarkdownByPath: observedSnapshot.promptMarkdown,
        promptDiagnosticsByPath: observedSnapshot.promptReadFailures
      }
    });
    const cursorVersion = redo ? redo.graphVersionBefore : undo?.graphVersionAfter;
    if (
      cursorVersion !== graph.graphVersion ||
      (undo && undo.graphVersionAfter !== graph.graphVersion)
    ) {
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
  return withFileSyncWorkspace(projectRoot, (workspace) =>
    createDesktopPackageFileSnapshotLocked(workspace, displayProjectRoot(projectRoot))
  );
}

async function createDesktopPackageFileSnapshotLocked(
  projectRoot: ProjectWorkspace,
  displayRoot = projectRoot.rootPath
): Promise<DesktopPackageFileSnapshotRef> {
  invalidateDesktopProjectProjection(projectRoot);
  const projectKey = await snapshotKey(projectRoot);
  const snapshot = await createRuntimePackageFileSnapshot(projectRoot);
  snapshots.set(projectKey, snapshot);
  dirtyRefsByProject.set(projectKey, []);
  return snapshotRef(projectKey, displayRoot, snapshot);
}

export async function detectDesktopPackageFileChanges(
  projectRoot: PackageWorkspaceRef,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  return withFileSyncWorkspace(projectRoot, (workspace) =>
    detectDesktopPackageFileChangesLocked(workspace, snapshotId)
  );
}

async function detectDesktopPackageFileChangesLocked(
  projectRoot: ProjectWorkspace,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  invalidateDesktopProjectProjection(projectRoot);
  const projectKey = await snapshotKey(projectRoot);
  const previous = previousSnapshot(projectKey, snapshotId);
  if (!previous) {
    await createDesktopPackageFileSnapshotLocked(projectRoot);
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
    result.indexPackagePaths,
    detected,
    result.observedSnapshot
  );
}

export async function refreshChangedDesktopPackagePrompts(
  projectRoot: PackageWorkspaceRef,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  return withFileSyncWorkspace(projectRoot, (workspace) =>
    refreshChangedDesktopPackagePromptsLocked(workspace, snapshotId)
  );
}

async function refreshChangedDesktopPackagePromptsLocked(
  projectRoot: ProjectWorkspace,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  invalidateDesktopProjectProjection(projectRoot);
  const projectKey = await snapshotKey(projectRoot);
  const previous = previousSnapshot(projectKey, snapshotId);
  if (!previous) {
    await createDesktopPackageFileSnapshotLocked(projectRoot);
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
    return indexPlanGraphExternalChange(
      projectRoot,
      result.indexPackagePaths,
      failed,
      result.observedSnapshot
    );
  }
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
  const indexed = await indexPlanGraphExternalChange(
    projectRoot,
    result.indexPackagePaths,
    refreshed,
    result.observedSnapshot
  );
  if (indexed.ok) snapshots.set(projectKey, result.snapshot);
  return indexed;
}

export async function refreshPackageFileChanges(
  projectRoot: PackageWorkspaceRef,
  options: DesktopPackageFileRefreshOptions = {}
): Promise<DesktopPackageFileSyncResult> {
  return withFileSyncWorkspace(projectRoot, (workspace) =>
    refreshPackageFileChangesLocked(workspace, options)
  );
}

async function refreshPackageFileChangesLocked(
  projectRoot: ProjectWorkspace,
  options: DesktopPackageFileRefreshOptions
): Promise<DesktopPackageFileSyncResult> {
  const projectKey = await snapshotKey(projectRoot);
  const previous = snapshots.get(projectKey);
  if (!previous) {
    await createDesktopPackageFileSnapshotLocked(projectRoot);
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

  await invalidateProjectionForPackageRefresh(projectRoot, options, previous);
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
    const indexed = await indexPlanGraphExternalChange(
      projectRoot,
      result.indexPackagePaths,
      failed,
      result.observedSnapshot
    );
    if (
      result.observedSnapshot &&
      !indexed.diagnostics.some(({ code }) => code === "plangraph_index_refresh_failed")
    ) {
      snapshots.set(projectKey, result.observedSnapshot);
    }
    return indexed;
  }
  const dirtyPromptRefsForResult = changedPackagePromptOwners(
    previous,
    result.snapshot,
    result.indexPackagePaths
  );
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
  const indexed = await indexPlanGraphExternalChange(
    projectRoot,
    result.indexPackagePaths,
    refreshed,
    result.snapshot
  );
  if (indexed.ok) snapshots.set(projectKey, result.snapshot);
  return indexed;
}

export async function getDirtyPromptRefs(projectRoot: PackageWorkspaceRef): Promise<string[]> {
  return dirtyRefsByProject.get(await snapshotKey(projectRoot)) ?? [];
}

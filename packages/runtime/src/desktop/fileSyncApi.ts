import {
  createPackageFileSnapshot as createRuntimePackageFileSnapshot,
  detectPackageFileChanges as detectRuntimePackageFileChanges,
  refreshChangedPackagePrompts as refreshRuntimeChangedPackagePrompts
} from "../package/fileChanges.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type {
  CompiledExecutionGraph,
  FileFingerprint,
  PackageWorkspaceRef,
  PackageFileSnapshot
} from "../types.js";
import type { DesktopPackageFileSnapshotRef, DesktopPackageFileSyncResult } from "./types.js";

const snapshots = new Map<string, PackageFileSnapshot>();
const snapshotsById = new Map<string, PackageFileSnapshot>();
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

async function snapshotKey(projectRoot: PackageWorkspaceRef): Promise<string> {
  return (await resolvePackageWorkspace(projectRoot)).workspaceRoot;
}

function snapshotRef(projectRoot: string, snapshot: PackageFileSnapshot): DesktopPackageFileSnapshotRef {
  const snapshotId = nextSnapshotId();
  snapshotsById.set(snapshotId, snapshot);
  return {
    snapshotId,
    projectRoot,
    createdAt: new Date().toISOString(),
    promptFileCount: Object.keys(snapshot.promptFiles).length
  };
}

function previousSnapshot(projectKey: string, snapshotId?: string | null): PackageFileSnapshot | null {
  if (!snapshotId) {
    return snapshots.get(projectKey) ?? null;
  }
  const snapshot = snapshotsById.get(snapshotId);
  if (!snapshot) {
    throw new Error(`Package file snapshot '${snapshotId}' does not exist.`);
  }
  return snapshot;
}

function syncResult(options: {
  previous: PackageFileSnapshot;
  next: PackageFileSnapshot | null;
  ok: boolean;
  fullRefresh: boolean;
  affectedTasks: string[];
  diagnostics: DesktopPackageFileSyncResult["diagnostics"];
  primed?: boolean;
}): DesktopPackageFileSyncResult {
  return {
    ok: options.ok,
    primed: options.primed ?? false,
    fullRefresh: options.fullRefresh,
    affectedTasks: options.affectedTasks,
    dirtyPromptRefs: options.next ? dirtyPromptRefs(options.previous, options.next) : [],
    diagnostics: options.diagnostics
  };
}

export async function createDesktopPackageFileSnapshot(projectRoot: PackageWorkspaceRef): Promise<DesktopPackageFileSnapshotRef> {
  const projectKey = await snapshotKey(projectRoot);
  const displayProjectRoot = typeof projectRoot === "string" ? projectRoot : projectRoot.rootPath;
  const snapshot = await createRuntimePackageFileSnapshot(projectRoot);
  snapshots.set(projectKey, snapshot);
  dirtyRefsByProject.set(projectKey, []);
  return snapshotRef(displayProjectRoot, snapshot);
}

export async function detectDesktopPackageFileChanges(
  projectRoot: PackageWorkspaceRef,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
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
  return detected;
}

export async function refreshChangedDesktopPackagePrompts(
  projectRoot: PackageWorkspaceRef,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
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
      diagnostics: result.impact.diagnostics
    });
    dirtyRefsByProject.set(projectKey, failed.dirtyPromptRefs);
    return failed;
  }
  snapshots.set(projectKey, result.snapshot);
  snapshotRef(projectKey, result.snapshot);
  const refreshed = syncResult({
    previous,
    next: result.snapshot,
    ok: result.impact.ok,
    fullRefresh: result.impact.fullRefresh,
    affectedTasks: result.impact.affectedTasks,
    diagnostics: result.impact.diagnostics
  });
  dirtyRefsByProject.set(projectKey, refreshed.dirtyPromptRefs);
  return refreshed;
}

export async function refreshPackageFileChanges(projectRoot: PackageWorkspaceRef): Promise<DesktopPackageFileSyncResult> {
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
      diagnostics: []
    };
  }

  const result = await refreshRuntimeChangedPackagePrompts(projectRoot, previous);
  if (!result.snapshot) {
    dirtyRefsByProject.set(projectKey, []);
    return {
      ok: result.impact.ok,
      primed: false,
      fullRefresh: result.impact.fullRefresh,
      affectedTasks: result.impact.affectedTasks,
      dirtyPromptRefs: [],
      diagnostics: result.impact.diagnostics
    };
  }
  snapshots.set(projectKey, result.snapshot);
  snapshotRef(projectKey, result.snapshot);
  const dirtyPromptRefsForResult = dirtyPromptRefs(previous, result.snapshot);
  dirtyRefsByProject.set(projectKey, dirtyPromptRefsForResult);
  return {
    ok: result.impact.ok,
    primed: false,
    fullRefresh: result.impact.fullRefresh,
    affectedTasks: result.impact.affectedTasks,
    dirtyPromptRefs: dirtyPromptRefsForResult,
    diagnostics: result.impact.diagnostics
  };
}

export async function getDirtyPromptRefs(projectRoot: PackageWorkspaceRef): Promise<string[]> {
  return dirtyRefsByProject.get(await snapshotKey(projectRoot)) ?? [];
}

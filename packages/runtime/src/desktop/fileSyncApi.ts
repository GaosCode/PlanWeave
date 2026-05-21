import {
  createPackageFileSnapshot as createRuntimePackageFileSnapshot,
  detectPackageFileChanges as detectRuntimePackageFileChanges,
  refreshChangedPackagePrompts as refreshRuntimeChangedPackagePrompts
} from "../package/fileChanges.js";
import type {
  CompiledExecutionGraph,
  FileFingerprint,
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

function previousSnapshot(projectRoot: string, snapshotId?: string | null): PackageFileSnapshot | null {
  if (!snapshotId) {
    return snapshots.get(projectRoot) ?? null;
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

export async function createDesktopPackageFileSnapshot(projectRoot: string): Promise<DesktopPackageFileSnapshotRef> {
  const snapshot = await createRuntimePackageFileSnapshot(projectRoot);
  snapshots.set(projectRoot, snapshot);
  dirtyRefsByProject.set(projectRoot, []);
  return snapshotRef(projectRoot, snapshot);
}

export async function detectDesktopPackageFileChanges(
  projectRoot: string,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  const previous = previousSnapshot(projectRoot, snapshotId);
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
  dirtyRefsByProject.set(projectRoot, detected.dirtyPromptRefs);
  return detected;
}

export async function refreshChangedDesktopPackagePrompts(
  projectRoot: string,
  snapshotId?: string | null
): Promise<DesktopPackageFileSyncResult> {
  const previous = previousSnapshot(projectRoot, snapshotId);
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
    dirtyRefsByProject.set(projectRoot, failed.dirtyPromptRefs);
    return failed;
  }
  snapshots.set(projectRoot, result.snapshot);
  snapshotRef(projectRoot, result.snapshot);
  const refreshed = syncResult({
    previous,
    next: result.snapshot,
    ok: result.impact.ok,
    fullRefresh: result.impact.fullRefresh,
    affectedTasks: result.impact.affectedTasks,
    diagnostics: result.impact.diagnostics
  });
  dirtyRefsByProject.set(projectRoot, refreshed.dirtyPromptRefs);
  return refreshed;
}

export async function refreshPackageFileChanges(projectRoot: string): Promise<DesktopPackageFileSyncResult> {
  const previous = snapshots.get(projectRoot);
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
    dirtyRefsByProject.set(projectRoot, []);
    return {
      ok: result.impact.ok,
      primed: false,
      fullRefresh: result.impact.fullRefresh,
      affectedTasks: result.impact.affectedTasks,
      dirtyPromptRefs: [],
      diagnostics: result.impact.diagnostics
    };
  }
  snapshots.set(projectRoot, result.snapshot);
  snapshotRef(projectRoot, result.snapshot);
  const dirtyPromptRefsForResult = dirtyPromptRefs(previous, result.snapshot);
  dirtyRefsByProject.set(projectRoot, dirtyPromptRefsForResult);
  return {
    ok: result.impact.ok,
    primed: false,
    fullRefresh: result.impact.fullRefresh,
    affectedTasks: result.impact.affectedTasks,
    dirtyPromptRefs: dirtyPromptRefsForResult,
    diagnostics: result.impact.diagnostics
  };
}

export async function getDirtyPromptRefs(projectRoot: string): Promise<string[]> {
  return dirtyRefsByProject.get(projectRoot) ?? [];
}

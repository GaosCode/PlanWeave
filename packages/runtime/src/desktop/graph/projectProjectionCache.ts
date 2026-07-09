import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { FileFingerprint, PackageFileSnapshot, PackageWorkspaceRef, ValidationIssue } from "../../types.js";
import type { ProjectCanvasRuntimeSnapshot } from "./projectCanvasAggregation.js";
import {
  clearResultsFileIndexCache,
  type ResultsFileFingerprintSnapshot,
  type ResultsFileIndex
} from "./resultsFileIndex.js";
import type { DesktopSearchIndex } from "./searchIndexModel.js";
import type { DesktopStatisticsProjection } from "./statisticsIndexModel.js";
import type { CanvasExecutionSnapshot, ProjectTodoContext } from "./todoModel.js";

export type DesktopProjectProjection = {
  projectRoot: string;
  todoContext: ProjectTodoContext;
  resultsByCanvas: Map<string, ResultsFileIndex>;
  diagnostics: ValidationIssue[];
};

export type DesktopProjectProjectionContext = {
  key: string;
  projection: DesktopProjectProjection;
};

export type FileStatFingerprint = {
  path: string;
  mtimeMs: number;
  size: number;
};

export type PackageInputFingerprint = {
  manifestFile: FileFingerprint;
  promptFiles: Record<string, FileFingerprint>;
};

export type ProjectInputFingerprint = {
  projectFile: FileStatFingerprint | null;
  projectGraphFile: FileStatFingerprint | null;
  legacyCanvasRegistryFile: FileStatFingerprint | null;
};

export type CanvasWorkspaceFingerprint = {
  rootPath: string;
  packageDir: string;
  stateFile: string;
  resultsDir: string;
};

export type CanvasRuntimeInputFingerprint = {
  workspace: CanvasWorkspaceFingerprint;
  packageFiles: PackageInputFingerprint;
  stateFile: FileStatFingerprint | null;
};

export type CanvasRuntimeInput = {
  fingerprint: CanvasRuntimeInputFingerprint;
  snapshot: PackageFileSnapshot;
};

export type CanvasBlockerFingerprint = {
  canvasDependencies: Array<{ canvasId: string; complete: boolean }>;
  crossTaskDependencies: Array<{
    canvasId: string;
    taskId: string;
    dependsOnCanvasId: string;
    dependsOnTaskId: string;
    status: string | null;
  }>;
};

export type CanvasProjectionFingerprint = CanvasRuntimeInputFingerprint & {
  results: ResultsFileFingerprintSnapshot;
  blockers: CanvasBlockerFingerprint;
};

export type CanvasProjectionCacheEntry = {
  version: number;
  fingerprint: CanvasProjectionFingerprint | null;
  runtimeSnapshot: ProjectCanvasRuntimeSnapshot;
  snapshot: CanvasExecutionSnapshot;
  resultsIndex: ResultsFileIndex;
  searchIndex: DesktopSearchIndex;
  bodySearchIndex: DesktopSearchIndex | null;
};

export type CachedProjectProjection = {
  version: number;
  projection: DesktopProjectProjection;
  projectFingerprint: ProjectInputFingerprint;
  canvases: Map<string, CanvasProjectionCacheEntry>;
  searchIndex: DesktopSearchIndex | null;
  bodySearchIndex: DesktopSearchIndex | null;
  statisticsProjection: DesktopStatisticsProjection | null;
};

export const desktopProjectProjectionCacheVersion = 2;
export const projectProjectionCache = new Map<string, CachedProjectProjection>();
export const projectionContextCache = new WeakMap<DesktopProjectProjectionContext, CachedProjectProjection>();

function stableResolvedPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function projectProjectionKey(projectRoot: PackageWorkspaceRef): string {
  return stableResolvedPath(typeof projectRoot === "string" ? projectRoot : projectRoot.rootPath);
}

export function invalidateDesktopProjectProjection(projectRoot?: PackageWorkspaceRef): void {
  if (!projectRoot) {
    projectProjectionCache.clear();
    clearResultsFileIndexCache();
    return;
  }
  const key = projectProjectionKey(projectRoot);
  const cached = projectProjectionCache.get(key);
  if (cached) {
    for (const entry of cached.canvases.values()) {
      clearResultsFileIndexCache({ resultsDir: entry.resultsIndex.workspace.resultsDir });
    }
  }
  projectProjectionCache.delete(key);
}

/**
 * Drop one canvas's derived projection entry while keeping sibling canvases and
 * results-index caches. Prompt-only edits do not change results fingerprints.
 */
export function invalidateDesktopCanvasProjection(projectRoot: PackageWorkspaceRef, canvasId: string): void {
  const key = projectProjectionKey(projectRoot);
  const cached = projectProjectionCache.get(key);
  if (!cached || !cached.canvases.has(canvasId)) {
    return;
  }
  cached.canvases.delete(canvasId);
  cached.searchIndex = null;
  cached.bodySearchIndex = null;
  cached.statisticsProjection = null;
}

/**
 * Clear every canvas's derived projection for a project without touching
 * results-index caches. Used when a change is prompt-only but cannot be
 * attributed to a specific canvas.
 */
export function invalidateDesktopProjectProjectionDerived(projectRoot: PackageWorkspaceRef): void {
  const key = projectProjectionKey(projectRoot);
  const cached = projectProjectionCache.get(key);
  if (!cached) {
    return;
  }
  cached.canvases.clear();
  cached.searchIndex = null;
  cached.bodySearchIndex = null;
  cached.statisticsProjection = null;
}

/** Test helper: return the cached canvas projection entry object for identity assertions. */
export function peekDesktopCanvasProjectionCacheEntryForTests(
  projectRoot: PackageWorkspaceRef,
  canvasId: string
): object | undefined {
  return projectProjectionCache.get(projectProjectionKey(projectRoot))?.canvases.get(canvasId);
}

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  FileFingerprint,
  PackageFileSnapshot,
  PackageWorkspaceRef,
  ValidationIssue
} from "../../types.js";
import type { ProjectCanvasRuntimeSnapshot } from "./projectCanvasAggregation.js";
import {
  clearResultsFileIndexCache,
  maxCachedResultsDirectories,
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
const maxCachedDesktopProjectProjections = maxCachedResultsDirectories;

export class DesktopProjectProjectionLru<T> {
  private readonly entries = new Map<string, T>();

  constructor(
    private readonly maxEntries: number,
    private readonly release: (value: T, replacement?: T) => void
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Desktop project projection cache capacity must be a positive integer.");
    }
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  peek(key: string): T | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    const previous = this.entries.get(key);
    this.entries.delete(key);
    if (previous !== undefined && !Object.is(previous, value)) {
      this.release(previous, value);
    }
    this.entries.set(key, value);
    this.trim();
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (value === undefined) {
      return false;
    }
    this.entries.delete(key);
    this.release(value);
    return true;
  }

  clear(): void {
    for (const value of this.entries.values()) {
      this.release(value);
    }
    this.entries.clear();
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.delete(oldestKey);
    }
  }
}

function releaseDesktopProjectProjection(
  cached: CachedProjectProjection,
  replacement?: CachedProjectProjection
): void {
  const retainedCanvasEntries = new Set(replacement?.canvases.values() ?? []);
  const retainedResultsIndexes = new Set(replacement?.projection.resultsByCanvas.values() ?? []);
  const retainedResultsDirectories = new Set(
    Array.from(replacement?.projection.resultsByCanvas.values() ?? [], (index) =>
      resolve(index.workspace.resultsDir)
    )
  );
  const releasedResultsDirectories = new Set<string>();
  for (const [canvasId, resultsIndex] of cached.projection.resultsByCanvas) {
    const cachedCanvasEntry = cached.canvases.get(canvasId);
    const resultsDir = resolve(resultsIndex.workspace.resultsDir);
    if (
      (!cachedCanvasEntry || !retainedCanvasEntries.has(cachedCanvasEntry)) &&
      !retainedResultsIndexes.has(resultsIndex) &&
      !retainedResultsDirectories.has(resultsDir) &&
      !releasedResultsDirectories.has(resultsDir)
    ) {
      clearResultsFileIndexCache({ resultsDir });
      releasedResultsDirectories.add(resultsDir);
    }
  }
  cached.canvases = new Map();
  cached.searchIndex = null;
  cached.bodySearchIndex = null;
  cached.statisticsProjection = null;
}

function createDesktopProjectProjectionCache(
  maxEntries: number
): DesktopProjectProjectionLru<CachedProjectProjection> {
  return new DesktopProjectProjectionLru(maxEntries, releaseDesktopProjectProjection);
}

let projectProjectionCache = createDesktopProjectProjectionCache(
  maxCachedDesktopProjectProjections
);
export const projectionContextCache = new WeakMap<
  DesktopProjectProjectionContext,
  CachedProjectProjection
>();

export function getCachedDesktopProjectProjection(
  key: string
): CachedProjectProjection | undefined {
  return projectProjectionCache.get(key);
}

export function peekCachedDesktopProjectProjection(
  key: string
): CachedProjectProjection | undefined {
  return projectProjectionCache.peek(key);
}

export function setCachedDesktopProjectProjection(
  key: string,
  value: CachedProjectProjection
): void {
  projectProjectionCache.set(key, value);
}

export function useDesktopProjectProjectionCacheCapacityForTests(maxEntries: number): () => void {
  const previous = projectProjectionCache;
  previous.clear();
  const testCache = createDesktopProjectProjectionCache(maxEntries);
  projectProjectionCache = testCache;
  return () => {
    if (projectProjectionCache === testCache) {
      testCache.clear();
      projectProjectionCache = previous;
    }
  };
}

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
  projectProjectionCache.delete(key);
}

/**
 * Drop one canvas's derived projection entry while keeping sibling canvases and
 * results-index caches. Prompt-only edits do not change results fingerprints.
 */
export function invalidateDesktopCanvasProjection(
  projectRoot: PackageWorkspaceRef,
  canvasId: string
): void {
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
  return projectProjectionCache.peek(projectProjectionKey(projectRoot))?.canvases.get(canvasId);
}

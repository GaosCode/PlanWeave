import { realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { isNodeFileNotFoundError, optionalStat } from "../../fs/optionalFile.js";
import { createPackageFileMetadataSnapshot } from "../../package/fileChanges.js";
import { createExecutionGraphSessionFromSnapshot } from "../../graph/session.js";
import { resolveProjectWorkspace } from "../../project.js";
import { projectGraphPath } from "../../projectGraph/index.js";
import { loadRuntimeReadonly, type RuntimeContext } from "../../taskManager/runtimeContext.js";
import type { FileFingerprint, PackageFileSnapshot, PackageWorkspaceRef, ProjectWorkspace, ValidationIssue } from "../../types.js";
import { appendDesktopDiagnostic, desktopDiagnostic, errorMessage } from "./desktopDiagnostics.js";
import {
  loadProjectCanvasAggregation,
  runtimeSnapshotFromGraphState,
  type ProjectCanvasAggregationContext,
  type ProjectCanvasRuntimeSnapshot
} from "./projectCanvasAggregation.js";
import {
  buildResultsFileIndexFromFingerprintSnapshot,
  clearResultsFileIndexCache,
  hydrateResultsFileIndexBodies,
  sameResultsFileFingerprintSnapshot,
  snapshotResultsFileFingerprints,
  type ResultsFileFingerprintSnapshot,
  type ResultsFileIndex
} from "./resultsFileIndex.js";
import {
  buildSearchBodyIndexForCanvas,
  buildSearchIndexForCanvas,
  buildSearchIndexFromCanvasIndexes,
  mergeSearchIndexBodies,
  type DesktopSearchIndex
} from "./searchIndexModel.js";
import { buildStatisticsProjectionFromIndexes, type DesktopStatisticsProjection } from "./statisticsIndexModel.js";
import {
  buildCanvasExecutionSnapshot,
  failedCanvasExecutionSnapshot,
  type CanvasExecutionSnapshot,
  type ProjectTodoContext
} from "./todoModel.js";

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

type CachedProjectProjection = {
  version: number;
  projection: DesktopProjectProjection;
  projectFingerprint: ProjectInputFingerprint;
  canvases: Map<string, CanvasProjectionCacheEntry>;
  searchIndex: DesktopSearchIndex | null;
  bodySearchIndex: DesktopSearchIndex | null;
  statisticsProjection: DesktopStatisticsProjection | null;
};

type CanvasProjectionCacheEntry = {
  version: number;
  fingerprint: CanvasProjectionFingerprint | null;
  runtimeSnapshot: ProjectCanvasRuntimeSnapshot;
  snapshot: CanvasExecutionSnapshot;
  resultsIndex: ResultsFileIndex;
  searchIndex: DesktopSearchIndex;
  bodySearchIndex: DesktopSearchIndex | null;
};

const desktopProjectProjectionCacheVersion = 2;
const projectProjectionCache = new Map<string, CachedProjectProjection>();
const projectionContextCache = new WeakMap<DesktopProjectProjectionContext, CachedProjectProjection>();

type FileStatFingerprint = {
  path: string;
  mtimeMs: number;
  size: number;
};

type PackageInputFingerprint = {
  manifestFile: FileFingerprint;
  promptFiles: Record<string, FileFingerprint>;
};

type ProjectInputFingerprint = {
  projectFile: FileStatFingerprint | null;
  projectGraphFile: FileStatFingerprint | null;
  legacyCanvasRegistryFile: FileStatFingerprint | null;
};

type CanvasWorkspaceFingerprint = {
  rootPath: string;
  packageDir: string;
  stateFile: string;
  resultsDir: string;
};

type CanvasRuntimeInputFingerprint = {
  workspace: CanvasWorkspaceFingerprint;
  packageFiles: PackageInputFingerprint;
  stateFile: FileStatFingerprint | null;
};

type CanvasRuntimeInput = {
  fingerprint: CanvasRuntimeInputFingerprint;
  snapshot: PackageFileSnapshot;
};

type CanvasBlockerFingerprint = {
  canvasDependencies: Array<{ canvasId: string; complete: boolean }>;
  crossTaskDependencies: Array<{
    canvasId: string;
    taskId: string;
    dependsOnCanvasId: string;
    dependsOnTaskId: string;
    status: string | null;
  }>;
};

type CanvasProjectionFingerprint = CanvasRuntimeInputFingerprint & {
  results: ResultsFileFingerprintSnapshot;
  blockers: CanvasBlockerFingerprint;
};

function stableResolvedPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function projectProjectionKey(projectRoot: PackageWorkspaceRef): string {
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

async function optionalFileStatFingerprint(path: string): Promise<FileStatFingerprint | null> {
  const metadata = await optionalStat(path);
  if (!metadata) {
    return null;
  }
  return {
    path,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size
  };
}

function packageInputFingerprintFromSnapshot(snapshot: PackageFileSnapshot): PackageInputFingerprint {
  return {
    manifestFile: snapshot.manifestFile,
    promptFiles: snapshot.promptFiles
  };
}

function workspaceFingerprint(workspace: ProjectWorkspace): CanvasWorkspaceFingerprint {
  return {
    rootPath: resolve(workspace.rootPath),
    packageDir: resolve(workspace.packageDir),
    stateFile: resolve(workspace.stateFile),
    resultsDir: resolve(workspace.resultsDir)
  };
}

async function canvasRuntimeInput(workspace: ProjectWorkspace): Promise<CanvasRuntimeInput | null> {
  try {
    const snapshot = await createPackageFileMetadataSnapshot(workspace);
    return await canvasRuntimeInputFromSnapshot(workspace, snapshot);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function canvasRuntimeInputFromSnapshot(workspace: ProjectWorkspace, snapshot: PackageFileSnapshot): Promise<CanvasRuntimeInput> {
  return {
    fingerprint: {
      workspace: workspaceFingerprint(workspace),
      packageFiles: packageInputFingerprintFromSnapshot(snapshot),
      stateFile: await optionalFileStatFingerprint(workspace.stateFile)
    },
    snapshot
  };
}

async function canvasRuntimeInputWithDiagnostics(
  workspace: ProjectWorkspace,
  canvasId: string,
  diagnostics: ValidationIssue[]
): Promise<CanvasRuntimeInput | null> {
  try {
    return await canvasRuntimeInput(workspace);
  } catch (caught) {
    appendDesktopDiagnostic(
      diagnostics,
      desktopDiagnostic("desktop_canvas_runtime_input_failed", `Canvas runtime input could not be read: ${errorMessage(caught)}`, canvasId)
    );
    return null;
  }
}

async function cachedCanvasRuntimeInput(
  workspace: ProjectWorkspace,
  canvasId: string,
  diagnostics: ValidationIssue[],
  runtimeInputsByCanvas: Map<string, CanvasRuntimeInput | null>,
  options: { refresh?: boolean } = {}
): Promise<CanvasRuntimeInput | null> {
  if (!options.refresh && runtimeInputsByCanvas.has(canvasId)) {
    return runtimeInputsByCanvas.get(canvasId) ?? null;
  }
  const runtimeInput = await canvasRuntimeInputWithDiagnostics(workspace, canvasId, diagnostics);
  runtimeInputsByCanvas.set(canvasId, runtimeInput);
  return runtimeInput;
}

async function cacheCanvasRuntimeInputFromSnapshot(
  workspace: ProjectWorkspace,
  canvasId: string,
  snapshot: PackageFileSnapshot,
  diagnostics: ValidationIssue[],
  runtimeInputsByCanvas: Map<string, CanvasRuntimeInput | null>
): Promise<CanvasRuntimeInput | null> {
  try {
    const runtimeInput = await canvasRuntimeInputFromSnapshot(workspace, snapshot);
    runtimeInputsByCanvas.set(canvasId, runtimeInput);
    return runtimeInput;
  } catch (caught) {
    appendDesktopDiagnostic(
      diagnostics,
      desktopDiagnostic("desktop_canvas_runtime_input_failed", `Canvas runtime input could not be read: ${errorMessage(caught)}`, canvasId)
    );
    runtimeInputsByCanvas.set(canvasId, null);
    return null;
  }
}

async function buildProjectInputFingerprint(projectRoot: string): Promise<ProjectInputFingerprint> {
  const workspace = await resolveProjectWorkspace(projectRoot);
  return {
    projectFile: await optionalFileStatFingerprint(workspace.projectFile),
    projectGraphFile: await optionalFileStatFingerprint(projectGraphPath(workspace)),
    legacyCanvasRegistryFile: await optionalFileStatFingerprint(join(workspace.workspaceRoot, "desktop", "canvases.json"))
  };
}

function sameFileStatFingerprint(left: FileStatFingerprint | null, right: FileStatFingerprint | null): boolean {
  return left?.path === right?.path && left?.mtimeMs === right?.mtimeMs && left?.size === right?.size;
}

function sameFileFingerprint(left: FileFingerprint | undefined, right: FileFingerprint | undefined): boolean {
  return left?.path === right?.path && left?.hash === right?.hash && left?.mtimeMs === right?.mtimeMs;
}

function samePromptFileFingerprints(left: Record<string, FileFingerprint>, right: Record<string, FileFingerprint>): boolean {
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const path of paths) {
    if (!sameFileFingerprint(left[path], right[path])) {
      return false;
    }
  }
  return true;
}

function samePackageInputFingerprint(left: PackageInputFingerprint, right: PackageInputFingerprint): boolean {
  return sameFileFingerprint(left.manifestFile, right.manifestFile) && samePromptFileFingerprints(left.promptFiles, right.promptFiles);
}

function sameProjectInputFingerprint(left: ProjectInputFingerprint, right: ProjectInputFingerprint): boolean {
  return sameFileStatFingerprint(left.projectFile, right.projectFile)
    && sameFileStatFingerprint(left.projectGraphFile, right.projectGraphFile)
    && sameFileStatFingerprint(left.legacyCanvasRegistryFile, right.legacyCanvasRegistryFile);
}

function sameWorkspaceFingerprint(left: CanvasWorkspaceFingerprint, right: CanvasWorkspaceFingerprint): boolean {
  return left.rootPath === right.rootPath
    && left.packageDir === right.packageDir
    && left.stateFile === right.stateFile
    && left.resultsDir === right.resultsDir;
}

function sameCanvasRuntimeInputFingerprint(left: CanvasRuntimeInputFingerprint, right: CanvasRuntimeInputFingerprint): boolean {
  return sameWorkspaceFingerprint(left.workspace, right.workspace)
    && samePackageInputFingerprint(left.packageFiles, right.packageFiles)
    && sameFileStatFingerprint(left.stateFile, right.stateFile);
}

function sameCanvasBlockerFingerprint(left: CanvasBlockerFingerprint, right: CanvasBlockerFingerprint): boolean {
  return left.canvasDependencies.length === right.canvasDependencies.length
    && left.canvasDependencies.every((dependency, index) => {
      const next = right.canvasDependencies[index];
      return dependency.canvasId === next?.canvasId && dependency.complete === next.complete;
    })
    && left.crossTaskDependencies.length === right.crossTaskDependencies.length
    && left.crossTaskDependencies.every((dependency, index) => {
      const next = right.crossTaskDependencies[index];
      return dependency.canvasId === next?.canvasId
        && dependency.taskId === next.taskId
        && dependency.dependsOnCanvasId === next.dependsOnCanvasId
        && dependency.dependsOnTaskId === next.dependsOnTaskId
        && dependency.status === next.status;
    });
}

function sameCanvasProjectionFingerprint(left: CanvasProjectionFingerprint, right: CanvasProjectionFingerprint): boolean {
  return sameCanvasRuntimeInputFingerprint(left, right)
    && sameResultsFileFingerprintSnapshot(left.results, right.results)
    && sameCanvasBlockerFingerprint(left.blockers, right.blockers);
}

function slowDiagnosticThresholdMs(): number | null {
  const raw = process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS;
  if (raw === undefined || raw === "") {
    return null;
  }
  const threshold = Number(raw);
  return Number.isFinite(threshold) && threshold >= 0 ? threshold : null;
}

async function captureProjectionPart<T>(
  diagnostics: ValidationIssue[],
  label: string,
  path: string | undefined,
  action: () => Promise<T>
): Promise<T> {
  const threshold = slowDiagnosticThresholdMs();
  if (threshold === null) {
    return action();
  }
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= threshold) {
      const code = label.includes("statistics")
        ? "desktop_statistics_slow_part"
        : label.includes("search")
          ? "desktop_search_index_slow_part"
          : "desktop_projection_slow_part";
      appendDesktopDiagnostic(
        diagnostics,
        desktopDiagnostic(
          code,
          `Desktop projection ${label} took ${Math.round(elapsedMs)} ms.`,
          path
        )
      );
    }
  }
}

function canvasBlockerFingerprint(aggregation: ProjectCanvasAggregationContext, canvasId: string): CanvasBlockerFingerprint {
  const canvasDependencies = (aggregation.graph.canvasDependenciesByCanvas.get(canvasId) ?? [])
    .map((dependencyCanvasId) => ({
      canvasId: dependencyCanvasId,
      complete: aggregation.runtimeSnapshotsByCanvas.get(dependencyCanvasId)?.complete ?? false
    }))
    .sort((left, right) => left.canvasId.localeCompare(right.canvasId));
  const taskIds = Array.from(aggregation.runtimeSnapshotsByCanvas.get(canvasId)?.taskStatusById.keys() ?? []);
  const crossTaskDependencies = taskIds.flatMap((taskId) => aggregation.graph
    .crossTaskDependencies({ canvasId, taskId })
    .filter((dependency) => dependency.canvasId !== canvasId)
    .map((dependency) => ({
      canvasId,
      taskId,
      dependsOnCanvasId: dependency.canvasId,
      dependsOnTaskId: dependency.taskId,
      status: aggregation.runtimeSnapshotsByCanvas.get(dependency.canvasId)?.taskStatusById.get(dependency.taskId) ?? null
    })))
    .sort((left, right) => {
      const leftKey = `${left.canvasId}:${left.taskId}:${left.dependsOnCanvasId}:${left.dependsOnTaskId}`;
      const rightKey = `${right.canvasId}:${right.taskId}:${right.dependsOnCanvasId}:${right.dependsOnTaskId}`;
      return leftKey.localeCompare(rightKey);
    });
  return { canvasDependencies, crossTaskDependencies };
}

async function loadCanvasRuntimeSnapshot(
  workspace: ProjectWorkspace,
  canvasId: string,
  cached: CachedProjectProjection | undefined,
  diagnostics: ValidationIssue[],
  runtimeInputsByCanvas: Map<string, CanvasRuntimeInput | null>,
  runtimesByCanvas: Map<string, RuntimeContext>
): Promise<ProjectCanvasRuntimeSnapshot> {
  const currentInput = await cachedCanvasRuntimeInput(workspace, canvasId, diagnostics, runtimeInputsByCanvas, { refresh: true });
  const cachedEntry = cached?.canvases.get(canvasId);
  if (
    currentInput
    && cachedEntry?.version === desktopProjectProjectionCacheVersion
    && cachedEntry.fingerprint
    && sameCanvasRuntimeInputFingerprint(cachedEntry.fingerprint, currentInput.fingerprint)
  ) {
    return cachedEntry.runtimeSnapshot;
  }

  const session = currentInput
    ? createExecutionGraphSessionFromSnapshot({ projectRoot: workspace, workspace, snapshot: currentInput.snapshot })
    : undefined;
  const runtime = session ? await loadRuntimeReadonly({ projectRoot: workspace, session }) : await loadRuntimeReadonly({ projectRoot: workspace });
  runtimesByCanvas.set(canvasId, runtime);
  if (session) {
    await cacheCanvasRuntimeInputFromSnapshot(workspace, canvasId, session.fileSnapshot, diagnostics, runtimeInputsByCanvas);
  } else {
    await cachedCanvasRuntimeInput(workspace, canvasId, diagnostics, runtimeInputsByCanvas, { refresh: true });
  }
  return runtimeSnapshotFromGraphState(runtime.graph, runtime.state);
}

function cachedCanvasEntryIsReusable(
  cachedEntry: CanvasProjectionCacheEntry | undefined,
  currentFingerprint: CanvasProjectionFingerprint | null,
  projectInputsChanged: boolean
): cachedEntry is CanvasProjectionCacheEntry {
  return !projectInputsChanged
    && currentFingerprint !== null
    && cachedEntry?.version === desktopProjectProjectionCacheVersion
    && cachedEntry.fingerprint !== null
    && sameCanvasProjectionFingerprint(cachedEntry.fingerprint, currentFingerprint);
}

function missingRuntimeSnapshot(): ProjectCanvasRuntimeSnapshot {
  return {
    taskCount: 0,
    taskStatusById: new Map(),
    complete: false
  };
}

function appendCanvasExecutionSnapshotDiagnostics(
  diagnostics: ValidationIssue[],
  canvasId: string,
  snapshot: CanvasExecutionSnapshot
): void {
  if (!snapshot.error) {
    return;
  }
  appendDesktopDiagnostic(
    diagnostics,
    desktopDiagnostic("desktop_canvas_execution_snapshot_failed", errorMessage(snapshot.error), canvasId)
  );
}

function appendProjectProjectionDiagnostic(diagnostics: ValidationIssue[], diagnostic: ValidationIssue): void {
  if (diagnostic.code !== "desktop_canvas_execution_snapshot_failed") {
    appendDesktopDiagnostic(diagnostics, diagnostic);
    return;
  }
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const current = diagnostics[index];
    if (current.code === diagnostic.code && current.path === diagnostic.path) {
      diagnostics.splice(index, 1);
    }
  }
  diagnostics.push(diagnostic);
}

async function buildCanvasCacheEntry(input: {
  aggregation: ProjectCanvasAggregationContext;
  canvasId: string;
  fingerprint: CanvasProjectionFingerprint | null;
  resultsFingerprint: ResultsFileFingerprintSnapshot;
  cachedEntry: CanvasProjectionCacheEntry | undefined;
  runtime: RuntimeContext | undefined;
  diagnostics: ValidationIssue[];
}): Promise<CanvasProjectionCacheEntry> {
  const canvas = input.aggregation.canvasesById.get(input.canvasId);
  if (!canvas) {
    throw new Error(`Project canvas '${input.canvasId}' is missing from aggregation.`);
  }
  const resultsIndex = await captureProjectionPart(
    input.diagnostics,
    "per-canvas results index",
    input.canvasId,
    () => buildResultsFileIndexFromFingerprintSnapshot(canvas.workspace, input.resultsFingerprint)
  );
  let snapshot: CanvasExecutionSnapshot;
  try {
    snapshot = await captureProjectionPart(
      input.diagnostics,
      "per-canvas snapshot",
      input.canvasId,
      () => buildCanvasExecutionSnapshot(input.aggregation, input.canvasId, input.runtime ?? input.cachedEntry?.snapshot.runtime ?? undefined)
    );
  } catch (caught) {
    appendDesktopDiagnostic(
      input.diagnostics,
      desktopDiagnostic("desktop_canvas_execution_snapshot_failed", errorMessage(caught), input.canvasId)
    );
    snapshot = failedCanvasExecutionSnapshot(canvas.canvas.taskCount, caught);
  }
  const searchIndex = await captureProjectionPart(
    input.diagnostics,
    "summary search index construction",
    input.canvasId,
    () => buildSearchIndexForCanvas({
      aggregation: input.aggregation,
      canvasId: input.canvasId,
      snapshot,
      resultIndex: resultsIndex
    })
  );
  return {
    version: desktopProjectProjectionCacheVersion,
    fingerprint: input.fingerprint,
    runtimeSnapshot: input.aggregation.runtimeSnapshotsByCanvas.get(input.canvasId) ?? missingRuntimeSnapshot(),
    snapshot,
    resultsIndex,
    searchIndex,
    bodySearchIndex: null
  };
}

async function buildDesktopProjectProjection(projectRoot: string, cached: CachedProjectProjection | undefined): Promise<CachedProjectProjection> {
  const diagnostics: ValidationIssue[] = [];
  const runtimeInputsByCanvas = new Map<string, CanvasRuntimeInput | null>();
  const runtimesByCanvas = new Map<string, RuntimeContext>();
  const aggregation = await captureProjectionPart(
    diagnostics,
    "project aggregation",
    projectRoot,
    () => loadProjectCanvasAggregation(projectRoot, {
      loadRuntimeSnapshot: (workspace, canvasId) => loadCanvasRuntimeSnapshot(
        workspace,
        canvasId,
        cached,
        diagnostics,
        runtimeInputsByCanvas,
        runtimesByCanvas
      )
    })
  );
  const projectFingerprint = await buildProjectInputFingerprint(projectRoot);
  const projectInputsChanged = !cached
    || cached.version !== desktopProjectProjectionCacheVersion
    || !sameProjectInputFingerprint(cached.projectFingerprint, projectFingerprint);
  const canvases = new Map<string, CanvasProjectionCacheEntry>();
  const snapshotsByCanvas = new Map<string, CanvasExecutionSnapshot>();
  const resultsByCanvas = new Map<string, ResultsFileIndex>();

  for (const canvasId of aggregation.orderedCanvasIds) {
    const canvas = aggregation.canvasesById.get(canvasId);
    if (!canvas) {
      continue;
    }
    const runtimeInput = await cachedCanvasRuntimeInput(canvas.workspace, canvasId, diagnostics, runtimeInputsByCanvas);
    const runtimeInputFingerprint = runtimeInput?.fingerprint ?? null;
    const resultsFingerprint = await captureProjectionPart(
      diagnostics,
      "per-canvas results fingerprint",
      canvasId,
      () => snapshotResultsFileFingerprints(canvas.workspace)
    );
    const currentFingerprint: CanvasProjectionFingerprint | null = runtimeInputFingerprint
      ? {
          ...runtimeInputFingerprint,
          results: resultsFingerprint,
          blockers: canvasBlockerFingerprint(aggregation, canvasId)
        }
      : null;
    const cachedEntry = cached?.canvases.get(canvasId);
    const entry = cachedCanvasEntryIsReusable(cachedEntry, currentFingerprint, projectInputsChanged)
      ? cachedEntry
      : await buildCanvasCacheEntry({
          aggregation,
          canvasId,
          fingerprint: currentFingerprint,
          resultsFingerprint,
          cachedEntry,
          runtime: runtimesByCanvas.get(canvasId),
          diagnostics
    });
    canvases.set(canvasId, entry);
    snapshotsByCanvas.set(canvasId, entry.snapshot);
    resultsByCanvas.set(canvasId, entry.resultsIndex);
    appendCanvasExecutionSnapshotDiagnostics(diagnostics, canvasId, entry.snapshot);
  }

  const todoContext: ProjectTodoContext = {
    aggregation,
    snapshotsByCanvas,
    diagnostics
  };
  const projection: DesktopProjectProjection = {
    projectRoot,
    todoContext,
    resultsByCanvas,
    diagnostics
  };
  return {
    version: desktopProjectProjectionCacheVersion,
    projection,
    projectFingerprint,
    canvases,
    searchIndex: null,
    bodySearchIndex: null,
    statisticsProjection: null
  };
}

export async function readDesktopProjectProjectionContext(projectRoot: string): Promise<DesktopProjectProjectionContext> {
  const key = projectProjectionKey(projectRoot);
  const cached = projectProjectionCache.get(key);
  const next = await buildDesktopProjectProjection(projectRoot, cached);
  projectProjectionCache.set(key, next);
  const context = {
    key,
    projection: next.projection
  };
  projectionContextCache.set(context, next);
  return context;
}

export async function readDesktopProjectProjection(projectRoot: string): Promise<DesktopProjectProjection> {
  return (await readDesktopProjectProjectionContext(projectRoot)).projection;
}

async function buildCanvasBodySearchIndex(input: {
  aggregation: ProjectCanvasAggregationContext;
  canvasId: string;
  entry: CanvasProjectionCacheEntry;
  diagnostics: ValidationIssue[];
}): Promise<DesktopSearchIndex> {
  if (input.entry.bodySearchIndex) {
    return input.entry.bodySearchIndex;
  }
  const hydratedResultsIndex = await captureProjectionPart(
    input.diagnostics,
    "search result body index hydration",
    input.canvasId,
    () => hydrateResultsFileIndexBodies(input.entry.resultsIndex)
  );
  const bodySearchIndex = await captureProjectionPart(
    input.diagnostics,
    "body search index construction",
    input.canvasId,
    () => buildSearchBodyIndexForCanvas({
      aggregation: input.aggregation,
      canvasId: input.canvasId,
      snapshot: input.entry.snapshot,
      resultIndex: hydratedResultsIndex
    })
  );
  input.entry.bodySearchIndex = bodySearchIndex;
  return bodySearchIndex;
}

async function buildProjectSummarySearchIndex(input: {
  cached: CachedProjectProjection | undefined;
  projection: DesktopProjectProjection;
  projectRoot: string;
  diagnostics: ValidationIssue[];
}): Promise<DesktopSearchIndex> {
  if (input.cached?.searchIndex) {
    return input.cached.searchIndex;
  }
  const searchIndex = await captureProjectionPart(
    input.diagnostics,
    "summary search index construction",
    input.projectRoot,
    async () => buildSearchIndexFromCanvasIndexes(input.projection.todoContext.aggregation.orderedCanvasIds
      .map((canvasId) => input.cached?.canvases.get(canvasId)?.searchIndex)
      .filter((index): index is DesktopSearchIndex => index !== undefined))
  );
  for (const diagnostic of input.diagnostics) {
    appendProjectProjectionDiagnostic(searchIndex.diagnostics, diagnostic);
  }
  if (input.cached) {
    input.cached.searchIndex = searchIndex;
  }
  return searchIndex;
}

async function buildProjectBodySearchIndex(input: {
  cached: CachedProjectProjection;
  projection: DesktopProjectProjection;
  projectRoot: string;
  diagnostics: ValidationIssue[];
}): Promise<DesktopSearchIndex> {
  if (input.cached.bodySearchIndex) {
    return input.cached.bodySearchIndex;
  }
  const bodyIndexes: DesktopSearchIndex[] = [];
  for (const canvasId of input.projection.todoContext.aggregation.orderedCanvasIds) {
    const entry = input.cached.canvases.get(canvasId);
    if (!entry) {
      continue;
    }
    bodyIndexes.push(await buildCanvasBodySearchIndex({
      aggregation: input.projection.todoContext.aggregation,
      canvasId,
      entry,
      diagnostics: input.diagnostics
    }));
  }
  const bodySearchIndex = await captureProjectionPart(
    input.diagnostics,
    "body search index construction",
    input.projectRoot,
    async () => buildSearchIndexFromCanvasIndexes(bodyIndexes)
  );
  for (const diagnostic of input.diagnostics) {
    appendProjectProjectionDiagnostic(bodySearchIndex.diagnostics, diagnostic);
  }
  input.cached.bodySearchIndex = bodySearchIndex;
  return bodySearchIndex;
}

export async function readDesktopProjectSearchIndex(
  projectRoot: string,
  options: { includeBodies?: boolean } = {}
): Promise<DesktopSearchIndex> {
  return readDesktopProjectSearchIndexFromContext(await readDesktopProjectProjectionContext(projectRoot), options);
}

export async function readDesktopProjectSearchIndexFromContext(
  context: DesktopProjectProjectionContext,
  options: { includeBodies?: boolean } = {}
): Promise<DesktopSearchIndex> {
  const cachedFromProject = projectProjectionCache.get(context.key);
  const cachedFromContext = projectionContextCache.get(context);
  const cached = cachedFromContext === cachedFromProject ? cachedFromContext : cachedFromProject;
  const diagnostics = [...context.projection.diagnostics];
  const summaryIndex = await buildProjectSummarySearchIndex({
    cached,
    projection: context.projection,
    projectRoot: context.projection.projectRoot,
    diagnostics
  });
  if (!options.includeBodies || !cached) {
    return summaryIndex;
  }
  const bodyIndex = await buildProjectBodySearchIndex({
    cached,
    projection: context.projection,
    projectRoot: context.projection.projectRoot,
    diagnostics
  });
  return mergeSearchIndexBodies(summaryIndex, bodyIndex);
}

export async function buildDesktopProjectStatisticsProjectionFromProjection(
  projection: DesktopProjectProjection,
  path: string
): Promise<DesktopStatisticsProjection> {
  const diagnostics = [...projection.diagnostics];
  const statisticsProjection = await captureProjectionPart(
    diagnostics,
    "statistics projection",
    path,
    async () => buildStatisticsProjectionFromIndexes(projection.todoContext, projection.resultsByCanvas)
  );
  for (const diagnostic of diagnostics) {
    appendProjectProjectionDiagnostic(statisticsProjection.diagnostics, diagnostic);
  }
  return statisticsProjection;
}

export async function readDesktopProjectStatisticsProjection(projectRoot: string): Promise<DesktopStatisticsProjection> {
  const key = projectProjectionKey(projectRoot);
  const projection = await readDesktopProjectProjection(projectRoot);
  const cached = projectProjectionCache.get(key);
  if (cached?.statisticsProjection) {
    return cached.statisticsProjection;
  }
  const statisticsProjection = await buildDesktopProjectStatisticsProjectionFromProjection(projection, projectRoot);
  if (cached) {
    cached.statisticsProjection = statisticsProjection;
  }
  return statisticsProjection;
}

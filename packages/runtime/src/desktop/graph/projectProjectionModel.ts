import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { createPackageFileSnapshot } from "../../package/fileChanges.js";
import { resolveProjectWorkspace } from "../../project.js";
import { projectGraphPath } from "../../projectGraph/index.js";
import { loadRuntime, type RuntimeContext } from "../../taskManager/runtimeContext.js";
import type { FileFingerprint, PackageWorkspaceRef, ProjectWorkspace, ValidationIssue } from "../../types.js";
import { appendDesktopDiagnostic, desktopDiagnostic, errorMessage } from "./desktopDiagnostics.js";
import {
  loadProjectCanvasAggregation,
  runtimeSnapshotFromGraphState,
  type ProjectCanvasAggregationContext,
  type ProjectCanvasRuntimeSnapshot
} from "./projectCanvasAggregation.js";
import {
  buildResultsFileIndexFromFingerprintSnapshot,
  sameResultsFileFingerprintSnapshot,
  snapshotResultsFileFingerprints,
  type ResultsFileFingerprintSnapshot,
  type ResultsFileIndex
} from "./resultsFileIndex.js";
import { buildSearchIndexForCanvas, buildSearchIndexFromCanvasIndexes, type DesktopSearchIndex } from "./searchIndexModel.js";
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

type CachedProjectProjection = {
  version: number;
  projection: DesktopProjectProjection;
  projectFingerprint: ProjectInputFingerprint;
  canvases: Map<string, CanvasProjectionCacheEntry>;
  searchIndex: DesktopSearchIndex | null;
  statisticsProjection: DesktopStatisticsProjection | null;
};

type CanvasProjectionCacheEntry = {
  version: number;
  fingerprint: CanvasProjectionFingerprint | null;
  runtimeSnapshot: ProjectCanvasRuntimeSnapshot;
  snapshot: CanvasExecutionSnapshot;
  resultsIndex: ResultsFileIndex;
  searchIndex: DesktopSearchIndex;
};

const desktopProjectProjectionCacheVersion = 2;
const projectProjectionCache = new Map<string, CachedProjectProjection>();

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

function projectProjectionKey(projectRoot: PackageWorkspaceRef): string {
  return resolve(typeof projectRoot === "string" ? projectRoot : projectRoot.rootPath);
}

export function invalidateDesktopProjectProjection(projectRoot?: PackageWorkspaceRef): void {
  if (!projectRoot) {
    projectProjectionCache.clear();
    return;
  }
  projectProjectionCache.delete(projectProjectionKey(projectRoot));
}

async function optionalFileStatFingerprint(path: string): Promise<FileStatFingerprint | null> {
  try {
    const metadata = await stat(path);
    return {
      path,
      mtimeMs: metadata.mtimeMs,
      size: metadata.size
    };
  } catch {
    return null;
  }
}

async function packageInputFingerprint(projectRoot: PackageWorkspaceRef): Promise<PackageInputFingerprint> {
  const snapshot = await createPackageFileSnapshot(projectRoot);
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

async function canvasRuntimeInputFingerprint(workspace: ProjectWorkspace): Promise<CanvasRuntimeInputFingerprint | null> {
  try {
    return {
      workspace: workspaceFingerprint(workspace),
      packageFiles: await packageInputFingerprint(workspace),
      stateFile: await optionalFileStatFingerprint(workspace.stateFile)
    };
  } catch {
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
      appendDesktopDiagnostic(
        diagnostics,
        desktopDiagnostic(
          "desktop_projection_slow_part",
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
  runtimeInputFingerprintsByCanvas: Map<string, CanvasRuntimeInputFingerprint | null>,
  runtimesByCanvas: Map<string, RuntimeContext>
): Promise<ProjectCanvasRuntimeSnapshot> {
  const currentFingerprint = await canvasRuntimeInputFingerprint(workspace);
  runtimeInputFingerprintsByCanvas.set(canvasId, currentFingerprint);
  const cachedEntry = cached?.canvases.get(canvasId);
  if (
    currentFingerprint
    && cachedEntry?.version === desktopProjectProjectionCacheVersion
    && cachedEntry.fingerprint
    && sameCanvasRuntimeInputFingerprint(cachedEntry.fingerprint, currentFingerprint)
  ) {
    return cachedEntry.runtimeSnapshot;
  }

  const runtime = await loadRuntime({ projectRoot: workspace });
  runtimesByCanvas.set(canvasId, runtime);
  runtimeInputFingerprintsByCanvas.set(canvasId, await canvasRuntimeInputFingerprint(workspace));
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
    "search index construction",
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
    searchIndex
  };
}

async function buildDesktopProjectProjection(projectRoot: string, cached: CachedProjectProjection | undefined): Promise<CachedProjectProjection> {
  const diagnostics: ValidationIssue[] = [];
  const runtimeInputFingerprintsByCanvas = new Map<string, CanvasRuntimeInputFingerprint | null>();
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
        runtimeInputFingerprintsByCanvas,
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
    const runtimeInputFingerprint = runtimeInputFingerprintsByCanvas.get(canvasId) ?? await canvasRuntimeInputFingerprint(canvas.workspace);
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
    statisticsProjection: null
  };
}

export async function readDesktopProjectProjection(projectRoot: string): Promise<DesktopProjectProjection> {
  const key = projectProjectionKey(projectRoot);
  const cached = projectProjectionCache.get(key);
  const next = await buildDesktopProjectProjection(projectRoot, cached);
  projectProjectionCache.set(key, next);
  return next.projection;
}

export async function readDesktopProjectSearchIndex(projectRoot: string): Promise<DesktopSearchIndex> {
  const key = projectProjectionKey(projectRoot);
  const projection = await readDesktopProjectProjection(projectRoot);
  const cached = projectProjectionCache.get(key);
  if (cached?.searchIndex) {
    return cached.searchIndex;
  }
  const diagnostics = [...projection.diagnostics];
  const searchIndex = await captureProjectionPart(
    diagnostics,
    "search index construction",
    projectRoot,
    async () => buildSearchIndexFromCanvasIndexes(projection.todoContext.aggregation.orderedCanvasIds
      .map((canvasId) => cached?.canvases.get(canvasId)?.searchIndex)
      .filter((index): index is DesktopSearchIndex => index !== undefined))
  );
  for (const diagnostic of diagnostics) {
    appendProjectProjectionDiagnostic(searchIndex.diagnostics, diagnostic);
  }
  if (cached) {
    cached.searchIndex = searchIndex;
  }
  return searchIndex;
}

export async function readDesktopProjectStatisticsProjection(projectRoot: string): Promise<DesktopStatisticsProjection> {
  const key = projectProjectionKey(projectRoot);
  const projection = await readDesktopProjectProjection(projectRoot);
  const cached = projectProjectionCache.get(key);
  if (cached?.statisticsProjection) {
    return cached.statisticsProjection;
  }
  const diagnostics = [...projection.diagnostics];
  const statisticsProjection = await captureProjectionPart(
    diagnostics,
    "statistics projection",
    projectRoot,
    async () => buildStatisticsProjectionFromIndexes(projection.todoContext, projection.resultsByCanvas)
  );
  for (const diagnostic of diagnostics) {
    appendProjectProjectionDiagnostic(statisticsProjection.diagnostics, diagnostic);
  }
  if (cached) {
    cached.statisticsProjection = statisticsProjection;
  }
  return statisticsProjection;
}

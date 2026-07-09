import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { isNodeFileNotFoundError, optionalStat } from "../../fs/optionalFile.js";
import { createPackageFileMetadataSnapshot } from "../../package/fileChanges.js";
import { createExecutionGraphSessionFromSnapshot } from "../../graph/session.js";
import { resolveProjectWorkspace } from "../../project.js";
import { projectGraphPath } from "../../projectGraph/index.js";
import { loadRuntimeReadonly, type RuntimeContext } from "../../taskManager/runtimeContext.js";
import type {
  FileFingerprint,
  PackageFileSnapshot,
  ProjectWorkspace,
  ValidationIssue
} from "../../types.js";
import { appendDesktopDiagnostic, desktopDiagnostic, errorMessage } from "./desktopDiagnostics.js";
import {
  loadProjectCanvasAggregation,
  runtimeSnapshotFromGraphState,
  type ProjectCanvasAggregationContext,
  type ProjectCanvasRuntimeSnapshot
} from "./projectCanvasAggregation.js";
import {
  type CachedProjectProjection,
  type CanvasBlockerFingerprint,
  type CanvasProjectionCacheEntry,
  type CanvasProjectionFingerprint,
  type CanvasRuntimeInput,
  type CanvasRuntimeInputFingerprint,
  type CanvasWorkspaceFingerprint,
  type DesktopProjectProjection,
  type FileStatFingerprint,
  type PackageInputFingerprint,
  type ProjectInputFingerprint,
  desktopProjectProjectionCacheVersion
} from "./projectProjectionCache.js";
import {
  buildResultsFileIndexFromFingerprintSnapshot,
  sameResultsFileFingerprintSnapshot,
  snapshotResultsFileFingerprints,
  type ResultsFileFingerprintSnapshot,
  type ResultsFileIndex
} from "./resultsFileIndex.js";
import { buildSearchIndexForCanvas } from "./searchIndexModel.js";
import {
  buildCanvasExecutionSnapshot,
  failedCanvasExecutionSnapshot,
  type CanvasExecutionSnapshot,
  type ProjectTodoContext
} from "./todoModel.js";

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

function packageInputFingerprintFromSnapshot(
  snapshot: PackageFileSnapshot
): PackageInputFingerprint {
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

async function canvasRuntimeInputFromSnapshot(
  workspace: ProjectWorkspace,
  snapshot: PackageFileSnapshot
): Promise<CanvasRuntimeInput> {
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
      desktopDiagnostic(
        "desktop_canvas_runtime_input_failed",
        `Canvas runtime input could not be read: ${errorMessage(caught)}`,
        canvasId
      )
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
      desktopDiagnostic(
        "desktop_canvas_runtime_input_failed",
        `Canvas runtime input could not be read: ${errorMessage(caught)}`,
        canvasId
      )
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
    legacyCanvasRegistryFile: await optionalFileStatFingerprint(
      join(workspace.workspaceRoot, "desktop", "canvases.json")
    )
  };
}

function sameFileStatFingerprint(
  left: FileStatFingerprint | null,
  right: FileStatFingerprint | null
): boolean {
  return (
    left?.path === right?.path && left?.mtimeMs === right?.mtimeMs && left?.size === right?.size
  );
}

function sameFileFingerprint(
  left: FileFingerprint | undefined,
  right: FileFingerprint | undefined
): boolean {
  return (
    left?.path === right?.path && left?.hash === right?.hash && left?.mtimeMs === right?.mtimeMs
  );
}

function samePromptFileFingerprints(
  left: Record<string, FileFingerprint>,
  right: Record<string, FileFingerprint>
): boolean {
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const path of paths) {
    if (!sameFileFingerprint(left[path], right[path])) {
      return false;
    }
  }
  return true;
}

function samePackageInputFingerprint(
  left: PackageInputFingerprint,
  right: PackageInputFingerprint
): boolean {
  return (
    sameFileFingerprint(left.manifestFile, right.manifestFile) &&
    samePromptFileFingerprints(left.promptFiles, right.promptFiles)
  );
}

function sameProjectInputFingerprint(
  left: ProjectInputFingerprint,
  right: ProjectInputFingerprint
): boolean {
  return (
    sameFileStatFingerprint(left.projectFile, right.projectFile) &&
    sameFileStatFingerprint(left.projectGraphFile, right.projectGraphFile) &&
    sameFileStatFingerprint(left.legacyCanvasRegistryFile, right.legacyCanvasRegistryFile)
  );
}

function sameWorkspaceFingerprint(
  left: CanvasWorkspaceFingerprint,
  right: CanvasWorkspaceFingerprint
): boolean {
  return (
    left.rootPath === right.rootPath &&
    left.packageDir === right.packageDir &&
    left.stateFile === right.stateFile &&
    left.resultsDir === right.resultsDir
  );
}

function sameCanvasRuntimeInputFingerprint(
  left: CanvasRuntimeInputFingerprint,
  right: CanvasRuntimeInputFingerprint
): boolean {
  return (
    sameWorkspaceFingerprint(left.workspace, right.workspace) &&
    samePackageInputFingerprint(left.packageFiles, right.packageFiles) &&
    sameFileStatFingerprint(left.stateFile, right.stateFile)
  );
}

function sameCanvasBlockerFingerprint(
  left: CanvasBlockerFingerprint,
  right: CanvasBlockerFingerprint
): boolean {
  return (
    left.canvasDependencies.length === right.canvasDependencies.length &&
    left.canvasDependencies.every((dependency, index) => {
      const next = right.canvasDependencies[index];
      return dependency.canvasId === next?.canvasId && dependency.complete === next.complete;
    }) &&
    left.crossTaskDependencies.length === right.crossTaskDependencies.length &&
    left.crossTaskDependencies.every((dependency, index) => {
      const next = right.crossTaskDependencies[index];
      return (
        dependency.canvasId === next?.canvasId &&
        dependency.taskId === next.taskId &&
        dependency.dependsOnCanvasId === next.dependsOnCanvasId &&
        dependency.dependsOnTaskId === next.dependsOnTaskId &&
        dependency.status === next.status
      );
    })
  );
}

function sameCanvasProjectionFingerprint(
  left: CanvasProjectionFingerprint,
  right: CanvasProjectionFingerprint
): boolean {
  return (
    sameCanvasRuntimeInputFingerprint(left, right) &&
    sameResultsFileFingerprintSnapshot(left.results, right.results) &&
    sameCanvasBlockerFingerprint(left.blockers, right.blockers)
  );
}

function slowDiagnosticThresholdMs(): number | null {
  const raw = process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS;
  if (raw === undefined || raw === "") {
    return null;
  }
  const threshold = Number(raw);
  return Number.isFinite(threshold) && threshold >= 0 ? threshold : null;
}

export async function captureProjectionPart<T>(
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

function canvasBlockerFingerprint(
  aggregation: ProjectCanvasAggregationContext,
  canvasId: string
): CanvasBlockerFingerprint {
  const canvasDependencies = (aggregation.graph.canvasDependenciesByCanvas.get(canvasId) ?? [])
    .map((dependencyCanvasId) => ({
      canvasId: dependencyCanvasId,
      complete: aggregation.runtimeSnapshotsByCanvas.get(dependencyCanvasId)?.complete ?? false
    }))
    .sort((left, right) => left.canvasId.localeCompare(right.canvasId));
  const taskIds = Array.from(
    aggregation.runtimeSnapshotsByCanvas.get(canvasId)?.taskStatusById.keys() ?? []
  );
  const crossTaskDependencies = taskIds
    .flatMap((taskId) =>
      aggregation.graph
        .crossTaskDependencies({ canvasId, taskId })
        .filter((dependency) => dependency.canvasId !== canvasId)
        .map((dependency) => ({
          canvasId,
          taskId,
          dependsOnCanvasId: dependency.canvasId,
          dependsOnTaskId: dependency.taskId,
          status:
            aggregation.runtimeSnapshotsByCanvas
              .get(dependency.canvasId)
              ?.taskStatusById.get(dependency.taskId) ?? null
        }))
    )
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
  const currentInput = await cachedCanvasRuntimeInput(
    workspace,
    canvasId,
    diagnostics,
    runtimeInputsByCanvas,
    { refresh: true }
  );
  const cachedEntry = cached?.canvases.get(canvasId);
  if (
    currentInput &&
    cachedEntry?.version === desktopProjectProjectionCacheVersion &&
    cachedEntry.fingerprint &&
    sameCanvasRuntimeInputFingerprint(cachedEntry.fingerprint, currentInput.fingerprint)
  ) {
    return cachedEntry.runtimeSnapshot;
  }

  const session = currentInput
    ? createExecutionGraphSessionFromSnapshot({
        projectRoot: workspace,
        workspace,
        snapshot: currentInput.snapshot
      })
    : undefined;
  const runtime = session
    ? await loadRuntimeReadonly({ projectRoot: workspace, session })
    : await loadRuntimeReadonly({ projectRoot: workspace });
  runtimesByCanvas.set(canvasId, runtime);
  if (session) {
    await cacheCanvasRuntimeInputFromSnapshot(
      workspace,
      canvasId,
      session.fileSnapshot,
      diagnostics,
      runtimeInputsByCanvas
    );
  } else {
    await cachedCanvasRuntimeInput(workspace, canvasId, diagnostics, runtimeInputsByCanvas, {
      refresh: true
    });
  }
  return runtimeSnapshotFromGraphState(runtime.graph, runtime.state);
}

function cachedCanvasEntryIsReusable(
  cachedEntry: CanvasProjectionCacheEntry | undefined,
  currentFingerprint: CanvasProjectionFingerprint | null,
  projectInputsChanged: boolean
): cachedEntry is CanvasProjectionCacheEntry {
  return (
    !projectInputsChanged &&
    currentFingerprint !== null &&
    cachedEntry?.version === desktopProjectProjectionCacheVersion &&
    cachedEntry.fingerprint !== null &&
    sameCanvasProjectionFingerprint(cachedEntry.fingerprint, currentFingerprint)
  );
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
    desktopDiagnostic(
      "desktop_canvas_execution_snapshot_failed",
      errorMessage(snapshot.error),
      canvasId
    )
  );
}

export function appendProjectProjectionDiagnostic(
  diagnostics: ValidationIssue[],
  diagnostic: ValidationIssue
): void {
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
      () =>
        buildCanvasExecutionSnapshot(
          input.aggregation,
          input.canvasId,
          input.runtime ?? input.cachedEntry?.snapshot.runtime ?? undefined
        )
    );
  } catch (caught) {
    appendDesktopDiagnostic(
      input.diagnostics,
      desktopDiagnostic(
        "desktop_canvas_execution_snapshot_failed",
        errorMessage(caught),
        input.canvasId
      )
    );
    snapshot = failedCanvasExecutionSnapshot(canvas.canvas.taskCount, caught);
  }
  const searchIndex = await captureProjectionPart(
    input.diagnostics,
    "summary search index construction",
    input.canvasId,
    () =>
      buildSearchIndexForCanvas({
        aggregation: input.aggregation,
        canvasId: input.canvasId,
        snapshot,
        resultIndex: resultsIndex
      })
  );
  return {
    version: desktopProjectProjectionCacheVersion,
    fingerprint: input.fingerprint,
    runtimeSnapshot:
      input.aggregation.runtimeSnapshotsByCanvas.get(input.canvasId) ?? missingRuntimeSnapshot(),
    snapshot,
    resultsIndex,
    searchIndex,
    bodySearchIndex: null
  };
}

export async function buildDesktopProjectProjection(
  projectRoot: string,
  cached: CachedProjectProjection | undefined
): Promise<CachedProjectProjection> {
  const diagnostics: ValidationIssue[] = [];
  const runtimeInputsByCanvas = new Map<string, CanvasRuntimeInput | null>();
  const runtimesByCanvas = new Map<string, RuntimeContext>();
  const aggregation = await captureProjectionPart(
    diagnostics,
    "project aggregation",
    projectRoot,
    () =>
      loadProjectCanvasAggregation(projectRoot, {
        loadRuntimeSnapshot: (workspace, canvasId) =>
          loadCanvasRuntimeSnapshot(
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
  const projectInputsChanged =
    !cached ||
    cached.version !== desktopProjectProjectionCacheVersion ||
    !sameProjectInputFingerprint(cached.projectFingerprint, projectFingerprint);
  const canvases = new Map<string, CanvasProjectionCacheEntry>();
  const snapshotsByCanvas = new Map<string, CanvasExecutionSnapshot>();
  const resultsByCanvas = new Map<string, ResultsFileIndex>();

  for (const canvasId of aggregation.orderedCanvasIds) {
    const canvas = aggregation.canvasesById.get(canvasId);
    if (!canvas) {
      continue;
    }
    const runtimeInput = await cachedCanvasRuntimeInput(
      canvas.workspace,
      canvasId,
      diagnostics,
      runtimeInputsByCanvas
    );
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

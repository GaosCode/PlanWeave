import type { ValidationIssue } from "../../types.js";
import type { ProjectCanvasAggregationContext } from "./projectCanvasAggregation.js";
import {
  appendProjectProjectionDiagnostic,
  buildDesktopProjectProjection,
  captureProjectionPart
} from "./projectProjectionBuild.js";
import {
  type CachedProjectProjection,
  type CanvasProjectionCacheEntry,
  type DesktopProjectProjection,
  type DesktopProjectProjectionContext,
  getCachedDesktopProjectProjection,
  peekCachedDesktopProjectProjection,
  projectProjectionKey,
  projectionContextCache,
  setCachedDesktopProjectProjection
} from "./projectProjectionCache.js";
import { hydrateResultsFileIndexBodies } from "./resultsFileIndex.js";
import {
  buildSearchBodyIndexForCanvas,
  buildSearchIndexFromCanvasIndexes,
  mergeSearchIndexBodies,
  type DesktopSearchIndex
} from "./searchIndexModel.js";
import {
  buildStatisticsProjectionFromIndexes,
  type DesktopStatisticsProjection
} from "./statisticsIndexModel.js";

async function readDesktopProjectProjectionCapture(projectRoot: string): Promise<{
  context: DesktopProjectProjectionContext;
  sourceCache: CachedProjectProjection;
  snapshot: CachedProjectProjection;
}> {
  const key = projectProjectionKey(projectRoot);
  const cached = getCachedDesktopProjectProjection(key);
  const next = await buildDesktopProjectProjection(projectRoot, cached);
  setCachedDesktopProjectProjection(key, next);
  const context = {
    key,
    projection: next.projection
  };
  // Capture before publishing the context: cache retirement may run before the caller resumes.
  const snapshot = { ...next, canvases: new Map(next.canvases) };
  projectionContextCache.set(context, next);
  return { context, sourceCache: next, snapshot };
}

export async function readDesktopProjectProjectionContext(
  projectRoot: string
): Promise<DesktopProjectProjectionContext> {
  return (await readDesktopProjectProjectionCapture(projectRoot)).context;
}

export async function readDesktopProjectProjection(
  projectRoot: string
): Promise<DesktopProjectProjection> {
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
    () =>
      buildSearchBodyIndexForCanvas({
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
    async () =>
      buildSearchIndexFromCanvasIndexes(
        input.projection.todoContext.aggregation.orderedCanvasIds
          .map((canvasId) => input.cached?.canvases.get(canvasId)?.searchIndex)
          .filter((index): index is DesktopSearchIndex => index !== undefined)
      )
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
    bodyIndexes.push(
      await buildCanvasBodySearchIndex({
        aggregation: input.projection.todoContext.aggregation,
        canvasId,
        entry,
        diagnostics: input.diagnostics
      })
    );
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
  options: { includeBodies?: boolean; canvasId?: string | null } = {}
): Promise<DesktopSearchIndex> {
  return readDesktopProjectSearchIndexFromContext(
    await readDesktopProjectProjectionContext(projectRoot),
    options
  );
}

export async function readDesktopProjectSearchIndexFromContext(
  context: DesktopProjectProjectionContext,
  options: { includeBodies?: boolean; canvasId?: string | null } = {}
): Promise<DesktopSearchIndex> {
  const cached = getCachedDesktopProjectProjection(context.key);
  let sourceCache: CachedProjectProjection;
  let snapshot: CachedProjectProjection;
  if (
    projectionContextCache.get(context) !== cached ||
    !cached ||
    context.projection.todoContext.aggregation.orderedCanvasIds.some(
      (canvasId) => !cached?.canvases.has(canvasId)
    )
  ) {
    const refreshed = await readDesktopProjectProjectionCapture(context.projection.projectRoot);
    context = refreshed.context;
    sourceCache = refreshed.sourceCache;
    snapshot = refreshed.snapshot;
  } else {
    sourceCache = cached;
    snapshot = { ...cached, canvases: new Map(cached.canvases) };
  }
  const aggregation = context.projection.todoContext.aggregation;
  if (typeof options.canvasId === "string" && !aggregation.canvasesById.has(options.canvasId)) {
    throw new Error(`Task canvas '${options.canvasId}' does not exist.`);
  }
  // Invalidation may retire entries during I/O; this read keeps its captured projection.
  const finish = (index: DesktopSearchIndex): DesktopSearchIndex => {
    if (
      peekCachedDesktopProjectProjection(context.key) === sourceCache &&
      sourceCache.canvases.size === snapshot.canvases.size &&
      [...snapshot.canvases].every(
        ([canvasId, entry]) => sourceCache.canvases.get(canvasId) === entry
      )
    ) {
      sourceCache.searchIndex = snapshot.searchIndex;
      sourceCache.bodySearchIndex = snapshot.bodySearchIndex;
    }
    return index;
  };
  const diagnostics = [...context.projection.diagnostics];
  const summaryIndex = await buildProjectSummarySearchIndex({
    cached: snapshot,
    projection: context.projection,
    projectRoot: context.projection.projectRoot,
    diagnostics
  });
  if (!options.includeBodies) {
    return finish(summaryIndex);
  }
  if (typeof options.canvasId === "string") {
    const entry = snapshot.canvases.get(options.canvasId);
    if (!entry) {
      throw new Error(`Project canvas '${options.canvasId}' is missing from projection cache.`);
    }
    const bodyIndex = await buildCanvasBodySearchIndex({
      aggregation,
      canvasId: options.canvasId,
      entry,
      diagnostics
    });
    const index = mergeSearchIndexBodies(summaryIndex, bodyIndex);
    for (const diagnostic of diagnostics) {
      appendProjectProjectionDiagnostic(index.diagnostics, diagnostic);
    }
    return finish(index);
  }
  const bodyIndex = await buildProjectBodySearchIndex({
    cached: snapshot,
    projection: context.projection,
    projectRoot: context.projection.projectRoot,
    diagnostics
  });
  return finish(mergeSearchIndexBodies(summaryIndex, bodyIndex));
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
    async () =>
      buildStatisticsProjectionFromIndexes(projection.todoContext, projection.resultsByCanvas)
  );
  for (const diagnostic of diagnostics) {
    appendProjectProjectionDiagnostic(statisticsProjection.diagnostics, diagnostic);
  }
  return statisticsProjection;
}

export async function readDesktopProjectStatisticsProjection(
  projectRoot: string
): Promise<DesktopStatisticsProjection> {
  const key = projectProjectionKey(projectRoot);
  const projection = await readDesktopProjectProjection(projectRoot);
  const cached = getCachedDesktopProjectProjection(key);
  if (cached?.statisticsProjection) {
    return cached.statisticsProjection;
  }
  const statisticsProjection = await buildDesktopProjectStatisticsProjectionFromProjection(
    projection,
    projectRoot
  );
  if (cached) {
    cached.statisticsProjection = statisticsProjection;
  }
  return statisticsProjection;
}

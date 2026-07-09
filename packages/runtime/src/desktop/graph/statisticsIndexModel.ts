import type { ValidationIssue } from "../../types.js";
import type { DesktopStatistics } from "../types.js";
import type { ResultsFileIndex } from "./resultsFileIndex.js";
import type { ProjectTodoContext } from "./todoModel.js";
import { buildStatisticsProjection } from "../../plangraph/projections/index.js";
import { sha256Hex, stableJson } from "../../plangraph/hash.js";

export type DesktopStatisticsProjection = {
  statistics: DesktopStatistics;
  diagnostics: ValidationIssue[];
};

function projectTodoGraphVersion(
  context: ProjectTodoContext,
  resultsByCanvas: Map<string, ResultsFileIndex>
): string {
  return sha256Hex(
    stableJson({
      projectGraph: context.aggregation.graph.manifest,
      orderedCanvasIds: context.aggregation.orderedCanvasIds,
      canvases: context.aggregation.orderedCanvasIds.map((canvasId) => {
        const snapshot = context.snapshotsByCanvas.get(canvasId);
        const results = resultsByCanvas.get(canvasId);
        return {
          canvasId,
          graphVersion: snapshot?.graphVersion ?? null,
          failed: Boolean(snapshot?.error),
          status: snapshot?.status ?? null,
          results: results
            ? {
                diagnostics: results.diagnostics,
                entries: results.entries.map((entry) => ({
                  relativePath: entry.relativePath,
                  fingerprint: entry.fingerprint,
                  bodyTruncated: entry.bodyTruncated,
                  metadata: entry.metadata
                }))
              }
            : null
        };
      })
    })
  );
}

export function buildStatisticsProjectionFromIndexes(
  context: ProjectTodoContext,
  resultsByCanvas: Map<string, ResultsFileIndex>
): DesktopStatisticsProjection {
  const projection = buildStatisticsProjection({
    graphVersion: projectTodoGraphVersion(context, resultsByCanvas),
    context,
    resultsByCanvas
  });
  return {
    statistics: projection.statistics,
    diagnostics: projection.diagnostics
  };
}

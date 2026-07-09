import type { DesktopStatistics } from "../types.js";
import { readDesktopProjectStatisticsProjection } from "./projectProjectionModel.js";
import type { DesktopStatisticsProjection } from "./statisticsIndexModel.js";
import { buildStatisticsProjectionFromIndexes } from "./statisticsIndexModel.js";
import type { ProjectTodoContext } from "./todoModel.js";
import type { ResultsFileIndex } from "./resultsFileIndex.js";

export type { DesktopStatisticsProjection };

export function buildStatisticsProjectionFromProjectTodoContext(
  context: ProjectTodoContext,
  resultsByCanvas: Map<string, ResultsFileIndex>
): DesktopStatisticsProjection {
  return buildStatisticsProjectionFromIndexes(context, resultsByCanvas);
}

export function buildStatisticsFromProjectTodoContext(
  context: ProjectTodoContext,
  resultsByCanvas: Map<string, ResultsFileIndex>
): DesktopStatistics {
  return buildStatisticsProjectionFromProjectTodoContext(context, resultsByCanvas).statistics;
}

export async function getStatistics(projectRoot: string): Promise<DesktopStatistics> {
  return (await getStatisticsProjection(projectRoot)).statistics;
}

export async function getStatisticsProjection(
  projectRoot: string
): Promise<DesktopStatisticsProjection> {
  return readDesktopProjectStatisticsProjection(projectRoot);
}

import type { ExecutionStatus } from "../../taskManager/executionStatus.js";
import type { DesktopStatistics } from "../../desktop/types.js";
import type { ValidationIssue } from "../../types.js";
import {
  appendDesktopDiagnostic,
  appendDesktopDiagnostics,
  desktopDiagnostic,
  errorMessage
} from "../../desktop/graph/desktopDiagnostics.js";
import type { ResultsFileIndex } from "../../desktop/graph/resultsFileIndex.js";
import type { ProjectTodoContext } from "./todoProjection.js";

type StatisticsParts = {
  stats: DesktopStatistics;
  implementationDurations: number[];
  reviewBlockCount: number;
};

export type StatisticsProjection = {
  graphVersion: string;
  statistics: DesktopStatistics;
  diagnostics: ValidationIssue[];
};

function implementationDurationsFromResultsIndex(index: ResultsFileIndex): number[] {
  const implementationDurations: number[] = [];
  for (const entry of index.entries) {
    if (
      !entry.relativePath.includes("/blocks/") ||
      !entry.relativePath.endsWith("/metadata.json")
    ) {
      continue;
    }
    const startedAt =
      typeof entry.metadata?.startedAt === "string"
        ? Date.parse(entry.metadata.startedAt)
        : Number.NaN;
    const finishedAt =
      typeof entry.metadata?.finishedAt === "string"
        ? Date.parse(entry.metadata.finishedAt)
        : Number.NaN;
    if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) {
      implementationDurations.push(finishedAt - startedAt);
    }
  }
  return implementationDurations;
}

function statisticsPartsFromStatus(
  status: ExecutionStatus,
  implementationDurations: number[]
): StatisticsParts {
  const totalImplementationTimeMs = implementationDurations.reduce(
    (sum, duration) => sum + duration,
    0
  );
  const reviewBlockCount = status.blocks.filter((block) => block.type === "review").length;
  const reviewPassedCount = status.blocks.filter(
    (block) => block.type === "review" && block.completionReason === "passed"
  ).length;
  const feedbackEnvelopeCount = Object.values(status.counts.feedback).reduce(
    (sum, count) => sum + count,
    0
  );
  return {
    implementationDurations,
    reviewBlockCount,
    stats: {
      taskTotal: status.taskTotal,
      implementedTaskCount: status.counts.tasks.implemented,
      implementedRatio:
        status.taskTotal === 0 ? 0 : status.counts.tasks.implemented / status.taskTotal,
      taskThroughput: status.counts.tasks.implemented,
      blockTotal: status.blockTotal,
      completedBlockCount: status.counts.blocks.completed,
      averageImplementationTimeMs:
        implementationDurations.length === 0
          ? null
          : Math.round(totalImplementationTimeMs / implementationDurations.length),
      totalImplementationTimeMs:
        implementationDurations.length === 0 ? null : totalImplementationTimeMs,
      timedImplementationRunCount: implementationDurations.length,
      reviewPassedCount,
      reviewPassedRatio: reviewBlockCount === 0 ? 0 : reviewPassedCount / reviewBlockCount,
      feedbackEnvelopeCount,
      reworkCount: feedbackEnvelopeCount,
      estimatedRemainingBlocks: status.blockTotal - status.counts.blocks.completed
    }
  };
}

function mergeStatisticsParts(parts: StatisticsParts[]): DesktopStatistics {
  const totals = parts.reduce(
    (sum, part) => ({
      taskTotal: sum.taskTotal + part.stats.taskTotal,
      implementedTaskCount: sum.implementedTaskCount + part.stats.implementedTaskCount,
      taskThroughput: sum.taskThroughput + part.stats.taskThroughput,
      blockTotal: sum.blockTotal + part.stats.blockTotal,
      completedBlockCount: sum.completedBlockCount + part.stats.completedBlockCount,
      reviewBlockCount: sum.reviewBlockCount + part.reviewBlockCount,
      reviewPassedCount: sum.reviewPassedCount + part.stats.reviewPassedCount,
      feedbackEnvelopeCount: sum.feedbackEnvelopeCount + part.stats.feedbackEnvelopeCount,
      reworkCount: sum.reworkCount + part.stats.reworkCount,
      estimatedRemainingBlocks: sum.estimatedRemainingBlocks + part.stats.estimatedRemainingBlocks,
      implementationDurations: [...sum.implementationDurations, ...part.implementationDurations]
    }),
    {
      taskTotal: 0,
      implementedTaskCount: 0,
      taskThroughput: 0,
      blockTotal: 0,
      completedBlockCount: 0,
      reviewBlockCount: 0,
      reviewPassedCount: 0,
      feedbackEnvelopeCount: 0,
      reworkCount: 0,
      estimatedRemainingBlocks: 0,
      implementationDurations: [] as number[]
    }
  );
  const totalImplementationTimeMs = totals.implementationDurations.reduce(
    (sum, duration) => sum + duration,
    0
  );
  return {
    taskTotal: totals.taskTotal,
    implementedTaskCount: totals.implementedTaskCount,
    implementedRatio: totals.taskTotal === 0 ? 0 : totals.implementedTaskCount / totals.taskTotal,
    taskThroughput: totals.taskThroughput,
    blockTotal: totals.blockTotal,
    completedBlockCount: totals.completedBlockCount,
    averageImplementationTimeMs:
      totals.implementationDurations.length === 0
        ? null
        : Math.round(totalImplementationTimeMs / totals.implementationDurations.length),
    totalImplementationTimeMs:
      totals.implementationDurations.length === 0 ? null : totalImplementationTimeMs,
    timedImplementationRunCount: totals.implementationDurations.length,
    reviewPassedCount: totals.reviewPassedCount,
    reviewPassedRatio:
      totals.reviewBlockCount === 0 ? 0 : totals.reviewPassedCount / totals.reviewBlockCount,
    feedbackEnvelopeCount: totals.feedbackEnvelopeCount,
    reworkCount: totals.reworkCount,
    estimatedRemainingBlocks: totals.estimatedRemainingBlocks
  };
}

export function buildStatisticsProjection(options: {
  graphVersion: string;
  context: ProjectTodoContext;
  resultsByCanvas: Map<string, ResultsFileIndex>;
}): StatisticsProjection {
  const parts: StatisticsParts[] = [];
  const diagnostics: ValidationIssue[] = [];

  for (const canvasId of options.context.aggregation.orderedCanvasIds) {
    const snapshot = options.context.snapshotsByCanvas.get(canvasId);
    const resultIndex = options.resultsByCanvas.get(canvasId);
    if (!snapshot) {
      appendDesktopDiagnostic(
        diagnostics,
        desktopDiagnostic(
          "desktop_canvas_execution_snapshot_missing",
          `Canvas '${canvasId}' execution snapshot is missing.`,
          canvasId
        )
      );
      continue;
    }
    if (snapshot.error) {
      appendDesktopDiagnostic(
        diagnostics,
        desktopDiagnostic(
          "desktop_canvas_execution_snapshot_failed",
          `Canvas '${canvasId}' execution snapshot failed: ${errorMessage(snapshot.error)}`,
          canvasId
        )
      );
      continue;
    }
    if (!snapshot.status) {
      appendDesktopDiagnostic(
        diagnostics,
        desktopDiagnostic(
          "desktop_canvas_execution_status_missing",
          `Canvas '${canvasId}' execution status is unavailable.`,
          canvasId
        )
      );
      continue;
    }
    if (resultIndex) {
      appendDesktopDiagnostics(diagnostics, resultIndex.diagnostics);
    }
    parts.push(
      statisticsPartsFromStatus(
        snapshot.status,
        resultIndex ? implementationDurationsFromResultsIndex(resultIndex) : []
      )
    );
  }

  return {
    graphVersion: options.graphVersion,
    statistics: mergeStatisticsParts(parts),
    diagnostics
  };
}

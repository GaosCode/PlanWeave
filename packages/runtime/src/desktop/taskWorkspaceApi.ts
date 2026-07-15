import { artifactReferenceSchema } from "../autoRun/runnerContractSchemas.js";
import { getExecutionStatus } from "../taskManager/executionStatus.js";
import { hasNonTerminalAutoRunForTarget } from "./runApi.js";
import type { ProjectWorkspace } from "../types.js";
import { compareRunDirectoriesNewestFirst } from "./autoRunIdReservations.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getBlockDetail, getTaskDetail } from "./graph/readModel.js";
import {
  getReviewAttempts,
  getRunRecord,
  listBlockMainRunRecords,
  listTaskFeedbackRecords,
  listTaskFeedbackRunRecords
} from "./recordsApi.js";
import { projectTaskWorkspaceRun } from "./taskWorkspaceRunProjection.js";
import {
  canonicalTaskWorkspaceRunIdentity,
  evaluateTaskWorkspaceRetry
} from "./taskWorkspaceRetry.js";
import {
  TASK_WORKSPACE_TASK_COST_UNAVAILABLE_REASON,
  taskWorkspaceInputSchema,
  taskWorkspaceSchema,
  type TaskWorkspace,
  type TaskWorkspaceAnnotation,
  type TaskWorkspaceBlock,
  type TaskWorkspaceInput
} from "./types/taskWorkspaceAggregateTypes.js";
import { TASK_WORKSPACE_TASK_TOKENS_UNAVAILABLE_REASON } from "./types/taskWorkspaceTypes.js";
import type { DesktopBlockDetail, DesktopFeedbackRecord, DesktopRunRecord } from "./types.js";

const TASK_WALL_CLOCK_UNAVAILABLE_REASON =
  "Task wall-clock duration is unavailable because no persisted block run has a start time.";
const AGENT_TIME_UNAVAILABLE_REASON =
  "Agent time is unavailable because no persisted block run has a calculable duration.";
const AGENT_TIME_PARTIAL_REASON =
  "Agent time is partial because one or more persisted block runs have no start time.";

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareRunIdsOldestFirst(left: DesktopRunRecord, right: DesktopRunRecord): number {
  const runIdOrder = -compareRunDirectoriesNewestFirst(left.runId, right.runId);
  if (runIdOrder !== 0) return runIdOrder;
  return left.recordId.localeCompare(right.recordId, undefined, { numeric: true });
}

function compareDatedRunsOldestFirst(left: DesktopRunRecord, right: DesktopRunRecord): number {
  const leftStartedAt = timestamp(left.startedAt);
  const rightStartedAt = timestamp(right.startedAt);
  if (leftStartedAt === null || rightStartedAt === null) {
    return compareRunIdsOldestFirst(left, right);
  }
  if (leftStartedAt !== rightStartedAt) {
    return leftStartedAt - rightStartedAt;
  }
  return compareRunIdsOldestFirst(left, right);
}

function sortRunsOldestFirst(records: DesktopRunRecord[]): DesktopRunRecord[] {
  const allRunsHaveStartTime = records.every((record) => timestamp(record.startedAt) !== null);
  return [...records].sort(
    allRunsHaveStartTime ? compareDatedRunsOldestFirst : compareRunIdsOldestFirst
  );
}

function sortRunsNewestFirst(records: DesktopRunRecord[]): DesktopRunRecord[] {
  return sortRunsOldestFirst(records).reverse();
}

function waitingInteraction(record: DesktopRunRecord) {
  const requests = record.runnerReadModel?.interaction.activeRequests ?? [];
  if (requests.length === 0) {
    return { active: false as const, count: 0 as const, kinds: [] };
  }
  return {
    active: true as const,
    count: requests.length,
    kinds: [...new Set(requests.map((request) => request.kind))].sort()
  };
}

async function annotationsForReviewBlock(
  workspace: ProjectWorkspace,
  ref: string,
  feedbackRuns: DesktopRunRecord[],
  feedbackRecords: DesktopFeedbackRecord[]
): Promise<TaskWorkspaceAnnotation[]> {
  const attempts = await getReviewAttempts(workspace, ref);
  return [
    ...attempts.map(
      (attempt): TaskWorkspaceAnnotation => ({
        kind: "review_attempt",
        annotationId: `review:${attempt.attemptId}`,
        sourceReviewBlockRef: ref,
        associatedRunRecordId: null,
        attemptId: attempt.attemptId,
        verdict: attempt.verdict,
        contentPreview: attempt.contentPreview
      })
    ),
    ...feedbackRecords.map(
      (feedback): TaskWorkspaceAnnotation => ({
        kind: "feedback",
        annotationId: `feedback:${feedback.feedbackId}`,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        associatedRunRecordId: null,
        feedbackId: feedback.feedbackId,
        status: feedback.status,
        latestSubmissionId: feedback.latestSubmissionId,
        contentPreview: feedback.content.trim().slice(0, 400)
      })
    ),
    ...feedbackRuns.map((record): TaskWorkspaceAnnotation => {
      if (record.sourceReviewBlockRef !== ref) {
        throw new Error(
          `Feedback run '${record.recordId}' does not identify review block '${ref}' as its source.`
        );
      }
      return {
        kind: "feedback_run",
        annotationId: record.recordId,
        sourceReviewBlockRef: record.sourceReviewBlockRef,
        associatedRunRecordId: null,
        recordId: record.recordId,
        feedbackId: record.feedbackId ?? null,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        reportPath: record.reportPath
      };
    })
  ];
}

function dependencyProgress(
  detail: DesktopBlockDetail,
  detailsByRef: ReadonlyMap<string, DesktopBlockDetail>
) {
  const blockers = detail.dependencies.filter(
    (dependency) => detailsByRef.get(dependency)?.status !== "completed"
  );
  return projectDependencyProgress({
    total: detail.dependencies.length,
    completed: detail.dependencies.length - blockers.length,
    blockers
  });
}

function projectDependencyProgress(options: {
  total: number;
  completed: number;
  blockers: string[];
}) {
  const percent = options.total === 0 ? 100 : Math.floor((options.completed / options.total) * 100);
  const status =
    options.total === 0
      ? ("not_applicable" as const)
      : options.completed === options.total
        ? ("completed" as const)
        : options.completed === 0
          ? ("pending" as const)
          : ("in_progress" as const);
  return { ...options, percent, status };
}

export function projectTaskWorkspaceDuration(blocks: TaskWorkspaceBlock[], now: Date) {
  const runs = blocks.flatMap((block) => block.runs.map((item) => item.run));
  const starts = runs
    .map((run) => timestamp(run.duration.startedAt))
    .filter((value): value is number => value !== null);
  const calculatedAt = now.toISOString();
  const wallClock =
    starts.length === 0
      ? {
          available: false,
          startedAt: null,
          endedAt: null,
          calculatedAt,
          totalMs: null,
          unavailableReason: TASK_WALL_CLOCK_UNAVAILABLE_REASON
        }
      : (() => {
          const started = Math.min(...starts);
          const hasActiveRun = blocks.some((block) =>
            block.runs.some((item) => item.active && item.run.duration.startedAt !== null)
          );
          const finishes = runs
            .map((run) => timestamp(run.duration.finishedAt))
            .filter((value): value is number => value !== null);
          const ended = hasActiveRun ? now.getTime() : Math.max(...finishes, started);
          return {
            available: true,
            startedAt: new Date(started).toISOString(),
            endedAt: new Date(ended).toISOString(),
            calculatedAt,
            totalMs: Math.max(0, ended - started),
            unavailableReason: null
          };
        })();
  const availableDurations = runs
    .map((run) => run.duration.wallClockMs)
    .filter((value): value is number => value !== null);
  const missingRunCount = runs.length - availableDurations.length;
  const agentTime =
    availableDurations.length === 0
      ? {
          availability: "unavailable" as const,
          totalMs: null,
          includedRunCount: 0,
          missingRunCount,
          reason: AGENT_TIME_UNAVAILABLE_REASON
        }
      : {
          availability: missingRunCount === 0 ? ("complete" as const) : ("partial" as const),
          totalMs: availableDurations.reduce((total, duration) => total + duration, 0),
          includedRunCount: availableDurations.length,
          missingRunCount,
          reason: missingRunCount === 0 ? null : AGENT_TIME_PARTIAL_REASON
        };
  return { wallClock, agentTime };
}

function latestArtifact(records: DesktopRunRecord[]) {
  for (const record of sortRunsNewestFirst(records)) {
    const rawReference = record.metadata.artifactReference;
    if (record.reportPath === null && rawReference === undefined) continue;
    const reference =
      rawReference === undefined ? null : artifactReferenceSchema.parse(rawReference);
    return {
      recordId: record.recordId,
      blockRef: record.ref,
      runId: record.runId,
      reportPath: record.reportPath,
      reference,
      legacy: reference === null
    };
  }
  return null;
}

export async function getTaskWorkspace(
  rawInput: TaskWorkspaceInput,
  options: { now?: Date } = {}
): Promise<TaskWorkspace> {
  const input = taskWorkspaceInputSchema.parse(rawInput);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Task Workspace now must be a valid Date.");
  const workspace = await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId);
  const [taskDetail, executionStatus, hasActiveAutoRun] = await Promise.all([
    getTaskDetail(workspace, input.taskId),
    getExecutionStatus({ projectRoot: workspace }),
    hasNonTerminalAutoRunForTarget(input.projectRoot, input.canvasId)
  ]);
  const blockDetails = await Promise.all(
    taskDetail.blockOrder.map((ref) => getBlockDetail(workspace, ref))
  );
  const detailsByRef = new Map(blockDetails.map((detail) => [detail.ref, detail]));
  const [taskFeedbackRuns, taskFeedbackRecords] = await Promise.all([
    listTaskFeedbackRunRecords(input.projectRoot, input.canvasId, input.taskId),
    listTaskFeedbackRecords(input.projectRoot, input.canvasId, input.taskId)
  ]);
  for (const source of [...taskFeedbackRuns, ...taskFeedbackRecords]) {
    const detail = detailsByRef.get(source.sourceReviewBlockRef ?? "");
    if (detail?.type !== "review") {
      const actual = detail === undefined ? "a missing Block" : `a '${detail.type}' Block`;
      throw new Error(
        `Feedback source '${source.sourceReviewBlockRef}' must identify an existing Review Block in Task '${input.taskId}', but it identifies ${actual}.`
      );
    }
  }
  const recordsByRef = new Map<string, DesktopRunRecord[]>();
  const latestRecordIdByRef = new Map<string, string | null>();
  const feedbackRunsByRef = new Map<string, DesktopRunRecord[]>();
  const feedbackRecordsByRef = new Map<string, DesktopFeedbackRecord[]>();
  for (const detail of blockDetails) {
    feedbackRunsByRef.set(detail.ref, []);
    feedbackRecordsByRef.set(detail.ref, []);
  }
  const feedbackRuns = await Promise.all(
    taskFeedbackRuns.map((summary) => getRunRecord(workspace, summary.recordId))
  );
  for (const record of feedbackRuns) {
    const sourceReviewBlockRef = record.sourceReviewBlockRef;
    if (sourceReviewBlockRef === undefined || sourceReviewBlockRef === null) {
      throw new Error(`Feedback run '${record.recordId}' is missing sourceReviewBlockRef.`);
    }
    feedbackRunsByRef.get(sourceReviewBlockRef)?.push(record);
  }
  for (const feedback of taskFeedbackRecords) {
    feedbackRecordsByRef.get(feedback.sourceReviewBlockRef)?.push(feedback);
  }
  await Promise.all(
    blockDetails.map(async (detail) => {
      const summaries = await listBlockMainRunRecords(workspace, detail.ref);
      latestRecordIdByRef.set(detail.ref, summaries[0]?.recordId ?? null);
      const records = await Promise.all(
        summaries.map((summary) => getRunRecord(workspace, summary.recordId))
      );
      recordsByRef.set(
        detail.ref,
        sortRunsOldestFirst(records.filter((record) => (record.kind ?? "block") === "block"))
      );
    })
  );
  for (const [ref, runs] of feedbackRunsByRef) {
    feedbackRunsByRef.set(ref, sortRunsOldestFirst(runs));
  }

  const activeByRef = new Map<string, string>();
  for (const ref of executionStatus.currentRefs) {
    const active = recordsByRef
      .get(ref)
      ?.filter((record) => record.finishedAt === null && record.runnerReadModel?.terminal !== true)
      .at(-1);
    if (active) activeByRef.set(ref, active.recordId);
  }
  const allRecords = blockDetails.flatMap((detail) => recordsByRef.get(detail.ref) ?? []);
  const explicitSelection = input.selectedRecordId ?? null;
  if (
    explicitSelection !== null &&
    !allRecords.some((record) => record.recordId === explicitSelection)
  ) {
    throw new Error(
      `Selected Task Workspace record '${explicitSelection}' does not belong to task '${input.taskId}'.`
    );
  }
  const activeRecordIds = blockDetails.flatMap((detail) => {
    const recordId = activeByRef.get(detail.ref);
    return recordId === undefined ? [] : [recordId];
  });
  const selectedRecordId =
    explicitSelection ??
    (activeRecordIds.length === 1
      ? activeRecordIds[0]
      : activeRecordIds.length > 1
        ? null
        : (sortRunsNewestFirst(allRecords)[0]?.recordId ?? null));

  const blocks = await Promise.all(
    blockDetails.map(async (detail): Promise<TaskWorkspaceBlock> => {
      const records = recordsByRef.get(detail.ref) ?? [];
      const annotations =
        detail.type === "review"
          ? await annotationsForReviewBlock(
              workspace,
              detail.ref,
              feedbackRunsByRef.get(detail.ref) ?? [],
              feedbackRecordsByRef.get(detail.ref) ?? []
            )
          : [];
      return {
        ref: detail.ref,
        taskId: input.taskId,
        blockId: detail.blockId,
        type: detail.type,
        title: detail.title,
        status: detail.status,
        effectiveExecutor: detail.effectiveExecutor,
        promptMarkdown: detail.promptMarkdown,
        promptMissing: detail.promptMissing,
        promptSurfaceMarkdown: detail.promptSurfaceMarkdown,
        promptSources: detail.promptSources,
        dependencies: dependencyProgress(detail, detailsByRef),
        runs: records.map((record, index) => ({
          retryIndex: index + 1,
          active: activeByRef.get(detail.ref) === record.recordId,
          selected: selectedRecordId === record.recordId,
          waitingInteraction: waitingInteraction(record),
          run: projectTaskWorkspaceRun({
            record,
            runIdentity: canonicalTaskWorkspaceRunIdentity({
              workspace,
              canvasId: input.canvasId,
              record
            }),
            now,
            retry: evaluateTaskWorkspaceRetry({
              workspace,
              canvasId: input.canvasId,
              taskId: input.taskId,
              block: detail,
              record,
              selectedRecordId,
              latestRecordId: latestRecordIdByRef.get(detail.ref) ?? null,
              hasActiveRun: hasActiveAutoRun || activeRecordIds.length > 0,
              dependenciesSatisfied: dependencyProgress(detail, detailsByRef).blockers.length === 0
            })
          })
        })),
        annotations
      };
    })
  );
  const blockers = [...new Set(blocks.flatMap((block) => block.dependencies.blockers))];

  const dependencyTotal = blocks.reduce((total, block) => total + block.dependencies.total, 0);
  const dependencyCompleted = blocks.reduce(
    (total, block) => total + block.dependencies.completed,
    0
  );

  return taskWorkspaceSchema.parse({
    version: "planweave.task-workspace/v1",
    project: {
      projectId: workspace.id,
      projectRoot: workspace.rootPath,
      canvasId: input.canvasId
    },
    task: {
      taskId: taskDetail.taskId,
      title: taskDetail.title,
      status: taskDetail.status,
      executor: taskDetail.executor,
      promptMarkdown: taskDetail.promptMarkdown,
      promptMissing: taskDetail.promptMissing,
      acceptance: taskDetail.acceptance
    },
    dependencyProgress: projectDependencyProgress({
      total: dependencyTotal,
      completed: dependencyCompleted,
      blockers
    }),
    blocks,
    activeRecordIds,
    selectedRecordId,
    latestArtifact: latestArtifact(allRecords),
    duration: projectTaskWorkspaceDuration(blocks, now),
    usage: {
      taskTokens: {
        available: false,
        totalTokens: null,
        reason: TASK_WORKSPACE_TASK_TOKENS_UNAVAILABLE_REASON
      },
      taskCost: {
        available: false,
        totals: null,
        reason: TASK_WORKSPACE_TASK_COST_UNAVAILABLE_REASON
      }
    }
  });
}

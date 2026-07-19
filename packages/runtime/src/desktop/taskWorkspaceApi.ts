import { artifactReferenceSchema } from "../autoRun/runnerContractSchemas.js";
import type { ProjectWorkspace } from "../types.js";
import {
  readBlockRunIndexEntry,
  readBlockRunIndexSummary,
  readBlockRunIndexView,
  type BlockRunLogicalCursor
} from "../autoRun/blockRunIndex.js";
import { optionalStat } from "../fs/optionalFile.js";
import { buildBlockDetailsForTask, buildTaskDetail } from "./graph/readModel.js";
import {
  getReviewAttempts,
  getRunRecordFromWorkspace,
  getRunRecordIndexEntryFromWorkspace,
  listTaskFeedbackRecordsFromSnapshot,
  listTaskFeedbackRunRecordsFromSnapshot,
  runIndexAsProjectionRecord,
  type DesktopRunRecordIndexEntry,
  blockRunRoot
} from "./recordsApi.js";
import { hasNonTerminalAutoRunForTarget } from "./runApi.js";
import { parseRunRecordId, runRecordId } from "./runRecordIdentity.js";
import { projectTaskWorkspaceDuration } from "./taskWorkspaceDurationProjection.js";
import { projectTaskWorkspaceRun } from "./taskWorkspaceRunProjection.js";
import {
  canonicalTaskWorkspaceRunIdentity,
  evaluateTaskWorkspaceRetry
} from "./taskWorkspaceRetry.js";
import { evaluateTaskWorkspaceAcpRecovery } from "./taskWorkspaceAcpRecovery.js";
import {
  TASK_WORKSPACE_TASK_COST_UNAVAILABLE_REASON,
  taskWorkspaceInputSchema,
  taskWorkspaceSchema,
  type TaskWorkspace,
  type TaskWorkspaceAnnotation,
  type TaskWorkspaceBlock,
  type TaskWorkspaceInput
} from "./types/taskWorkspaceAggregateTypes.js";
import {
  TASK_WORKSPACE_RUNS_DEFAULT_LIMIT,
  TASK_WORKSPACE_RUNS_MAX_LIMIT,
  taskWorkspaceListRunsInputSchema,
  taskWorkspaceRunDetailInputSchema,
  taskWorkspaceRunDetailSchema,
  taskWorkspaceRunsCursorSchema,
  taskWorkspaceRunsPageSchema,
  type TaskWorkspaceListRunsInput,
  type TaskWorkspaceRunDetail,
  type TaskWorkspaceRunDetailInput,
  type TaskWorkspaceRunListItem,
  type TaskWorkspaceRunsCursor,
  type TaskWorkspaceRunsPage
} from "./types/taskWorkspaceQueryTypes.js";
import { TASK_WORKSPACE_TASK_TOKENS_UNAVAILABLE_REASON } from "./types/taskWorkspaceTypes.js";
import { createTaskWorkspaceReadContext } from "./taskWorkspaceReadContext.js";
import type {
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopRunRecord
} from "./types.js";

type RunLocator = {
  blockRef: string;
  runId: string;
  recordId: string;
  orderedAtMs: number;
  retryIndex: number;
  entry?: DesktopRunRecordIndexEntry;
};

function compareRunLocatorsNewestFirst(left: RunLocator, right: RunLocator): number {
  const byTime = right.orderedAtMs - left.orderedAtMs;
  if (byTime !== 0) return byTime;
  return right.recordId.localeCompare(left.recordId);
}

function cursorForLocator(
  locator: RunLocator,
  taskId: string,
  canvasId: string
): TaskWorkspaceRunsCursor {
  return taskWorkspaceRunsCursorSchema.parse({
    version: "planweave.task-workspace-runs-cursor/v2",
    taskId,
    canvasId,
    orderedAt: new Date(locator.orderedAtMs).toISOString(),
    recordId: locator.recordId
  });
}

/**
 * Cursor is a Task-scoped continuation token: recordId must name a block run whose
 * blockRef is in the current task's block set. The cursor row itself may already be
 * deleted; pagination continues by stable sort key once scope is accepted.
 */
function assertRunsCursorInTaskScope(
  cursor: TaskWorkspaceRunsCursor,
  taskId: string,
  canvasId: string,
  blockRefSet: ReadonlySet<string>
): void {
  if (cursor.taskId !== taskId || cursor.canvasId !== canvasId) {
    throw new Error(
      `Task Workspace runs cursor scope '${cursor.canvasId}/${cursor.taskId}' does not match '${canvasId}/${taskId}'.`
    );
  }
  const parsed = parseRunRecordId(cursor.recordId);
  if (parsed.kind !== "block") {
    throw new Error(
      `Task Workspace runs cursor only supports block runs; got '${cursor.recordId}'.`
    );
  }
  if (!blockRefSet.has(parsed.blockRef)) {
    throw new Error(
      `Task Workspace runs cursor '${cursor.recordId}' does not belong to task '${taskId}'.`
    );
  }
}

function waitingInteractionInactive() {
  return { active: false as const, count: 0 as const, kinds: [] as [] };
}

async function annotationsForReviewBlock(
  workspace: ProjectWorkspace,
  ref: string,
  feedbackRunSummaries: DesktopBlockRunRecordSummary[],
  feedbackRecords: DesktopFeedbackRecord[]
): Promise<TaskWorkspaceAnnotation[]> {
  const attempts = await getReviewAttempts(workspace, ref);
  const orderedAttempts = [...attempts].sort((left, right) => {
    const leftAt = left.reviewedAt ? Date.parse(left.reviewedAt) : Number.MAX_SAFE_INTEGER;
    const rightAt = right.reviewedAt ? Date.parse(right.reviewedAt) : Number.MAX_SAFE_INTEGER;
    return leftAt - rightAt || left.attemptId.localeCompare(right.attemptId);
  });
  const attemptOrder = new Map(
    orderedAttempts.map((attempt, index) => [attempt.attemptId, index] as const)
  );
  const feedbackById = new Map(feedbackRecords.map((feedback) => [feedback.feedbackId, feedback]));
  const matchedFeedbackIds = new Set(
    feedbackRunSummaries.flatMap((record) => (record.feedbackId ? [record.feedbackId] : []))
  );
  const annotations: TaskWorkspaceAnnotation[] = [
    ...orderedAttempts.map(
      (attempt): TaskWorkspaceAnnotation => ({
        kind: "review_attempt",
        annotationId: `review:${attempt.attemptId}`,
        sourceReviewBlockRef: ref,
        associatedRunRecordId: null,
        attemptId: attempt.attemptId,
        verdict: attempt.verdict,
        content: attempt.content,
        contentPreview: attempt.contentPreview,
        reviewedAt: attempt.reviewedAt
      })
    ),
    ...feedbackRecords
      .filter((feedback) => !matchedFeedbackIds.has(feedback.feedbackId))
      .map(
        (feedback): TaskWorkspaceAnnotation => ({
          kind: "feedback",
          annotationId: `feedback:${feedback.feedbackId}`,
          sourceReviewBlockRef: feedback.sourceReviewBlockRef,
          associatedRunRecordId: null,
          feedbackId: feedback.feedbackId,
          sourceReviewAttemptId: feedback.sourceReviewAttemptId,
          status: feedback.status,
          latestSubmissionId: feedback.latestSubmissionId,
          content: feedback.content,
          contentPreview: feedback.content.trim().slice(0, 400),
          createdAt: feedback.createdAt
        })
      ),
    ...feedbackRunSummaries.map((record): TaskWorkspaceAnnotation => {
      if (record.sourceReviewBlockRef !== ref) {
        throw new Error(
          `Feedback run '${record.recordId}' does not identify review block '${ref}' as its source.`
        );
      }
      const feedback = record.feedbackId ? feedbackById.get(record.feedbackId) : undefined;
      return {
        kind: "feedback_run",
        annotationId: record.recordId,
        sourceReviewBlockRef: record.sourceReviewBlockRef!,
        associatedRunRecordId: record.recordId,
        recordId: record.recordId,
        feedbackId: record.feedbackId ?? null,
        sourceReviewAttemptId: feedback?.sourceReviewAttemptId ?? null,
        status: feedback?.status ?? null,
        contentPreview: feedback?.content.trim().slice(0, 400) ?? "",
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        reportPath: record.reportPath
      };
    })
  ];
  const sortKey = (annotation: TaskWorkspaceAnnotation) => {
    const attemptId =
      annotation.kind === "review_attempt"
        ? annotation.attemptId
        : annotation.sourceReviewAttemptId;
    const cycle =
      attemptId === null || !attemptOrder.has(attemptId)
        ? Number.MAX_SAFE_INTEGER
        : attemptOrder.get(attemptId)!;
    const phase = annotation.kind === "review_attempt" ? 0 : 1;
    const timestamp =
      annotation.kind === "review_attempt"
        ? annotation.reviewedAt
        : annotation.kind === "feedback"
          ? annotation.createdAt
          : annotation.startedAt;
    return [cycle, phase, timestamp ? Date.parse(timestamp) : Number.MAX_SAFE_INTEGER] as const;
  };
  return annotations.sort((left, right) => {
    const leftKey = sortKey(left);
    const rightKey = sortKey(right);
    return (
      leftKey[0] - rightKey[0] ||
      leftKey[1] - rightKey[1] ||
      leftKey[2] - rightKey[2] ||
      left.annotationId.localeCompare(right.annotationId)
    );
  });
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

function artifactFromIndexEntry(entry: DesktopRunRecordIndexEntry) {
  const record = entry.summary;
  const rawReference = entry.metadata.artifactReference;
  if (record.reportPath === null && rawReference === undefined) {
    return null;
  }
  const reference = rawReference === undefined ? null : artifactReferenceSchema.parse(rawReference);
  return {
    recordId: record.recordId,
    blockRef: record.ref,
    runId: record.runId,
    reportPath: record.reportPath,
    reference,
    legacy: reference === null
  };
}

/**
 * Newest-first walk over the full locator history (metadata/path only).
 * Preserves “latest available artifact may be older than the page window” semantics
 * without loading run content.
 */
async function findLatestArtifact(workspace: ProjectWorkspace, locators: readonly RunLocator[]) {
  for (const locator of locators) {
    const entry = await getRunRecordIndexEntryFromWorkspace(workspace, locator.recordId);
    const artifact = artifactFromIndexEntry(entry);
    if (artifact !== null) {
      return artifact;
    }
  }
  return null;
}

function runRootForBlock(workspace: ProjectWorkspace, blockRef: string): string {
  return blockRunRoot(workspace.resultsDir, blockRef);
}

async function indexedBlockSummary(workspace: ProjectWorkspace, blockRef: string) {
  const runRoot = runRootForBlock(workspace, blockRef);
  if (!(await optionalStat(runRoot))) {
    return { head: null, latestArtifactRunId: null };
  }
  return readBlockRunIndexSummary(runRoot);
}

async function queryTaskRunLocators(
  workspace: ProjectWorkspace,
  blockRefs: readonly string[],
  cursor: TaskWorkspaceRunsCursor | null,
  limit: number
): Promise<{
  hasMore: boolean;
  latestByBlock: Map<string, string | null>;
  locators: RunLocator[];
}> {
  const before: BlockRunLogicalCursor | undefined = cursor
    ? { orderedAt: cursor.orderedAt, stableIdentity: cursor.recordId }
    : undefined;
  const batches = await Promise.all(
    blockRefs.map(async (blockRef) => {
      const runRoot = runRootForBlock(workspace, blockRef);
      if (!(await optionalStat(runRoot))) {
        return { blockRef, entries: [], hasMore: false, latestRecordId: null };
      }
      const view = await readBlockRunIndexView(runRoot, { before, limit: limit + 1 });
      return {
        blockRef,
        entries: view.entries,
        hasMore: view.hasMore,
        latestRecordId: view.head ? runRecordId(blockRef, view.head.runId) : null
      };
    })
  );
  let merged = (
    await Promise.all(
      batches.map(async (batch) =>
        Promise.all(
          batch.entries.map(async (entry): Promise<RunLocator> => {
            const recordId = runRecordId(batch.blockRef, entry.runId);
            const recordEntry = await getRunRecordIndexEntryFromWorkspace(workspace, recordId);
            return {
              blockRef: batch.blockRef,
              runId: entry.runId,
              recordId,
              orderedAtMs: Date.parse(entry.orderedAt),
              retryIndex: entry.retryIndex,
              entry: recordEntry
            };
          })
        )
      )
    )
  )
    .flat()
    .sort(compareRunLocatorsNewestFirst);
  if (cursor) {
    const parsedCursor = parseRunRecordId(cursor.recordId);
    if (parsedCursor.kind !== "block") {
      throw new Error(`Task Workspace cursor '${cursor.recordId}' is not a block run.`);
    }
    const cursorLocator: RunLocator = {
      blockRef: parsedCursor.blockRef,
      runId: parsedCursor.runId,
      recordId: cursor.recordId,
      orderedAtMs: Date.parse(cursor.orderedAt),
      retryIndex: 1
    };
    merged = merged.filter((locator) => compareRunLocatorsNewestFirst(locator, cursorLocator) > 0);
  }
  const locators = merged.slice(0, limit);
  return {
    hasMore: merged.length > limit || batches.some((batch) => batch.hasMore),
    latestByBlock: new Map(batches.map((batch) => [batch.blockRef, batch.latestRecordId])),
    locators
  };
}

async function resolveActiveRecordIds(options: {
  workspace: ProjectWorkspace;
  blockRefs: ReadonlySet<string>;
  currentRefs: readonly string[];
}): Promise<string[]> {
  const activeRecordIds: string[] = [];
  for (const ref of options.currentRefs) {
    if (!options.blockRefs.has(ref)) continue;
    const summary = await indexedBlockSummary(options.workspace, ref);
    if (summary.head) {
      const entry = await getRunRecordIndexEntryFromWorkspace(
        options.workspace,
        runRecordId(ref, summary.head.runId)
      );
      if (entry.summary.finishedAt === null) activeRecordIds.push(entry.summary.recordId);
    }
  }
  return activeRecordIds;
}

async function projectSummaryRunItem(options: {
  workspace: ProjectWorkspace;
  canvasId: TaskWorkspaceInput["canvasId"];
  taskId: TaskWorkspaceInput["taskId"];
  block: DesktopBlockDetail;
  entry: DesktopRunRecordIndexEntry;
  retryIndex: number;
  active: boolean;
  selected: boolean;
  latestRecordId: string | null;
  hasActiveRun: boolean;
  dependenciesSatisfied: boolean;
  now: Date;
}): Promise<TaskWorkspaceRunListItem> {
  const record = runIndexAsProjectionRecord(options.entry);
  if ((record.kind ?? "block") !== "block") {
    throw new Error(`Task Workspace list only supports block runs, got '${record.kind}'.`);
  }
  const projected = projectTaskWorkspaceRun({
    record: { ...record, kind: "block" },
    runIdentity: canonicalTaskWorkspaceRunIdentity({
      workspace: options.workspace,
      canvasId: options.canvasId,
      record: { ...record, kind: "block" }
    }),
    now: options.now,
    retry: evaluateTaskWorkspaceRetry({
      workspace: options.workspace,
      canvasId: options.canvasId,
      taskId: options.taskId,
      block: options.block,
      record: { ...record, kind: "block" },
      selectedRecordId: options.selected ? record.recordId : null,
      latestRecordId: options.latestRecordId,
      hasActiveRun: options.hasActiveRun,
      dependenciesSatisfied: options.dependenciesSatisfied
    }),
    recoverAcpSession: await evaluateTaskWorkspaceAcpRecovery({
      workspace: options.workspace,
      canvasId: options.canvasId,
      taskId: options.taskId,
      block: options.block,
      record: { ...record, kind: "block" },
      selectedRecordId: options.selected ? record.recordId : null,
      latestRecordId: options.latestRecordId,
      hasActiveRun: options.hasActiveRun,
      dependenciesSatisfied: options.dependenciesSatisfied,
      newerRecoveryChild: false
    })
  });
  return {
    blockRef: options.block.ref,
    retryIndex: options.retryIndex,
    active: options.active,
    selected: options.selected,
    waitingInteraction: waitingInteractionInactive(),
    run: projected
  };
}

/**
 * Task Workspace header: task/blocks/annotations/selection hints without loading full run history.
 * Block `runs` arrays are empty; load pages via listTaskWorkspaceRuns.
 */
export async function getTaskWorkspace(
  rawInput: TaskWorkspaceInput,
  options: { now?: Date } = {}
): Promise<TaskWorkspace> {
  const input = taskWorkspaceInputSchema.parse(rawInput);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Task Workspace now must be a valid Date.");
  const readContext = await createTaskWorkspaceReadContext({
    projectRoot: input.projectRoot,
    canvasId: input.canvasId
  });
  const { workspace } = readContext.runtime;
  const executionStatus = readContext.status;
  const [taskDetail, blockDetails] = await Promise.all([
    buildTaskDetail(readContext, input.taskId),
    buildBlockDetailsForTask(readContext, input.taskId)
  ]);
  const detailsByRef = new Map(blockDetails.map((detail) => [detail.ref, detail]));
  const blockRefSet = new Set(blockDetails.map((detail) => detail.ref));

  // Feedback annotations use metadata/path index only — never stdout/stderr content.
  const [taskFeedbackRunSummaries, taskFeedbackRecords] = await Promise.all([
    listTaskFeedbackRunRecordsFromSnapshot(readContext.runtime, input.canvasId, input.taskId),
    listTaskFeedbackRecordsFromSnapshot(readContext.runtime, input.canvasId, input.taskId)
  ]);
  for (const source of [...taskFeedbackRunSummaries, ...taskFeedbackRecords]) {
    const detail = detailsByRef.get(source.sourceReviewBlockRef ?? "");
    if (detail?.type !== "review") {
      const actual = detail === undefined ? "a missing Block" : `a '${detail.type}' Block`;
      throw new Error(
        `Feedback source '${source.sourceReviewBlockRef}' must identify an existing Review Block in Task '${input.taskId}', but it identifies ${actual}.`
      );
    }
  }

  const feedbackSummariesByRef = new Map<string, DesktopBlockRunRecordSummary[]>();
  const feedbackRecordsByRef = new Map<string, DesktopFeedbackRecord[]>();
  for (const detail of blockDetails) {
    feedbackSummariesByRef.set(detail.ref, []);
    feedbackRecordsByRef.set(detail.ref, []);
  }
  for (const summary of taskFeedbackRunSummaries) {
    const source = summary.sourceReviewBlockRef;
    if (!source) {
      throw new Error(`Feedback run '${summary.recordId}' is missing sourceReviewBlockRef.`);
    }
    feedbackSummariesByRef.get(source)?.push(summary);
  }
  for (const feedback of taskFeedbackRecords) {
    feedbackRecordsByRef.get(feedback.sourceReviewBlockRef)?.push(feedback);
  }

  const activeRecordIds = await resolveActiveRecordIds({
    workspace,
    blockRefs: blockRefSet,
    currentRefs: executionStatus.currentRefs
  });

  const blockIndexSummaries = await Promise.all(
    blockDetails.map(async (detail) => ({
      blockRef: detail.ref,
      summary: await indexedBlockSummary(workspace, detail.ref)
    }))
  );
  const headLocators = (
    await Promise.all(
      blockIndexSummaries.map(async ({ blockRef, summary }): Promise<RunLocator | null> => {
        if (!summary.head) return null;
        const recordId = runRecordId(blockRef, summary.head.runId);
        const entry = await getRunRecordIndexEntryFromWorkspace(workspace, recordId);
        return {
          blockRef,
          runId: summary.head.runId,
          recordId,
          orderedAtMs: Date.parse(summary.head.orderedAt),
          retryIndex: summary.head.retryIndex,
          entry
        } satisfies RunLocator;
      })
    )
  )
    .filter((locator): locator is RunLocator => locator !== null)
    .sort(compareRunLocatorsNewestFirst);
  const explicitSelection = input.selectedRecordId ?? null;
  if (explicitSelection !== null) {
    const parsedSelection = parseRunRecordId(explicitSelection);
    const validBlockSelection =
      parsedSelection.kind === "block" && blockRefSet.has(parsedSelection.blockRef);
    const validFeedbackSelection =
      parsedSelection.kind === "feedback" &&
      taskFeedbackRunSummaries.some((summary) => summary.recordId === explicitSelection);
    if (!validBlockSelection && !validFeedbackSelection) {
      throw new Error(
        `Selected Task Workspace record '${explicitSelection}' does not belong to task '${input.taskId}'.`
      );
    }
    if (parsedSelection.kind === "block") {
      await readBlockRunIndexEntry(
        runRootForBlock(workspace, parsedSelection.blockRef),
        parsedSelection.runId
      );
    }
  }
  const selectedRecordId =
    explicitSelection ??
    (activeRecordIds.length === 1
      ? activeRecordIds[0]!
      : activeRecordIds.length > 1
        ? null
        : (headLocators[0]?.recordId ?? null));

  const artifactLocators = (
    await Promise.all(
      blockIndexSummaries.map(async ({ blockRef, summary }): Promise<RunLocator | null> => {
        if (!summary.latestArtifactRunId) return null;
        const recordId = runRecordId(blockRef, summary.latestArtifactRunId);
        const entry = await getRunRecordIndexEntryFromWorkspace(workspace, recordId);
        return {
          blockRef,
          runId: summary.latestArtifactRunId,
          recordId,
          orderedAtMs: Date.parse(
            summary.latestArtifactRunId === summary.head?.runId
              ? summary.head.orderedAt
              : (
                  await readBlockRunIndexEntry(
                    runRootForBlock(workspace, blockRef),
                    summary.latestArtifactRunId
                  )
                ).orderedAt
          ),
          retryIndex: 1,
          entry
        } satisfies RunLocator;
      })
    )
  )
    .filter((locator): locator is RunLocator => locator !== null)
    .sort(compareRunLocatorsNewestFirst);
  const latestArtifact = await findLatestArtifact(workspace, artifactLocators);

  const blocks = await Promise.all(
    blockDetails.map(async (detail): Promise<TaskWorkspaceBlock> => {
      const annotations =
        detail.type === "review"
          ? await annotationsForReviewBlock(
              workspace,
              detail.ref,
              feedbackSummariesByRef.get(detail.ref) ?? [],
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
        executor: detail.executor,
        effectiveExecutor: detail.effectiveExecutor,
        promptMarkdown: detail.promptMarkdown,
        promptMissing: detail.promptMissing,
        promptSurfaceMarkdown: detail.promptSurfaceMarkdown,
        promptSources: detail.promptSources,
        dependencies: dependencyProgress(detail, detailsByRef),
        runs: [],
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

  // Duration requires run rows; header leaves it unavailable until pages are composed.
  const emptyDuration = projectTaskWorkspaceDuration(blocks, now);

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
    latestArtifact,
    duration: emptyDuration,
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

/**
 * Paginated newest-first run summaries for a Task. Snapshot-like cursor continuation:
 * already-returned rows are not repeated; newer inserts appear only on refresh/first page.
 */
export async function listTaskWorkspaceRuns(
  rawInput: TaskWorkspaceListRunsInput,
  options: { now?: Date; selectedRecordId?: string | null } = {}
): Promise<TaskWorkspaceRunsPage> {
  const input = taskWorkspaceListRunsInputSchema.parse(rawInput);
  const limit = input.limit ?? TASK_WORKSPACE_RUNS_DEFAULT_LIMIT;
  if (limit > TASK_WORKSPACE_RUNS_MAX_LIMIT) {
    throw new Error(`limit must be <= ${TASK_WORKSPACE_RUNS_MAX_LIMIT}.`);
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Task Workspace now must be a valid Date.");

  const readContext = await createTaskWorkspaceReadContext({
    projectRoot: input.projectRoot,
    canvasId: input.canvasId
  });
  const { workspace } = readContext.runtime;
  const executionStatus = readContext.status;
  const [blockDetails, hasActiveAutoRun] = await Promise.all([
    buildBlockDetailsForTask(readContext, input.taskId),
    hasNonTerminalAutoRunForTarget(input.projectRoot, input.canvasId)
  ]);
  const detailsByRef = new Map(blockDetails.map((detail) => [detail.ref, detail]));
  const blockRefSet = new Set(blockDetails.map((detail) => detail.ref));

  const cursor = input.cursor ?? null;
  if (cursor !== null) {
    taskWorkspaceRunsCursorSchema.parse(cursor);
    assertRunsCursorInTaskScope(cursor, input.taskId, input.canvasId, blockRefSet);
  }
  const indexedPage = await queryTaskRunLocators(
    workspace,
    blockDetails.map((detail) => detail.ref),
    cursor,
    limit
  );
  const pageLocators = indexedPage.locators;

  const activeRecordIds = await resolveActiveRecordIds({
    workspace,
    blockRefs: blockRefSet,
    currentRefs: executionStatus.currentRefs
  });
  const activeSet = new Set(activeRecordIds);
  const selectedRecordId = options.selectedRecordId ?? null;
  const hasActiveRun = hasActiveAutoRun || activeRecordIds.length > 0;

  const items = await Promise.all(
    pageLocators.map(async (locator) => {
      const detail = detailsByRef.get(locator.blockRef);
      if (!detail) {
        throw new Error(`Block '${locator.blockRef}' is missing from task '${input.taskId}'.`);
      }
      const entry =
        locator.entry ?? (await getRunRecordIndexEntryFromWorkspace(workspace, locator.recordId));
      return projectSummaryRunItem({
        workspace,
        canvasId: input.canvasId,
        taskId: input.taskId,
        block: detail,
        entry,
        retryIndex: locator.retryIndex,
        active: activeSet.has(locator.recordId),
        selected: selectedRecordId === locator.recordId,
        latestRecordId: indexedPage.latestByBlock.get(locator.blockRef) ?? null,
        hasActiveRun,
        dependenciesSatisfied: dependencyProgress(detail, detailsByRef).blockers.length === 0,
        now
      });
    })
  );

  const last = pageLocators.at(-1);
  return taskWorkspaceRunsPageSchema.parse({
    version: "planweave.task-workspace-runs-page/v1",
    projectRoot: workspace.rootPath,
    canvasId: input.canvasId,
    taskId: input.taskId,
    limit,
    items,
    nextCursor:
      indexedPage.hasMore && last ? cursorForLocator(last, input.taskId, input.canvasId) : null
  });
}

/** Single-run detail: full prompt/stdout/stderr/events for a record owned by the task. */
export async function getTaskWorkspaceRunDetail(
  rawInput: TaskWorkspaceRunDetailInput,
  options: { now?: Date; selectedRecordId?: string | null } = {}
): Promise<TaskWorkspaceRunDetail> {
  const input = taskWorkspaceRunDetailInputSchema.parse(rawInput);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Task Workspace now must be a valid Date.");

  const readContext = await createTaskWorkspaceReadContext({
    projectRoot: input.projectRoot,
    canvasId: input.canvasId
  });
  const { workspace } = readContext.runtime;
  const executionStatus = readContext.status;
  const parsed = parseRunRecordId(input.recordId);
  const [taskDetail, blockDetails, record, hasActiveAutoRun] = await Promise.all([
    buildTaskDetail(readContext, input.taskId),
    buildBlockDetailsForTask(readContext, input.taskId),
    getRunRecordFromWorkspace(workspace, input.recordId),
    hasNonTerminalAutoRunForTarget(input.projectRoot, input.canvasId)
  ]);
  const detailsByRef = new Map(blockDetails.map((detail) => [detail.ref, detail]));
  const sourceBlockRef = parsed.kind === "block" ? parsed.blockRef : record.sourceReviewBlockRef;
  if (
    sourceBlockRef === null ||
    sourceBlockRef === undefined ||
    record.taskId !== input.taskId ||
    !taskDetail.blockOrder.includes(sourceBlockRef)
  ) {
    throw new Error(
      `Selected Task Workspace record '${input.recordId}' does not belong to task '${input.taskId}'.`
    );
  }
  const blockDetail = detailsByRef.get(sourceBlockRef);
  if (!blockDetail) {
    throw new Error(`Block '${sourceBlockRef}' is missing from task '${input.taskId}'.`);
  }
  if (parsed.kind === "feedback" && blockDetail.type !== "review") {
    throw new Error(
      `Feedback run '${input.recordId}' source '${sourceBlockRef}' must identify a Review Block.`
    );
  }

  let retryIndex = 1;
  let latestRecordId: string | null = null;
  if (parsed.kind === "block") {
    const [blockIndexEntry, blockIndexSummary] = await Promise.all([
      readBlockRunIndexEntry(runRootForBlock(workspace, parsed.blockRef), parsed.runId),
      indexedBlockSummary(workspace, parsed.blockRef)
    ]);
    latestRecordId = blockIndexSummary.head
      ? runRecordId(parsed.blockRef, blockIndexSummary.head.runId)
      : null;
    retryIndex = blockIndexEntry.retryIndex;
  } else {
    const feedbackRuns = (
      await listTaskFeedbackRunRecordsFromSnapshot(
        readContext.runtime,
        input.canvasId,
        input.taskId
      )
    )
      .filter((summary) => summary.feedbackId === parsed.feedbackId)
      .reverse();
    const feedbackIndex = feedbackRuns.findIndex((summary) => summary.recordId === input.recordId);
    if (feedbackIndex < 0) {
      throw new Error(
        `Selected Task Workspace record '${input.recordId}' does not belong to task '${input.taskId}'.`
      );
    }
    retryIndex = feedbackIndex + 1;
  }

  const activeRecordIds = await resolveActiveRecordIds({
    workspace,
    blockRefs: new Set(taskDetail.blockOrder),
    currentRefs: executionStatus.currentRefs
  });
  const selectedRecordId = options.selectedRecordId ?? input.recordId;
  const active =
    parsed.kind === "block"
      ? activeRecordIds.includes(record.recordId)
      : record.finishedAt === null && hasActiveAutoRun;

  const projected = projectTaskWorkspaceRun({
    record: { ...record, kind: parsed.kind },
    runIdentity: canonicalTaskWorkspaceRunIdentity({
      workspace,
      canvasId: input.canvasId,
      record
    }),
    now,
    retry:
      parsed.kind === "block"
        ? evaluateTaskWorkspaceRetry({
            workspace,
            canvasId: input.canvasId,
            taskId: input.taskId,
            block: blockDetail,
            record,
            selectedRecordId,
            latestRecordId,
            hasActiveRun: hasActiveAutoRun || activeRecordIds.length > 0,
            dependenciesSatisfied:
              dependencyProgress(blockDetail, detailsByRef).blockers.length === 0
          })
        : undefined,
    recoverAcpSession:
      parsed.kind === "block"
        ? await evaluateTaskWorkspaceAcpRecovery({
            workspace,
            canvasId: input.canvasId,
            taskId: input.taskId,
            block: blockDetail,
            record,
            selectedRecordId,
            latestRecordId,
            hasActiveRun: hasActiveAutoRun || activeRecordIds.length > 0,
            dependenciesSatisfied:
              dependencyProgress(blockDetail, detailsByRef).blockers.length === 0,
            newerRecoveryChild: false
          })
        : undefined
  });

  const waiting = record.runnerReadModel?.interaction.activeRequests ?? [];
  const waitingInteraction =
    waiting.length === 0
      ? waitingInteractionInactive()
      : {
          active: true as const,
          count: waiting.length,
          kinds: [...new Set(waiting.map((request) => request.kind))].sort()
        };

  return taskWorkspaceRunDetailSchema.parse({
    version: "planweave.task-workspace-run-detail/v1",
    projectRoot: workspace.rootPath,
    canvasId: input.canvasId,
    taskId: input.taskId,
    blockRef: sourceBlockRef,
    item: {
      retryIndex,
      active,
      selected: selectedRecordId === record.recordId,
      waitingInteraction,
      run: projected
    },
    record
  });
}

export type { DesktopRunRecord };

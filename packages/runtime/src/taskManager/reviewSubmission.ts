import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isNodeFileNotFoundError, optionalReaddir } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  ExecutionGraphSession,
  FeedbackStatus,
  PackageWorkspaceRef,
  ProjectWorkspace,
  ReviewResult,
  SubmitReviewResult,
  TaskResultIndex,
  ValidationIssue
} from "../types.js";
import { writeFeedbackArtifact, type FeedbackArtifact } from "./feedbackArtifacts.js";
import { executeReviewHook } from "./reviewHook.js";
import { reviewResultSchema } from "./reviewResultContract.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import {
  allocatePrefixedId,
  incrementTaskIndexCount,
  listDirCount,
  nextId,
  recordReviewCompletionReason,
  updateTaskIndex
} from "./resultIndex.js";
import { computeWorkRevision, getBlock, getTask, isActiveFeedbackStatus } from "./selectors.js";

function reviewResultHash(result: ReviewResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

type PersistedReviewAttempt = {
  attemptId: string;
  reviewedWorkRevision: string | null;
  sourceResultPath: string | null;
};

function isNonMissingNodeFileError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && !isNodeFileNotFoundError(error)
  );
}

async function recordReviewAttemptIndexes(options: {
  workspace: ProjectWorkspace;
  reviewBlockRef: string;
  reviewResult: ReviewResult;
  workRevision: string;
  attemptId: string;
  incrementCount: boolean;
}): Promise<void> {
  const { taskId, blockId } = parseBlockRef(options.reviewBlockRef);
  await writeJsonFile(
    join(options.workspace.resultsDir, taskId, "reviews", blockId, "index.json"),
    {
      latestReviewAttemptId: options.attemptId,
      latestVerdict: options.reviewResult.verdict,
      reviewedWorkRevision: options.workRevision
    }
  );
  await updateTaskIndex(options.workspace, taskId, (index) => ({
    ...index,
    latestReviewAttemptByBlock: {
      ...(index.latestReviewAttemptByBlock ?? {}),
      [options.reviewBlockRef]: options.attemptId
    },
    latestReviewVerdictByBlock: {
      ...(index.latestReviewVerdictByBlock ?? {}),
      [options.reviewBlockRef]: options.reviewResult.verdict
    },
    latestReviewedWorkRevisionByBlock: {
      ...(index.latestReviewedWorkRevisionByBlock ?? {}),
      [options.reviewBlockRef]: options.workRevision
    },
    counts: options.incrementCount ? incrementTaskIndexCount(index, "reviewAttempts") : index.counts
  }));
}

async function writeReviewAttempt(options: {
  workspace: ProjectWorkspace;
  reviewBlockRef: string;
  reviewResult: ReviewResult;
  workRevision: string;
  resultHash: string;
  resultPath: string;
}): Promise<string> {
  const { taskId, blockId } = parseBlockRef(options.reviewBlockRef);
  const attemptRoot = join(options.workspace.resultsDir, taskId, "reviews", blockId, "attempts");
  const attemptId = await allocatePrefixedId(attemptRoot, "REV");
  const attemptDir = join(attemptRoot, attemptId);
  await writeJsonFile(join(attemptDir, "review-result.json"), options.reviewResult);
  await writeJsonFile(join(attemptDir, "metadata.json"), {
    reviewBlockRef: options.reviewBlockRef,
    attemptId,
    reviewedWorkRevision: options.workRevision,
    resultHash: options.resultHash,
    sourceResultPath: resolve(options.resultPath),
    reviewedAt: new Date().toISOString()
  });
  await recordReviewAttemptIndexes({ ...options, attemptId, incrementCount: true });
  return attemptId;
}

async function readMatchingReviewAttempt(options: {
  attemptDir: string;
  reviewBlockRef: string;
  attemptId: string;
  resultHash: string;
}): Promise<PersistedReviewAttempt | null> {
  try {
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(options.attemptDir, "metadata.json")
    );
    if (
      metadata.reviewBlockRef !== options.reviewBlockRef ||
      metadata.attemptId !== options.attemptId
    ) {
      return null;
    }
    if (
      reviewResultHash(
        reviewResultSchema.parse(
          await readJsonFile<unknown>(join(options.attemptDir, "review-result.json"))
        )
      ) !== options.resultHash
    ) {
      return null;
    }
    return {
      attemptId: options.attemptId,
      reviewedWorkRevision:
        typeof metadata.reviewedWorkRevision === "string" ? metadata.reviewedWorkRevision : null,
      sourceResultPath:
        typeof metadata.sourceResultPath === "string" ? metadata.sourceResultPath : null
    };
  } catch (error) {
    if (isNonMissingNodeFileError(error)) {
      throw error;
    }
    return null;
  }
}

async function findPersistedReviewAttempt(options: {
  workspace: ProjectWorkspace;
  reviewBlockRef: string;
  resultHash: string;
}): Promise<PersistedReviewAttempt | null> {
  const { taskId, blockId } = parseBlockRef(options.reviewBlockRef);
  const attemptRoot = join(options.workspace.resultsDir, taskId, "reviews", blockId, "attempts");
  const entries = await optionalReaddir(attemptRoot, { withFileTypes: true });
  if (!entries) {
    return null;
  }
  const attemptIds = entries
    .filter((entry) => entry.isDirectory() && /^REV-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const attemptId of attemptIds) {
    const attempt = await readMatchingReviewAttempt({
      attemptDir: join(attemptRoot, attemptId),
      reviewBlockRef: options.reviewBlockRef,
      attemptId,
      resultHash: options.resultHash
    });
    if (attempt) {
      return attempt;
    }
  }
  return null;
}

async function recordFeedbackEnvelopeIndexes(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  reviewBlockRef: string;
  feedbackId: string;
  feedbackStatus: FeedbackStatus;
  incrementCount: boolean;
}): Promise<void> {
  await updateTaskIndex(options.workspace, options.taskId, (index) => ({
    ...index,
    latestFeedbackByReviewBlock: {
      ...(index.latestFeedbackByReviewBlock ?? {}),
      [options.reviewBlockRef]: options.feedbackId
    },
    feedbackStatusById: {
      ...(index.feedbackStatusById ?? {}),
      [options.feedbackId]: options.feedbackStatus
    },
    counts: options.incrementCount
      ? incrementTaskIndexCount(index, "feedbackEnvelopes")
      : index.counts
  }));
}

async function findFeedbackForReviewAttempt(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  reviewBlockRef: string;
  attemptId: string;
}): Promise<FeedbackArtifact | null> {
  const feedbackRoot = join(options.workspace.resultsDir, options.taskId, "feedback");
  const entries = await optionalReaddir(feedbackRoot, { withFileTypes: true });
  if (!entries) {
    return null;
  }
  const feedbackIds = entries
    .filter((entry) => entry.isDirectory() && /^FE-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const feedbackId of feedbackIds) {
    try {
      const artifact = await readJsonFile<FeedbackArtifact>(
        join(feedbackRoot, feedbackId, "feedback.json")
      );
      if (
        artifact.feedbackId === feedbackId &&
        artifact.sourceReviewBlockRef === options.reviewBlockRef &&
        artifact.sourceReviewAttemptId === options.attemptId
      ) {
        return artifact;
      }
    } catch (error) {
      if (isNonMissingNodeFileError(error)) {
        throw error;
      }
      continue;
    }
  }
  return null;
}

async function reviewCompletionReasonForAttempt(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  reviewBlockRef: string;
  attemptId: string;
}): Promise<"passed" | "max_cycles_reached" | null> {
  try {
    const index = await readJsonFile<TaskResultIndex>(
      join(options.workspace.resultsDir, options.taskId, "index.json")
    );
    if (index.latestReviewAttemptByBlock?.[options.reviewBlockRef] !== options.attemptId) {
      return null;
    }
    return index.reviewCompletionReasonByBlock?.[options.reviewBlockRef] ?? null;
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function nextFeedbackId(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  state: { feedback: Record<string, unknown> };
}): Promise<string> {
  const feedbackRoot = join(options.workspace.resultsDir, options.taskId, "feedback");
  await mkdir(feedbackRoot, { recursive: true });
  let count = Math.max(
    Object.keys(options.state.feedback).length,
    await listDirCount(feedbackRoot)
  );
  for (let attempt = 0; attempt < 1000; attempt++) {
    const feedbackId = nextId("FE", count + attempt);
    if (options.state.feedback[feedbackId]) {
      continue;
    }
    try {
      await mkdir(join(feedbackRoot, feedbackId), { recursive: false });
      return feedbackId;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to allocate a feedback id under ${feedbackRoot}`);
}

function maxFeedbackCyclesReached(
  previousFeedbackCount: number,
  maxFeedbackCycles: number
): boolean {
  // maxFeedbackCycles counts re-review feedback cycles after the initial needs_changes envelope.
  return maxFeedbackCycles === 0 || previousFeedbackCount > maxFeedbackCycles;
}

function withoutCurrentRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.filter((currentRef) => currentRef !== ref);
}

export async function submitReviewResult(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  resultPath: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitReviewResult> {
  const parsed = reviewResultSchema.parse(await readJsonFile<unknown>(options.resultPath));
  return submitReviewResultValue(options, parsed);
}

export async function submitReviewResultValue(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    resultPath: string;
    session?: ExecutionGraphSession;
  },
  value: unknown
): Promise<SubmitReviewResult> {
  const parsed = reviewResultSchema.parse(value);
  const resultHash = reviewResultHash(parsed);
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(lockWorkspace.stateFile), async () =>
    submitReviewResultLocked(options, parsed, resultHash)
  );
}

async function submitReviewResultLocked(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    resultPath: string;
    session?: ExecutionGraphSession;
  },
  parsed: ReviewResult,
  resultHash: string
): Promise<SubmitReviewResult> {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  let { state } = context;
  const { taskId } = parseBlockRef(options.ref);
  const block = getBlock(graph, options.ref);
  if (block.type !== "review") {
    throw new Error("submit-review only accepts review blocks.");
  }
  if (parsed.reviewBlockRef !== options.ref || parsed.taskId !== taskId) {
    throw new Error("review-result.json does not match the submitted review block ref.");
  }
  if (state.blocks[options.ref]?.status !== "in_progress") {
    throw new Error(`Review block '${options.ref}' must be in_progress before submit-review.`);
  }
  const workRevision = computeWorkRevision(graph, state, options.ref);
  const persistedAttempt = await findPersistedReviewAttempt({
    workspace,
    reviewBlockRef: options.ref,
    resultHash
  });
  const persistedAttemptId = persistedAttempt?.attemptId ?? null;
  const persistedFeedback =
    persistedAttemptId && parsed.verdict === "needs_changes"
      ? await findFeedbackForReviewAttempt({
          workspace,
          taskId,
          reviewBlockRef: options.ref,
          attemptId: persistedAttemptId
        })
      : null;
  const persistedCompletionReason =
    persistedAttemptId && parsed.verdict === "needs_changes" && persistedFeedback === null
      ? await reviewCompletionReasonForAttempt({
          workspace,
          taskId,
          reviewBlockRef: options.ref,
          attemptId: persistedAttemptId
        })
      : null;
  const persistedFeedbackIsActive = persistedFeedback
    ? isActiveFeedbackStatus(persistedFeedback.status)
    : false;
  const isSameWorkRevision = persistedAttempt?.reviewedWorkRevision === workRevision;
  const isCurrentFeedbackRetry =
    parsed.verdict === "needs_changes" &&
    persistedFeedback !== null &&
    state.currentFeedbackId === persistedFeedback.feedbackId &&
    state.currentReviewBlockRef === options.ref;
  const isPendingResolvedFeedbackRetry =
    parsed.verdict === "needs_changes" &&
    persistedFeedback !== null &&
    persistedFeedback.status === "resolved" &&
    state.blocks[options.ref]?.pendingFeedbackId === persistedFeedback.feedbackId;
  const shouldReusePersistedAttempt =
    persistedAttemptId !== null &&
    (isSameWorkRevision || isCurrentFeedbackRetry || isPendingResolvedFeedbackRetry);
  const attemptId =
    shouldReusePersistedAttempt && persistedAttemptId
      ? persistedAttemptId
      : await writeReviewAttempt({
          workspace,
          reviewBlockRef: options.ref,
          reviewResult: parsed,
          workRevision,
          resultHash,
          resultPath: options.resultPath
        });
  if (shouldReusePersistedAttempt && persistedAttemptId) {
    await recordReviewAttemptIndexes({
      workspace,
      reviewBlockRef: options.ref,
      reviewResult: parsed,
      workRevision: persistedAttempt?.reviewedWorkRevision ?? workRevision,
      attemptId,
      incrementCount: false
    });
    if (parsed.verdict === "needs_changes" && persistedFeedback) {
      await recordFeedbackEnvelopeIndexes({
        workspace,
        taskId,
        reviewBlockRef: options.ref,
        feedbackId: persistedFeedback.feedbackId,
        feedbackStatus: persistedFeedback.status,
        incrementCount: false
      });
      state.feedback[persistedFeedback.feedbackId] = {
        status: persistedFeedback.status,
        sourceReviewBlockRef: options.ref,
        latestSubmissionId: persistedFeedback.latestSubmissionId ?? null,
        content: persistedFeedback.content
      };
      state.blocks[options.ref] = {
        ...state.blocks[options.ref],
        status: "in_progress",
        latestReviewAttemptId: attemptId,
        activeFeedbackId: persistedFeedbackIsActive ? persistedFeedback.feedbackId : null,
        pendingFeedbackId:
          persistedFeedback.status === "resolved" ? persistedFeedback.feedbackId : null,
        completionReason: null
      };
      state.currentReviewBlockRef = options.ref;
      if (persistedFeedbackIsActive) {
        state.currentFeedbackId = persistedFeedback.feedbackId;
        state.currentRefs = withoutCurrentRef(state.currentRefs, options.ref);
      } else {
        state.currentRefs = state.currentRefs.includes(options.ref)
          ? state.currentRefs
          : [...state.currentRefs, options.ref];
      }
      state = refreshDerivedState(manifest, state);
      await writeState(workspace.stateFile, state);
      return {
        ref: options.ref,
        reviewAttemptId: attemptId,
        verdict: "needs_changes",
        feedbackId: persistedFeedback.feedbackId,
        status: "in_progress",
        feedbackCreated: true
      };
    }
    if (parsed.verdict === "needs_changes" && persistedCompletionReason === "max_cycles_reached") {
      state.blocks[options.ref] = {
        ...state.blocks[options.ref],
        status: "completed",
        latestReviewAttemptId: attemptId,
        activeFeedbackId: null,
        pendingFeedbackId: null,
        blockedReason: null,
        completionReason: "max_cycles_reached"
      };
      state.currentReviewBlockRef =
        state.currentReviewBlockRef === options.ref ? null : state.currentReviewBlockRef;
      state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
      state = refreshDerivedState(manifest, state);
      await writeState(workspace.stateFile, state);
      return {
        ref: options.ref,
        reviewAttemptId: attemptId,
        verdict: "needs_changes",
        status: "completed",
        completionReason: "max_cycles_reached",
        feedbackCreated: false,
        message: "No feedback envelope was created because max feedback cycles were reached."
      };
    }
  }
  const task = getTask(graph, taskId);
  const previousFeedbackCount = Object.values(state.feedback).filter(
    (feedback) => feedback.sourceReviewBlockRef === options.ref
  ).length;

  if (parsed.verdict === "passed") {
    state.blocks[options.ref] = {
      ...state.blocks[options.ref],
      status: "completed",
      latestReviewAttemptId: attemptId,
      activeFeedbackId: null,
      pendingFeedbackId: null,
      completionReason: "passed",
      passedWorkRevision: workRevision
    };
    await recordReviewCompletionReason({
      workspace,
      taskId,
      reviewBlockRef: options.ref,
      completionReason: "passed"
    });
    state.currentReviewBlockRef =
      state.currentReviewBlockRef === options.ref ? null : state.currentReviewBlockRef;
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return {
      ref: options.ref,
      reviewAttemptId: attemptId,
      verdict: "passed",
      status: "completed",
      completionReason: "passed",
      feedbackCreated: false
    };
  }

  if (maxFeedbackCyclesReached(previousFeedbackCount, block.review.maxFeedbackCycles)) {
    const warning: ValidationIssue = {
      code: "review_max_cycles_reached",
      message: `Review block '${options.ref}' reached max feedback cycles without passing.`,
      path: options.ref
    };
    state.blocks[options.ref] = {
      ...state.blocks[options.ref],
      status: "completed",
      latestReviewAttemptId: attemptId,
      activeFeedbackId: null,
      pendingFeedbackId: null,
      completionReason: "max_cycles_reached"
    };
    await recordReviewCompletionReason({
      workspace,
      taskId,
      reviewBlockRef: options.ref,
      completionReason: "max_cycles_reached",
      warning
    });
    state.currentReviewBlockRef =
      state.currentReviewBlockRef === options.ref ? null : state.currentReviewBlockRef;
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return {
      ref: options.ref,
      reviewAttemptId: attemptId,
      verdict: "needs_changes",
      status: "completed",
      completionReason: "max_cycles_reached",
      feedbackCreated: false,
      message: "No feedback envelope was created because max feedback cycles were reached."
    };
  }

  let feedbackContent: string;
  try {
    const hookOutput = await executeReviewHook({
      projectRoot: workspace.sourceRoot ?? workspace.rootPath,
      reviewBlock: block,
      reviewResult: parsed,
      task,
      reviewBlockRef: options.ref,
      feedbackCycleCount: previousFeedbackCount
    });
    feedbackContent = hookOutput.feedbackPrompt;
  } catch (error) {
    state.blocks[options.ref] = {
      ...state.blocks[options.ref],
      status: "blocked",
      latestReviewAttemptId: attemptId,
      activeFeedbackId: null,
      pendingFeedbackId: null,
      blockedReason: `Review hook failed: ${error instanceof Error ? error.message : String(error)}`
    };
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return {
      ref: options.ref,
      reviewAttemptId: attemptId,
      verdict: "needs_changes",
      status: "blocked"
    };
  }

  const feedbackId = await nextFeedbackId({ workspace, taskId, state });
  await writeFeedbackArtifact(workspace, taskId, {
    feedbackId,
    sourceReviewBlockRef: options.ref,
    content: feedbackContent,
    sourceReviewAttemptId: attemptId,
    status: "open",
    createdAt: new Date().toISOString()
  });
  await recordFeedbackEnvelopeIndexes({
    workspace,
    taskId,
    reviewBlockRef: options.ref,
    feedbackId,
    feedbackStatus: "open",
    incrementCount: true
  });
  state.feedback[feedbackId] = {
    status: "open",
    sourceReviewBlockRef: options.ref,
    latestSubmissionId: null,
    content: feedbackContent
  };
  state.blocks[options.ref] = {
    ...state.blocks[options.ref],
    status: "in_progress",
    latestReviewAttemptId: attemptId,
    activeFeedbackId: feedbackId,
    pendingFeedbackId: null
  };
  state.currentFeedbackId = feedbackId;
  state.currentReviewBlockRef = options.ref;
  state.currentRefs = withoutCurrentRef(state.currentRefs, options.ref);
  state = refreshDerivedState(manifest, state);
  await writeState(workspace.stateFile, state);
  return {
    ref: options.ref,
    reviewAttemptId: attemptId,
    verdict: "needs_changes",
    feedbackId,
    status: "in_progress",
    feedbackCreated: true
  };
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { writeState } from "../state.js";
import type {
  ExecutionGraphSession,
  FeedbackStatus,
  ManifestReviewBlock,
  ManifestTaskNode,
  PackageWorkspaceRef,
  ProjectWorkspace,
  ReviewHookOutput,
  ReviewResult,
  SubmitReviewResult,
  ValidationIssue
} from "../types.js";
import { writeFeedbackArtifact, type FeedbackArtifact } from "./feedbackArtifacts.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { incrementTaskIndexCount, listDirCount, nextId, updateTaskIndex } from "./resultIndex.js";
import { computeWorkRevision, getBlock, getTask } from "./selectors.js";

const reviewResultSchema = z
  .object({
    reviewBlockRef: z.string().min(1),
    taskId: z.string().min(1),
    verdict: z.enum(["passed", "needs_changes"]),
    content: z.string()
  })
  .strict();

const reviewHookOutputSchema = z
  .object({
    action: z.literal("use_feedback"),
    feedbackPrompt: z.string().min(1)
  })
  .strict();

function reviewResultHash(result: ReviewResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

async function executeReviewHook(options: {
  projectRoot: string;
  reviewBlock: ManifestReviewBlock;
  reviewResult: ReviewResult;
  task: ManifestTaskNode;
  reviewBlockRef: string;
  feedbackCycleCount: number;
}): Promise<ReviewHookOutput> {
  const hook = options.reviewBlock.review.hook;
  if (!hook) {
    return { action: "use_feedback", feedbackPrompt: options.reviewResult.content };
  }
  const input = JSON.stringify({
    reviewResult: options.reviewResult,
    task: { taskId: options.task.id, title: options.task.title },
    reviewBlockRef: options.reviewBlockRef,
    feedbackCycleCount: options.feedbackCycleCount
  });
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(hook.command, hook.args, { cwd: options.projectRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `hook exited with code ${code}`));
      }
    });
    child.stdin.end(input);
  });
  const parsed = reviewHookOutputSchema.safeParse(JSON.parse(output));
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
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
  await writeJsonFile(join(options.workspace.resultsDir, taskId, "reviews", blockId, "index.json"), {
    latestReviewAttemptId: options.attemptId,
    latestVerdict: options.reviewResult.verdict,
    reviewedWorkRevision: options.workRevision
  });
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
}): Promise<string> {
  const { taskId, blockId } = parseBlockRef(options.reviewBlockRef);
  const attemptRoot = join(options.workspace.resultsDir, taskId, "reviews", blockId, "attempts");
  const attemptId = nextId("REV", await listDirCount(attemptRoot));
  const attemptDir = join(attemptRoot, attemptId);
  await mkdir(attemptDir, { recursive: true });
  await writeJsonFile(join(attemptDir, "review-result.json"), options.reviewResult);
  await writeJsonFile(join(attemptDir, "metadata.json"), {
    reviewBlockRef: options.reviewBlockRef,
    attemptId,
    reviewedWorkRevision: options.workRevision,
    resultHash: options.resultHash,
    reviewedAt: new Date().toISOString()
  });
  await recordReviewAttemptIndexes({ ...options, attemptId, incrementCount: true });
  return attemptId;
}

async function reviewAttemptMatches(options: {
  attemptDir: string;
  reviewBlockRef: string;
  attemptId: string;
  resultHash: string;
}): Promise<boolean> {
  try {
    const metadata = await readJsonFile<Record<string, unknown>>(join(options.attemptDir, "metadata.json"));
    if (metadata.reviewBlockRef !== options.reviewBlockRef || metadata.attemptId !== options.attemptId) {
      return false;
    }
    return reviewResultHash(reviewResultSchema.parse(await readJsonFile<unknown>(join(options.attemptDir, "review-result.json")))) === options.resultHash;
  } catch {
    return false;
  }
}

async function findPersistedReviewAttempt(options: {
  workspace: ProjectWorkspace;
  reviewBlockRef: string;
  resultHash: string;
}): Promise<string | null> {
  const { taskId, blockId } = parseBlockRef(options.reviewBlockRef);
  const attemptRoot = join(options.workspace.resultsDir, taskId, "reviews", blockId, "attempts");
  let entries;
  try {
    entries = await readdir(attemptRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const attemptIds = entries
    .filter((entry) => entry.isDirectory() && /^REV-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const attemptId of attemptIds) {
    if (
      await reviewAttemptMatches({
        attemptDir: join(attemptRoot, attemptId),
        reviewBlockRef: options.reviewBlockRef,
        attemptId,
        resultHash: options.resultHash
      })
    ) {
      return attemptId;
    }
  }
  return null;
}

async function recordReviewCompletionReason(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  reviewBlockRef: string;
  completionReason: "passed" | "max_cycles_reached";
  warning?: ValidationIssue;
}): Promise<void> {
  await updateTaskIndex(options.workspace, options.taskId, (index) => ({
    ...index,
    reviewCompletionReasonByBlock: {
      ...(index.reviewCompletionReasonByBlock ?? {}),
      [options.reviewBlockRef]: options.completionReason
    },
    warnings: options.warning ? [...(index.warnings ?? []), options.warning] : index.warnings
  }));
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
    counts: options.incrementCount ? incrementTaskIndexCount(index, "feedbackEnvelopes") : index.counts
  }));
}

async function findFeedbackForReviewAttempt(options: {
  workspace: ProjectWorkspace;
  taskId: string;
  reviewBlockRef: string;
  attemptId: string;
}): Promise<FeedbackArtifact | null> {
  const feedbackRoot = join(options.workspace.resultsDir, options.taskId, "feedback");
  let entries;
  try {
    entries = await readdir(feedbackRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const feedbackIds = entries
    .filter((entry) => entry.isDirectory() && /^FE-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const feedbackId of feedbackIds) {
    try {
      const artifact = await readJsonFile<FeedbackArtifact>(join(feedbackRoot, feedbackId, "feedback.json"));
      if (
        artifact.feedbackId === feedbackId &&
        artifact.sourceReviewBlockRef === options.reviewBlockRef &&
        artifact.sourceReviewAttemptId === options.attemptId
      ) {
        return artifact;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function nextFeedbackId(options: { workspace: ProjectWorkspace; taskId: string; state: { feedback: Record<string, unknown> } }): Promise<string> {
  let count = Math.max(
    Object.keys(options.state.feedback).length,
    await listDirCount(join(options.workspace.resultsDir, options.taskId, "feedback"))
  );
  let feedbackId = nextId("FE", count);
  while (options.state.feedback[feedbackId]) {
    count += 1;
    feedbackId = nextId("FE", count);
  }
  return feedbackId;
}

export async function submitReviewResult(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  resultPath: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitReviewResult> {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  let { state } = context;
  const { taskId } = parseBlockRef(options.ref);
  const block = getBlock(graph, options.ref);
  if (block.type !== "review") {
    throw new Error("submit-review only accepts review blocks.");
  }
  const parsed = reviewResultSchema.parse(await readJsonFile<unknown>(options.resultPath));
  const resultHash = reviewResultHash(parsed);
  if (parsed.reviewBlockRef !== options.ref || parsed.taskId !== taskId) {
    throw new Error("review-result.json does not match the submitted review block ref.");
  }
  if (state.blocks[options.ref]?.status !== "in_progress") {
    throw new Error(`Review block '${options.ref}' must be in_progress before submit-review.`);
  }
  const workRevision = computeWorkRevision(graph, state, options.ref);
  const persistedAttemptId = await findPersistedReviewAttempt({ workspace, reviewBlockRef: options.ref, resultHash });
  const attemptId =
    persistedAttemptId ??
    (await writeReviewAttempt({
      workspace,
      reviewBlockRef: options.ref,
      reviewResult: parsed,
      workRevision,
      resultHash
    }));
  if (persistedAttemptId) {
    await recordReviewAttemptIndexes({ workspace, reviewBlockRef: options.ref, reviewResult: parsed, workRevision, attemptId, incrementCount: false });
    if (parsed.verdict === "needs_changes") {
      const persistedFeedback = await findFeedbackForReviewAttempt({ workspace, taskId, reviewBlockRef: options.ref, attemptId });
      if (persistedFeedback && (persistedFeedback.status === "open" || persistedFeedback.status === "in_progress")) {
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
          activeFeedbackId: persistedFeedback.feedbackId,
          completionReason: null
        };
        state.currentFeedbackId = persistedFeedback.feedbackId;
        state.currentReviewBlockRef = options.ref;
        state.currentRefs = [];
        state = refreshDerivedState(manifest, state);
        await writeState(workspace.stateFile, state);
        return {
          ref: options.ref,
          reviewAttemptId: attemptId,
          verdict: "needs_changes",
          feedbackId: persistedFeedback.feedbackId,
          status: "in_progress"
        };
      }
    }
  }
  const task = getTask(graph, taskId);
  const previousFeedbackCount = Object.values(state.feedback).filter((feedback) => feedback.sourceReviewBlockRef === options.ref).length;

  if (parsed.verdict === "passed") {
    state.blocks[options.ref] = {
      ...state.blocks[options.ref],
      status: "completed",
      latestReviewAttemptId: attemptId,
      activeFeedbackId: null,
      completionReason: "passed",
      passedWorkRevision: workRevision
    };
    await recordReviewCompletionReason({
      workspace,
      taskId,
      reviewBlockRef: options.ref,
      completionReason: "passed"
    });
    state.currentReviewBlockRef = state.currentReviewBlockRef === options.ref ? null : state.currentReviewBlockRef;
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { ref: options.ref, reviewAttemptId: attemptId, verdict: "passed", status: "completed" };
  }

  if (previousFeedbackCount >= block.review.maxFeedbackCycles) {
    const warning: ValidationIssue = {
      code: "review_max_cycles_reached",
      message: `Review block '${options.ref}' reached max feedback cycles without passing.`,
      path: options.ref
    };
    state.blocks[options.ref] = {
      ...state.blocks[options.ref],
      status: "completed",
      latestReviewAttemptId: attemptId,
      completionReason: "max_cycles_reached"
    };
    await recordReviewCompletionReason({
      workspace,
      taskId,
      reviewBlockRef: options.ref,
      completionReason: "max_cycles_reached",
      warning
    });
    state.currentReviewBlockRef = state.currentReviewBlockRef === options.ref ? null : state.currentReviewBlockRef;
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { ref: options.ref, reviewAttemptId: attemptId, verdict: "needs_changes", status: "completed" };
  }

  let feedbackContent: string;
  try {
    const hookOutput = await executeReviewHook({
      projectRoot: workspace.rootPath,
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
      blockedReason: `Review hook failed: ${error instanceof Error ? error.message : String(error)}`
    };
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { ref: options.ref, reviewAttemptId: attemptId, verdict: "needs_changes", status: "blocked" };
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
    activeFeedbackId: feedbackId
  };
  state.currentFeedbackId = feedbackId;
  state.currentReviewBlockRef = options.ref;
  state.currentRefs = [];
  state = refreshDerivedState(manifest, state);
  await writeState(workspace.stateFile, state);
  return { ref: options.ref, reviewAttemptId: attemptId, verdict: "needs_changes", feedbackId, status: "in_progress" };
}

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { writeState } from "../state.js";
import type {
  ExecutionGraphSession,
  ManifestReviewBlock,
  ManifestTaskNode,
  PackageWorkspaceRef,
  ProjectWorkspace,
  ReviewHookOutput,
  ReviewResult,
  SubmitReviewResult,
  ValidationIssue
} from "../types.js";
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

async function writeReviewAttempt(options: {
  workspace: ProjectWorkspace;
  reviewBlockRef: string;
  reviewResult: ReviewResult;
  workRevision: string;
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
    reviewedAt: new Date().toISOString()
  });
  await writeJsonFile(join(options.workspace.resultsDir, taskId, "reviews", blockId, "index.json"), {
    latestReviewAttemptId: attemptId,
    latestVerdict: options.reviewResult.verdict,
    reviewedWorkRevision: options.workRevision
  });
  await updateTaskIndex(options.workspace, taskId, (index) => ({
    ...index,
    latestReviewAttemptByBlock: {
      ...(index.latestReviewAttemptByBlock ?? {}),
      [options.reviewBlockRef]: attemptId
    },
    latestReviewVerdictByBlock: {
      ...(index.latestReviewVerdictByBlock ?? {}),
      [options.reviewBlockRef]: options.reviewResult.verdict
    },
    latestReviewedWorkRevisionByBlock: {
      ...(index.latestReviewedWorkRevisionByBlock ?? {}),
      [options.reviewBlockRef]: options.workRevision
    },
    counts: incrementTaskIndexCount(index, "reviewAttempts")
  }));
  return attemptId;
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
  if (parsed.reviewBlockRef !== options.ref || parsed.taskId !== taskId) {
    throw new Error("review-result.json does not match the submitted review block ref.");
  }
  if (state.blocks[options.ref]?.status !== "in_progress") {
    throw new Error(`Review block '${options.ref}' must be in_progress before submit-review.`);
  }
  const workRevision = computeWorkRevision(graph, state, options.ref);
  const attemptId = await writeReviewAttempt({
    workspace,
    reviewBlockRef: options.ref,
    reviewResult: parsed,
    workRevision
  });
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

  const feedbackId = nextId("FE", previousFeedbackCount);
  const feedbackDir = join(workspace.resultsDir, taskId, "feedback", feedbackId);
  await mkdir(feedbackDir, { recursive: true });
  await writeJsonFile(join(feedbackDir, "feedback.json"), {
    feedbackId,
    sourceReviewBlockRef: options.ref,
    content: feedbackContent,
    sourceReviewAttemptId: attemptId,
    status: "open",
    createdAt: new Date().toISOString()
  });
  await updateTaskIndex(workspace, taskId, (index) => ({
    ...index,
    latestFeedbackByReviewBlock: {
      ...(index.latestFeedbackByReviewBlock ?? {}),
      [options.ref]: feedbackId
    },
    feedbackStatusById: {
      ...(index.feedbackStatusById ?? {}),
      [feedbackId]: "open"
    },
    counts: incrementTaskIndexCount(index, "feedbackEnvelopes")
  }));
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

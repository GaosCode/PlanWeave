import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { resolvePlanweaveHome } from "../paths.js";
import { ensureStateForManifest, readState, writeState } from "../state.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { createExecutionGraphSession, drainGraphReadQueue } from "../graph/session.js";
import type {
  BlockStatus,
  ClaimScope,
  ClaimResult,
  CompiledExecutionGraph,
  ExecutionGraphSession,
  FeedbackEnvelopeState,
  ManifestBlock,
  ManifestReviewBlock,
  ManifestTaskNode,
  PlanPackageManifest,
  ProjectWorkspace,
  ReviewHookOutput,
  ReviewResult,
  RuntimeState,
  SubmitFeedbackResult,
  SubmitResult,
  SubmitReviewResult,
  TaskResultIndex,
  ValidationIssue
} from "../types.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";

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

type RuntimeContext = {
  workspace: ProjectWorkspace;
  manifest: PlanPackageManifest;
  graph: CompiledExecutionGraph;
  state: RuntimeState;
};

type RuntimeOptions = {
  projectRoot: string;
  session?: ExecutionGraphSession;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(path: string): Promise<string> {
  return (await exists(path)) ? readFile(path, "utf8") : "";
}

async function loadRuntime(options: RuntimeOptions): Promise<RuntimeContext> {
  const { workspace, manifest: packageManifest } = await loadPackage(options.projectRoot);
  const session = options.session ?? (await createExecutionGraphSession(options.projectRoot));
  await drainGraphReadQueue(session);
  const manifest = options.session ? session.fileSnapshot.manifest : packageManifest;
  const graph = session.graph;
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  await writeState(workspace.stateFile, state);
  return { workspace, manifest, graph, state };
}

function getTask(graph: CompiledExecutionGraph, taskId: string): ManifestTaskNode {
  const task = graph.tasksById.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  return task;
}

function getBlock(graph: CompiledExecutionGraph, ref: string): ManifestBlock {
  const block = graph.blocksByRef.get(ref);
  if (!block) {
    throw new Error(`Block '${ref}' does not exist.`);
  }
  return block;
}

function taskDependenciesSatisfied(graph: CompiledExecutionGraph, state: RuntimeState, taskId: string): boolean {
  return (graph.taskDependenciesByTask.get(taskId) ?? []).every((dependency) => state.tasks[dependency]?.status === "implemented");
}

function blockDependenciesCompleted(graph: CompiledExecutionGraph, state: RuntimeState, ref: string): boolean {
  return (graph.blockDependenciesByRef.get(ref) ?? []).every((dependency) => state.blocks[dependency]?.status === "completed");
}

function activeOpenFeedback(state: RuntimeState): Array<[string, FeedbackEnvelopeState]> {
  return Object.entries(state.feedback).filter(([, feedback]) => feedback.status === "open" || feedback.status === "in_progress");
}

function claimResultForBlock(ref: string, graph: CompiledExecutionGraph, reason: "claimed" | "current" | "feedback_resolved"): ClaimResult {
  const { taskId, blockId } = parseBlockRef(ref);
  const block = getBlock(graph, ref);
  return {
    kind: "block",
    ref,
    taskId,
    blockId,
    blockType: block.type,
    reason
  };
}

function normalizeClaimScope(scope?: ClaimScope): ClaimScope {
  return scope ?? { kind: "project" };
}

function validateClaimScope(scope: ClaimScope, graph: CompiledExecutionGraph): ClaimResult | null {
  if (scope.kind === "task" && !graph.tasksById.has(scope.taskId)) {
    return { kind: "blocked", reason: `Task '${scope.taskId}' does not exist.` };
  }
  if (scope.kind === "block" && !graph.blocksByRef.has(scope.blockRef)) {
    return { kind: "blocked", reason: `Block '${scope.blockRef}' does not exist.` };
  }
  return null;
}

function blockInScope(ref: string, graph: CompiledExecutionGraph, scope: ClaimScope): boolean {
  if (scope.kind === "project") {
    return true;
  }
  if (scope.kind === "block") {
    return ref === scope.blockRef;
  }
  return graph.blockTaskByRef.get(ref) === scope.taskId;
}

function feedbackInScope(feedback: FeedbackEnvelopeState, graph: CompiledExecutionGraph, scope: ClaimScope): boolean {
  return blockInScope(feedback.sourceReviewBlockRef, graph, scope);
}

function requiredImplementationRefs(graph: CompiledExecutionGraph, taskId: string): string[] {
  return (graph.blocksByTask.get(taskId) ?? []).filter((ref) => {
    const block = graph.blocksByRef.get(ref);
    return block?.type === "implementation" || block?.type === "check";
  });
}

function requiredReviewRefs(graph: CompiledExecutionGraph, taskId: string): string[] {
  return (graph.blocksByTask.get(taskId) ?? []).filter((ref) => {
    const block = graph.blocksByRef.get(ref);
    return block?.type === "review" && block.review.required;
  });
}

function nextId(prefix: string, count: number): string {
  return `${prefix}-${String(count + 1).padStart(3, "0")}`;
}

async function listDirCount(path: string): Promise<number> {
  try {
    const entries = await (await import("node:fs/promises")).readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

function taskIndexPath(workspace: ProjectWorkspace, taskId: string): string {
  return join(workspace.resultsDir, taskId, "index.json");
}

async function readTaskIndex(workspace: ProjectWorkspace, taskId: string): Promise<TaskResultIndex> {
  const path = taskIndexPath(workspace, taskId);
  return (await exists(path)) ? readJsonFile<TaskResultIndex>(path) : {};
}

async function writeTaskIndex(workspace: ProjectWorkspace, taskId: string, index: TaskResultIndex): Promise<void> {
  await writeJsonFile(taskIndexPath(workspace, taskId), index);
}

async function updateTaskIndex(
  workspace: ProjectWorkspace,
  taskId: string,
  update: (index: TaskResultIndex) => TaskResultIndex
): Promise<TaskResultIndex> {
  const next = update(await readTaskIndex(workspace, taskId));
  await writeTaskIndex(workspace, taskId, next);
  return next;
}

function incrementTaskIndexCount(index: TaskResultIndex, field: keyof NonNullable<TaskResultIndex["counts"]>): TaskResultIndex["counts"] {
  return {
    ...(index.counts ?? {}),
    [field]: ((index.counts ?? {})[field] ?? 0) + 1
  };
}

function computeWorkRevision(graph: CompiledExecutionGraph, state: RuntimeState, reviewBlockRef: string): string {
  const taskId = graph.blockTaskByRef.get(reviewBlockRef);
  if (!taskId) {
    throw new Error(`Review block '${reviewBlockRef}' does not belong to a task.`);
  }
  const material = {
    runs: requiredImplementationRefs(graph, taskId).map((ref) => [ref, state.blocks[ref]?.lastRunId ?? null]),
    feedback: Object.entries(state.feedback)
      .filter(([, feedback]) => feedback.sourceReviewBlockRef === reviewBlockRef)
      .map(([feedbackId, feedback]) => [feedbackId, feedback.latestSubmissionId])
  };
  return `rev-${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12)}`;
}

function canClaimReviewBlock(graph: CompiledExecutionGraph, state: RuntimeState, ref: string): boolean {
  const taskId = graph.blockTaskByRef.get(ref);
  if (!taskId) {
    return false;
  }
  if (activeOpenFeedback(state).some(([, feedback]) => graph.blockTaskByRef.get(feedback.sourceReviewBlockRef) === taskId)) {
    return false;
  }
  if (!requiredImplementationRefs(graph, taskId).every((blockRef) => state.blocks[blockRef]?.status === "completed")) {
    return false;
  }
  const workRevision = computeWorkRevision(graph, state, ref);
  return state.blocks[ref]?.passedWorkRevision !== workRevision;
}

function refreshDerivedState(manifest: PlanPackageManifest, state: RuntimeState): RuntimeState {
  return ensureStateForManifest(manifest, state);
}

function markClaimed(state: RuntimeState, ref: string, graph: CompiledExecutionGraph): void {
  state.blocks[ref] = { ...state.blocks[ref], status: "in_progress" };
  state.currentRefs = [ref];
  const block = getBlock(graph, ref);
  if (block.type === "review") {
    state.currentReviewBlockRef = ref;
  }
}

function openFeedbackForReview(state: RuntimeState, reviewBlockRef: string): [string, FeedbackEnvelopeState] | null {
  return (
    Object.entries(state.feedback).find(
      ([, feedback]) =>
        feedback.sourceReviewBlockRef === reviewBlockRef && (feedback.status === "open" || feedback.status === "in_progress")
    ) ?? null
  );
}

export async function claimNext(options: {
  projectRoot: string;
  parallel?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  const context = await loadRuntime(options);
  let { state } = context;
  const { graph, manifest, workspace } = context;
  const scope = normalizeClaimScope(options.scope);
  const invalidScope = validateClaimScope(scope, graph);
  if (invalidScope) {
    return invalidScope;
  }
  const openFeedback = activeOpenFeedback(state);
  if (openFeedback.length > 1) {
    return { kind: "blocked", reason: "Multiple open feedback envelopes exist; resolve or dismiss one before continuing." };
  }
  if (openFeedback.length === 1) {
    const [feedbackId, feedback] = openFeedback[0];
    if (!feedbackInScope(feedback, graph, scope)) {
      return { kind: "none", reason: "no_claimable_blocks_in_scope" };
    }
    feedback.status = "in_progress";
    state.currentFeedbackId = feedbackId;
    state.currentReviewBlockRef = feedback.sourceReviewBlockRef;
    state.currentRefs = [];
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { kind: "feedback", content: feedback.content };
  }

  const inProgressReview = graph.blockRefsInManifestOrder.find((ref) => {
    const block = graph.blocksByRef.get(ref);
    return block?.type === "review" && state.blocks[ref]?.status === "in_progress";
  });
  if (inProgressReview && state.currentFeedbackId) {
    const currentFeedback = state.feedback[state.currentFeedbackId];
    if (currentFeedback?.status === "resolved") {
      if (!blockInScope(inProgressReview, graph, scope)) {
        return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." };
      }
      state.currentRefs = [inProgressReview];
      state.currentFeedbackId = null;
      state.currentReviewBlockRef = inProgressReview;
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(inProgressReview, graph, "feedback_resolved");
    }
  }
  if (inProgressReview) {
    if (!blockInScope(inProgressReview, graph, scope)) {
      return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." };
    }
    state.currentRefs = [inProgressReview];
    state.currentReviewBlockRef = inProgressReview;
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return claimResultForBlock(inProgressReview, graph, "current");
  }

  const current = graph.blockRefsInManifestOrder.find((ref) => {
    const block = graph.blocksByRef.get(ref);
    return state.blocks[ref]?.status === "in_progress" && block?.type !== "review";
  });
  if (current) {
    if (!blockInScope(current, graph, scope)) {
      return { kind: "blocked", ref: current, reason: "A block is in progress outside the selected Auto Run scope." };
    }
    return claimResultForBlock(current, graph, "current");
  }

  if (options.parallel) {
    if (!manifest.execution.parallel.enabled) {
      return { kind: "blocked", reason: "Parallel execution is disabled by the Plan Package." };
    }
    const selected: string[] = [];
    for (const ref of graph.blockRefsInManifestOrder) {
      if (!blockInScope(ref, graph, scope)) {
        continue;
      }
      const taskId = graph.blockTaskByRef.get(ref);
      const block = graph.blocksByRef.get(ref);
      if (!taskId || !block || block.type === "review") {
        continue;
      }
      if (selected.length >= manifest.execution.parallel.maxConcurrent) {
        break;
      }
      if (!taskDependenciesSatisfied(graph, state, taskId) || !blockDependenciesCompleted(graph, state, ref)) {
        continue;
      }
      if (!graph.parallelSafeByBlockRef.get(ref) || state.blocks[ref]?.status !== "ready") {
        continue;
      }
      const locks = new Set(graph.locksByBlockRef.get(ref) ?? []);
      const conflicts = selected.some((selectedRef) => {
        const selectedTaskId = graph.blockTaskByRef.get(selectedRef);
        if (selectedTaskId && (graph.taskReachable(taskId, selectedTaskId) || graph.taskReachable(selectedTaskId, taskId))) {
          return true;
        }
        return (graph.locksByBlockRef.get(selectedRef) ?? []).some((lock) => locks.has(lock));
      });
      if (!conflicts) {
        selected.push(ref);
      }
    }
    for (const ref of selected) {
      state.blocks[ref] = { ...state.blocks[ref], status: "in_progress" };
    }
    state.currentRefs = selected;
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return selected.length > 0 ? { kind: "batch", refs: selected } : { kind: "none", reason: "no_parallel_blocks" };
  }

  for (const ref of graph.blockRefsInManifestOrder) {
    if (!blockInScope(ref, graph, scope)) {
      continue;
    }
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    if (!taskId || !block || block.type === "review") {
      continue;
    }
    if (taskDependenciesSatisfied(graph, state, taskId) && blockDependenciesCompleted(graph, state, ref) && state.blocks[ref]?.status === "ready") {
      markClaimed(state, ref, graph);
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(ref, graph, "claimed");
    }
  }

  for (const ref of graph.blockRefsInManifestOrder) {
    if (!blockInScope(ref, graph, scope)) {
      continue;
    }
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    if (!taskId || block?.type !== "review") {
      continue;
    }
    if (taskDependenciesSatisfied(graph, state, taskId) && state.blocks[ref]?.status === "ready" && canClaimReviewBlock(graph, state, ref)) {
      markClaimed(state, ref, graph);
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(ref, graph, "claimed");
    }
  }

  const blockedRef = graph.blockRefsInManifestOrder.find((ref) => blockInScope(ref, graph, scope) && state.blocks[ref]?.status === "blocked");
  if (blockedRef) {
    return {
      kind: "blocked",
      ref: blockedRef,
      reason: state.blocks[blockedRef]?.blockedReason ?? `Block '${blockedRef}' is blocked.`
    };
  }

  await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
  return { kind: "none", reason: "no_claimable_blocks" };
}

function renderNodeList(title: string, lines: string[]): string {
  return [`## ${title}`, "", lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- None."].join("\n");
}

async function latestReportSnippet(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim().slice(0, 400) || "(empty)";
  } catch {
    return "(unavailable)";
  }
}

async function renderLatestImplementationReports(context: RuntimeContext, taskId: string): Promise<string[]> {
  const lines: string[] = [];
  for (const ref of requiredImplementationRefs(context.graph, taskId)) {
    const lastRunId = context.state.blocks[ref]?.lastRunId;
    if (!lastRunId) {
      continue;
    }
    const { blockId } = parseBlockRef(ref);
    const reportPath = join(context.workspace.resultsDir, taskId, "blocks", blockId, "runs", lastRunId, "report.md");
    lines.push(`${ref} ${lastRunId}: ${await latestReportSnippet(reportPath)}`);
  }
  return lines;
}

async function renderFocusedReviewLines(context: RuntimeContext, reviewBlockRef: string): Promise<string[]> {
  const feedbackEntry = Object.entries(context.state.feedback)
    .filter(([, feedback]) => feedback.sourceReviewBlockRef === reviewBlockRef && feedback.status === "resolved")
    .at(-1);
  if (!feedbackEntry) {
    return [];
  }
  const [feedbackId, feedback] = feedbackEntry;
  const taskId = context.graph.blockTaskByRef.get(reviewBlockRef);
  if (!taskId || !feedback.latestSubmissionId) {
    return [];
  }
  const submissionPath = join(
    context.workspace.resultsDir,
    taskId,
    "feedback",
    feedbackId,
    "submissions",
    feedback.latestSubmissionId,
    "report.md"
  );
  return [
    `Previous review feedback: ${feedback.content}`,
    `Feedback handling report (${feedback.latestSubmissionId}): ${await latestReportSnippet(submissionPath)}`,
    "Focus: verify that the previous feedback items were resolved without regressing accepted work."
  ];
}

export async function renderPrompt(options: { projectRoot: string; ref: string; session?: ExecutionGraphSession }): Promise<string> {
  const context = await loadRuntime(options);
  const { workspace, graph, manifest, state } = context;
  const { taskId } = parseBlockRef(options.ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, options.ref);
  const globalPrompt = await readOptionalFile(join(resolvePlanweaveHome(), "config", "global-prompt.md"));
  const projectPrompt = await readOptionalFile(workspace.projectPromptFile);
  const taskPrompt = await readFile(await resolvePackagePath(workspace.packageDir, task.prompt, { requireExisting: true }), "utf8");
  const blockPrompt = await readFile(await resolvePackagePath(workspace.packageDir, block.prompt, { requireExisting: true }), "utf8");
  const dependencyLines = (graph.blockDependenciesByRef.get(options.ref) ?? []).map(
    (dependency) => `${dependency}: ${state.blocks[dependency]?.status ?? "planned"}`
  );
  const latestImplementationReports = await renderLatestImplementationReports(context, taskId);
  const focusedReviewLines = block.type === "review" ? await renderFocusedReviewLines(context, options.ref) : [];
  const reviewSchema =
    block.type === "review"
      ? [
          "## Required Review Result JSON",
          "",
          "```json",
          JSON.stringify(
            {
              reviewBlockRef: options.ref,
              taskId,
              verdict: "passed | needs_changes",
              content: "review summary and requested changes"
            },
            null,
            2
          ),
          "```"
        ].join("\n")
      : "";
  const submitInstruction =
    block.type === "review"
      ? `Submit review with \`planweave submit-review ${options.ref} --result review-result.json\`.`
      : `Submit result with \`planweave submit-result ${options.ref} --report implementation.md\`.`;
  const related = graph.relatedContext(taskId);
  return [
    `# ${task.id}#${block.id}: ${block.title}`,
    "## PlanWeave Global Prompt",
    globalPrompt.trim() || "- No global prompt.",
    "## Project Prompt",
    projectPrompt.trim() || "- No project prompt.",
    "## Task Node Prompt",
    taskPrompt.trim(),
    "## Block Prompt",
    blockPrompt.trim(),
    renderNodeList("Task Acceptance", task.acceptance),
    renderNodeList(
      "Execution Context",
      [
        `Task status: ${state.tasks[taskId]?.status ?? "planned"}`,
        `Block status: ${state.blocks[options.ref]?.status ?? "planned"}`,
        `Completion policy: ${manifest.review.completionPolicy}`
      ]
    ),
    renderNodeList("Dependency / Block Status", dependencyLines),
    renderNodeList(
      "Graph Context",
      [
        ...related.goals.map((node) => `${node.id} goal: ${node.title}`),
        ...related.requirements.map((node) => `${node.id} requirement: ${node.title}`),
        ...related.constraints.map((node) => `${node.id} constraint: ${node.title}`),
        ...related.components.map((node) => `${node.id} component: ${node.title}`)
      ]
    ),
    renderNodeList("Latest Implementation / Feedback Summary", latestImplementationReports),
    focusedReviewLines.length > 0 ? renderNodeList("Focused Re-review Context", focusedReviewLines) : "",
    reviewSchema,
    "## Submission Instructions",
    submitInstruction
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n")
    .concat("\n");
}

export async function submitBlockResult(options: {
  projectRoot: string;
  ref: string;
  reportPath: string;
  runId?: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitResult> {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  let { state } = context;
  const { taskId, blockId } = parseBlockRef(options.ref);
  const block = getBlock(graph, options.ref);
  if (block.type === "review") {
    throw new Error("submit-result only accepts implementation/check blocks.");
  }
  if (state.blocks[options.ref]?.status !== "in_progress") {
    throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
  }
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const runId = options.runId ?? nextId("RUN", await listDirCount(runRoot));
  const runDir = join(runRoot, runId);
  const reportDestination = join(runDir, "report.md");
  const metadataPath = join(runDir, "metadata.json");
  await mkdir(runDir, { recursive: true });
  if (options.reportPath !== reportDestination) {
    await copyFile(options.reportPath, reportDestination);
  }
  const previousMetadata = (await exists(metadataPath)) ? await readJsonFile<Record<string, unknown>>(metadataPath) : {};
  await writeJsonFile(metadataPath, {
    ...previousMetadata,
    ref: options.ref,
    taskId,
    blockId,
    runId,
    submittedAt: new Date().toISOString(),
    sourceReportPath: options.reportPath
  });
  await updateTaskIndex(workspace, taskId, (index) => ({
    ...index,
    latestRunByBlock: {
      ...(index.latestRunByBlock ?? {}),
      [options.ref]: runId
    },
    counts: incrementTaskIndexCount(index, "runs")
  }));
  state.blocks[options.ref] = { ...state.blocks[options.ref], status: "completed", lastRunId: runId };
  state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
  state = refreshDerivedState(manifest, state);
  await writeState(workspace.stateFile, state);
  return { ref: options.ref, runId, status: "completed" };
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
  projectRoot: string;
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
      projectRoot: options.projectRoot,
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

export async function submitFeedback(options: {
  projectRoot: string;
  reportPath: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitFeedbackResult> {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  let { state } = context;
  const feedbackId = state.currentFeedbackId;
  if (!feedbackId || !state.feedback[feedbackId]) {
    throw new Error("submit-feedback requires an active feedback event.");
  }
  const feedback = state.feedback[feedbackId];
  const taskId = graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
  if (!taskId) {
    throw new Error(`Feedback '${feedbackId}' points to an unknown review block.`);
  }
  const submissionRoot = join(workspace.resultsDir, taskId, "feedback", feedbackId, "submissions");
  const submissionId = nextId("FS", await listDirCount(submissionRoot));
  const submissionDir = join(submissionRoot, submissionId);
  await mkdir(submissionDir, { recursive: true });
  await copyFile(options.reportPath, join(submissionDir, "report.md"));
  await writeJsonFile(join(submissionDir, "metadata.json"), {
    feedbackId,
    submissionId,
    sourceReviewBlockRef: feedback.sourceReviewBlockRef,
    submittedAt: new Date().toISOString()
  });
  await updateTaskIndex(workspace, taskId, (index) => ({
    ...index,
    latestFeedbackSubmissionByFeedback: {
      ...(index.latestFeedbackSubmissionByFeedback ?? {}),
      [feedbackId]: submissionId
    },
    feedbackStatusById: {
      ...(index.feedbackStatusById ?? {}),
      [feedbackId]: "resolved"
    },
    counts: incrementTaskIndexCount(index, "feedbackSubmissions")
  }));
  state.feedback[feedbackId] = {
    ...feedback,
    status: "resolved",
    latestSubmissionId: submissionId
  };
  state.blocks[feedback.sourceReviewBlockRef] = {
    ...state.blocks[feedback.sourceReviewBlockRef],
    status: "in_progress",
    activeFeedbackId: null
  };
  state.currentFeedbackId = feedbackId;
  state.currentReviewBlockRef = feedback.sourceReviewBlockRef;
  state.currentRefs = [feedback.sourceReviewBlockRef];
  state = refreshDerivedState(manifest, state);
  await writeState(workspace.stateFile, state);
  return {
    status: "accepted",
    nextCommand: "planweave claim-next",
    message: "Feedback submitted. Run `planweave claim-next` to continue the review loop.",
    feedbackId,
    submissionId
  };
}

export async function markBlockBlocked(options: { projectRoot: string; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  const block = getBlock(graph, options.ref);
  if (!options.reason.trim()) {
    throw new Error("mark-blocked requires a non-empty reason.");
  }
  context.state.blocks[options.ref] = {
    ...context.state.blocks[options.ref],
    status: "blocked",
    blockedReason: options.reason.trim()
  };
  if (block.type === "review" && openFeedbackForReview(context.state, options.ref)) {
    throw new Error("Cannot mark a review block blocked while it has open feedback.");
  }
  context.state.currentRefs = context.state.currentRefs.filter((ref) => ref !== options.ref);
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: "blocked" as BlockStatus, reason: options.reason.trim() };
}

export async function markBlockDiverged(options: { projectRoot: string; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  getBlock(graph, options.ref);
  if (!options.reason.trim()) {
    throw new Error("mark-diverged requires a non-empty reason.");
  }
  context.state.blocks[options.ref] = {
    ...context.state.blocks[options.ref],
    status: "diverged",
    divergenceReason: options.reason.trim()
  };
  context.state.currentRefs = context.state.currentRefs.filter((ref) => ref !== options.ref);
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: "diverged" as BlockStatus, reason: options.reason.trim() };
}

export async function unblockBlock(options: { projectRoot: string; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  getBlock(graph, options.ref);
  if (!options.reason.trim()) {
    throw new Error("unblock requires a non-empty reason.");
  }
  const current = context.state.blocks[options.ref];
  if (current?.status !== "blocked") {
    throw new Error(`Block '${options.ref}' is not blocked.`);
  }
  context.state.blocks[options.ref] = {
    ...current,
    status: blockDependenciesCompleted(graph, context.state, options.ref) ? "ready" : "planned",
    blockedReason: null
  };
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: context.state.blocks[options.ref].status, reason: options.reason.trim() };
}

export async function resolveBlockDivergence(options: { projectRoot: string; ref: string; reason: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  getBlock(graph, options.ref);
  const current = context.state.blocks[options.ref];
  if (current?.status !== "diverged") {
    throw new Error(`Block '${options.ref}' is not diverged.`);
  }
  if (!options.reason.trim()) {
    throw new Error("resolve-divergence requires a non-empty reason.");
  }
  context.state.blocks[options.ref] = {
    ...current,
    status: blockDependenciesCompleted(graph, context.state, options.ref) ? "ready" : "planned",
    divergenceReason: null
  };
  await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
  return { ref: options.ref, status: context.state.blocks[options.ref].status, reason: options.reason.trim() };
}

export async function getExecutionStatus(options: { projectRoot: string; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, graph, state } = context;
  const taskCounts = Object.fromEntries(["planned", "ready", "in_progress", "implemented"].map((status) => [status, 0])) as Record<
    "planned" | "ready" | "in_progress" | "implemented",
    number
  >;
  const blockCounts = Object.fromEntries(
    ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"].map((status) => [status, 0])
  ) as Record<BlockStatus, number>;
  const feedbackCounts = Object.fromEntries(["open", "in_progress", "resolved", "dismissed"].map((status) => [status, 0])) as Record<
    "open" | "in_progress" | "resolved" | "dismissed",
    number
  >;
  for (const task of Object.values(state.tasks)) {
    taskCounts[task.status] += 1;
  }
  for (const block of Object.values(state.blocks)) {
    blockCounts[block.status] += 1;
  }
  for (const feedback of Object.values(state.feedback)) {
    feedbackCounts[feedback.status] += 1;
  }
  const nextClaimable = graph.blockRefsInManifestOrder.filter((ref) => {
    const taskId = graph.blockTaskByRef.get(ref);
    return (
      !!taskId &&
      state.blocks[ref]?.status === "ready" &&
      taskDependenciesSatisfied(graph, state, taskId) &&
      blockDependenciesCompleted(graph, state, ref)
    );
  });
  const warnings: ValidationIssue[] = graph.blockRefsInManifestOrder
    .filter((ref) => state.blocks[ref]?.completionReason === "max_cycles_reached")
    .map((ref) => ({
      code: "review_max_cycles_reached",
      message: `Review block '${ref}' reached max feedback cycles without passing.`,
      path: ref
    }));
  return {
    projectId: workspace.id,
    projectRoot: workspace.rootPath,
    taskTotal: graph.taskNodesInManifestOrder.length,
    blockTotal: graph.blockRefsInManifestOrder.length,
    tasks: graph.taskNodesInManifestOrder.map((taskId) => ({
      taskId,
      status: state.tasks[taskId]?.status ?? "planned",
      openFeedbackCount: state.tasks[taskId]?.openFeedbackCount ?? 0
    })),
    blocks: graph.blockRefsInManifestOrder.map((ref) => {
      const { taskId, blockId } = parseBlockRef(ref);
      const block = getBlock(graph, ref);
      const blockState = state.blocks[ref];
      return {
        ref,
        taskId,
        blockId,
        type: block.type,
        status: blockState?.status ?? "planned",
        reason: blockState?.blockedReason ?? blockState?.divergenceReason ?? null,
        completionReason: blockState?.completionReason ?? null,
        lastRunId: blockState?.lastRunId ?? null,
        latestReviewAttemptId: blockState?.latestReviewAttemptId ?? null,
        activeFeedbackId: blockState?.activeFeedbackId ?? null
      };
    }),
    currentRefs: state.currentRefs,
    currentFeedbackId: state.currentFeedbackId,
    currentReviewBlockRef: state.currentReviewBlockRef,
    openFeedback: Object.entries(state.feedback)
      .filter(([, feedback]) => feedback.status === "open" || feedback.status === "in_progress")
      .map(([feedbackId, feedback]) => ({
        feedbackId,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        status: feedback.status
      })),
    nextClaimable,
    warnings,
    counts: {
      tasks: taskCounts,
      blocks: blockCounts,
      feedback: feedbackCounts
    },
    orphanState: [],
    orphanResults: []
  };
}

import { join } from "node:path";
import { createExecutorAdapter } from "../autoRun/executors.js";
import { optionalReadFile, optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { compileTaskGraph, parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { readState } from "../state.js";
import type {
  AutoRunExplanation,
  AutoRunExplanationPhase,
  AutoRunLatestRunSummary,
  AutoRunStatus,
  AutoRunStepResult,
  ClaimScope,
  ClaimResult,
  ExecutionGraphSession,
  ExecutorAdapter,
  ExecutorProfile,
  FeedbackStatus,
  PlanPackageManifest,
  RuntimeState,
  ValidationIssue
} from "../types.js";
import type { PackageWorkspaceRef } from "../types.js";
import { claimNext, getExecutionStatus, markBlockBlocked, renderPrompt, submitBlockResult, submitFeedback, submitReviewResult } from "./index.js";
import { effectiveFeedbackExecutor } from "./selectors.js";

type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
type SubmittedOrManualStep = Extract<AutoRunStepResult, { kind: "submitted" | "manual" }>;
type BlockedStep = { kind: "blocked"; claim: ClaimResult };
type AutoRunExplanationFacts = Omit<AutoRunExplanation, "nextAction"> & { nextClaimableRefs?: string[] };

async function exists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

async function readSummary(path: string): Promise<string> {
  return ((await optionalReadFile(path, "utf8")) ?? "").trim().slice(0, 400);
}

async function fileUpdatedAt(path: string): Promise<string | null> {
  const stat = await optionalStat(path);
  return stat ? stat.mtime.toISOString() : null;
}

function latestTimestamp(...values: Array<string | null>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed) && parsed > latestMs) {
      latest = value;
      latestMs = parsed;
    }
  }
  return latest;
}

async function runFileUpdateTimes(runDir: string, metadataPath: string): Promise<{
  stdoutUpdatedAt: string | null;
  stderrUpdatedAt: string | null;
  metadataUpdatedAt: string | null;
  heartbeatPath: string | null;
  heartbeatUpdatedAt: string | null;
  heartbeatStatus: string | null;
  heartbeatPid: number | null;
  lastHeartbeatAt: string | null;
  lastActivityAt: string | null;
  lastOutputAt: string | null;
}> {
  const stdoutUpdatedAt = await fileUpdatedAt(join(runDir, "stdout.md"));
  const stderrUpdatedAt = await fileUpdatedAt(join(runDir, "stderr.log"));
  const metadataUpdatedAt = await fileUpdatedAt(metadataPath);
  const heartbeatPath = join(runDir, "heartbeat.json");
  const heartbeatUpdatedAt = await fileUpdatedAt(heartbeatPath);
  const heartbeat: Record<string, unknown> = heartbeatUpdatedAt ? await readJsonFile<Record<string, unknown>>(heartbeatPath).catch(() => ({})) : {};
  const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
  return {
    stdoutUpdatedAt,
    stderrUpdatedAt,
    metadataUpdatedAt,
    heartbeatPath: heartbeatUpdatedAt ? heartbeatPath : null,
    heartbeatUpdatedAt,
    heartbeatStatus: typeof heartbeat.status === "string" ? heartbeat.status : null,
    heartbeatPid: typeof heartbeat.pid === "number" ? heartbeat.pid : null,
    lastHeartbeatAt,
    lastActivityAt: latestTimestamp(stdoutUpdatedAt, stderrUpdatedAt, lastHeartbeatAt, heartbeatUpdatedAt),
    lastOutputAt: latestTimestamp(stdoutUpdatedAt, stderrUpdatedAt)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutorAdapter(value: unknown): value is ExecutorProfile["adapter"] {
  return value === "manual" || value === "codex-exec" || value === "opencode-exec" || value === "claude-code-exec" || value === "pi-exec" || value === "local-review";
}

export function createAutoRunExplanation(facts: AutoRunExplanationFacts): AutoRunExplanation {
  const { nextClaimableRefs = [], ...explanationFacts } = facts;
  const nextClaimableRef = nextClaimableRefs[0] ?? null;
  const latestRecordRef = explanationFacts.latestRecordId?.split("::")[0] ?? null;
  const actionableRef = explanationFacts.currentRef ?? nextClaimableRef ?? (latestRecordRef?.includes("#") ? latestRecordRef : null);
  const base = {
    command: null as string | null,
    ref: actionableRef,
    targetPath: null
  };
  if (nextClaimableRefs.length > 0 && explanationFacts.phase === "idle") {
    const refs = nextClaimableRefs.join(", ");
    return {
      ...explanationFacts,
      nextAction: {
        ...base,
        kind: "start",
        message: `Continue Auto Run; claimable work is ready: ${refs}.`
      }
    };
  }
  if (explanationFacts.phase === "running" || explanationFacts.phase === "pausing") {
    return {
      ...explanationFacts,
      nextAction: {
        ...base,
        kind: "wait",
        message: explanationFacts.phase === "pausing" ? "Wait for the in-flight step to finish pausing." : "Wait for the current Auto Run step to finish."
      }
    };
  }
  if (explanationFacts.phase === "paused") {
    return {
      ...explanationFacts,
      nextAction: {
        ...base,
        kind: "resume",
        message: "Resume Auto Run or inspect the latest record before continuing."
      }
    };
  }
  if (explanationFacts.phase === "manual") {
    return {
      ...explanationFacts,
      nextAction: {
        ...base,
        kind: "submit_manual_result",
        command: explanationFacts.latestOutputSummary?.startsWith("planweave ") ? explanationFacts.latestOutputSummary : null,
        message: "Complete the manual step, then submit the result."
      }
    };
  }
  if ((explanationFacts.phase === "blocked" || explanationFacts.phase === "failed") && explanationFacts.latestRecordPath) {
    return {
      ...explanationFacts,
      nextAction: {
        ...base,
        kind: "inspect_record",
        message: "Inspect the latest run record, then resolve the blocker before retrying.",
        targetPath: explanationFacts.latestRecordPath
      }
    };
  }
  if (explanationFacts.phase === "blocked" || explanationFacts.phase === "failed") {
    return {
      ...explanationFacts,
      nextAction: {
        ...base,
        kind: "resolve_error",
        message: "Resolve the reported Auto Run error before retrying."
      }
    };
  }
  if (explanationFacts.phase === "completed") {
    return {
      ...explanationFacts,
      nextAction: {
        ...base,
        kind: "review_status",
        message: "Review the final status and latest run record."
      }
    };
  }
  return {
    ...explanationFacts,
    nextAction: {
      ...base,
      kind: "start",
      message: explanationFacts.phase === "stopped" ? "Start a new Auto Run when ready." : "Start Auto Run when ready."
    }
  };
}

function latestRecordId(run: AutoRunLatestRunSummary | null): string | null {
  return run ? `${run.ref}::${run.runId}` : null;
}

function latestOutputSummary(run: AutoRunLatestRunSummary | null): string | null {
  if (!run) {
    return null;
  }
  return run.failureReason || run.stderrSummary || run.stdoutSummary || null;
}

function runOrderValue(run: AutoRunLatestRunSummary): number {
  const timestamp = Date.parse(run.finishedAt ?? run.startedAt ?? "");
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }
  const runNumber = /^RUN-(\d+)$/.exec(run.runId)?.[1];
  return runNumber ? Number.parseInt(runNumber, 10) : 0;
}

function compareLatestRunsNewestFirst(left: AutoRunLatestRunSummary, right: AutoRunLatestRunSummary): number {
  const byTime = runOrderValue(right) - runOrderValue(left);
  if (byTime !== 0) {
    return byTime;
  }
  return right.runId.localeCompare(left.runId, undefined, { numeric: true });
}

function selectExplanationRun(latestRuns: AutoRunLatestRunSummary[], currentRefs: string[], currentFeedbackId: string | null): AutoRunLatestRunSummary | null {
  const currentRunningBlockRun = latestRuns.find((run) => currentRefs.includes(run.ref) && !run.finishedAt);
  return (
    (currentFeedbackId ? latestRuns.find((run) => run.kind === "feedback" && run.feedbackId === currentFeedbackId) : null) ??
    currentRunningBlockRun ??
    [...latestRuns].sort(compareLatestRunsNewestFirst)[0] ??
    null
  );
}

function runMatchesActiveWork(options: {
  latestRun: AutoRunLatestRunSummary | null;
  currentRefs: string[];
  feedbackId: string | null;
}): boolean {
  if (!options.latestRun) {
    return false;
  }
  if (options.latestRun.kind === "feedback") {
    return Boolean(options.feedbackId && options.latestRun.feedbackId === options.feedbackId);
  }
  return options.currentRefs.includes(options.latestRun.ref);
}

function autoRunStatusPhase(options: {
  currentRefs: string[];
  feedbackId: string | null;
  reviewBlockRef: string | null;
  nextClaimable: string[];
  latestRun: AutoRunLatestRunSummary | null;
  warnings: ValidationIssue[];
}): AutoRunExplanationPhase {
  if (options.warnings.length > 0) {
    return "blocked";
  }
  if (options.currentRefs.length > 0 || options.feedbackId || options.reviewBlockRef) {
    if (runMatchesActiveWork({ latestRun: options.latestRun, currentRefs: options.currentRefs, feedbackId: options.feedbackId })) {
      if (options.latestRun?.adapter === "manual") {
        return "manual";
      }
      return "running";
    }
    return "idle";
  }
  if (options.latestRun?.failureReason || options.latestRun?.status === "blocked" || options.latestRun?.status === "diverged") {
    return "blocked";
  }
  if (options.nextClaimable.length > 0) {
    return "idle";
  }
  if (options.latestRun) {
    return "completed";
  }
  return "idle";
}

function currentEffectiveExecutor(options: {
  executionStatus: Awaited<ReturnType<typeof getExecutionStatus>>;
  graph: ReturnType<typeof compileTaskGraph>;
  latestRun: AutoRunLatestRunSummary | null;
  manifest: PlanPackageManifest;
  state: RuntimeState;
}): string | null {
  const activeRunExecutor = (ref: string, kind: AutoRunLatestRunSummary["kind"]): string | null => {
    if (!options.latestRun || options.latestRun.kind !== kind || options.latestRun.ref !== ref || options.latestRun.finishedAt) {
      return null;
    }
    return options.latestRun.executor;
  };
  if (options.executionStatus.currentFeedbackId) {
    const runningExecutor = activeRunExecutor(options.executionStatus.currentFeedbackId, "feedback");
    if (runningExecutor) {
      return runningExecutor;
    }
    const feedback = options.state.feedback[options.executionStatus.currentFeedbackId];
    return feedback
      ? effectiveFeedbackExecutor(options.graph, feedback.sourceReviewBlockRef, options.manifest.execution.defaultExecutor)
      : options.latestRun?.executor ?? null;
  }
  const currentRef = options.executionStatus.currentRefs[0] ?? options.executionStatus.currentReviewBlockRef;
  if (currentRef) {
    const runningExecutor = activeRunExecutor(currentRef, "block");
    if (runningExecutor) {
      return runningExecutor;
    }
    return options.executionStatus.blocks.find((block) => block.ref === currentRef)?.effectiveExecutor ?? options.latestRun?.executor ?? null;
  }
  const nextRef = options.executionStatus.nextClaimable[0];
  if (nextRef) {
    return options.executionStatus.blocks.find((block) => block.ref === nextRef)?.effectiveExecutor ?? options.latestRun?.executor ?? null;
  }
  return options.latestRun?.executor ?? null;
}

async function latestRunId(runRoot: string): Promise<string | null> {
  const entries = await optionalReaddir(runRoot, { withFileTypes: true });
  return (
    entries
      ?.filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .at(-1) ?? null
  );
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function feedbackStatusForRun(options: {
  feedbackId: string | null;
  state: RuntimeState;
  hasReport: boolean;
  currentFeedbackId: string | null;
}): FeedbackStatus {
  if (options.feedbackId && options.state.feedback[options.feedbackId]?.status) {
    return options.state.feedback[options.feedbackId].status;
  }
  if (options.currentFeedbackId && options.state.feedback[options.currentFeedbackId]?.status) {
    return options.state.feedback[options.currentFeedbackId].status;
  }
  return options.hasReport ? "resolved" : "in_progress";
}

function latestFeedbackId(state: RuntimeState): string | null {
  return Object.keys(state.feedback).sort().at(-1) ?? null;
}

async function latestFeedbackRunSummary(options: {
  resultsDir: string;
  state: RuntimeState;
  currentFeedbackId: string | null;
}): Promise<AutoRunLatestRunSummary | null> {
  const runRoot = join(options.resultsDir, "feedback-runs");
  const runId = await latestRunId(runRoot);
  if (!runId) {
    return null;
  }
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  const metadata = (await exists(metadataPath)) ? await readJsonFile<Record<string, unknown>>(metadataPath) : {};
  const fallbackFeedbackId = options.currentFeedbackId ?? latestFeedbackId(options.state);
  const feedbackId = stringField(metadata.feedbackId) ?? fallbackFeedbackId;
  const feedback = feedbackId ? options.state.feedback[feedbackId] : undefined;
  const sourceReviewBlockRef = stringField(metadata.sourceReviewBlockRef) ?? feedback?.sourceReviewBlockRef ?? null;
  const taskId = stringField(metadata.taskId) ?? (sourceReviewBlockRef ? parseBlockRef(sourceReviewBlockRef).taskId : null);
  const reportPath = join(runDir, "report.md");
  const promptPath = join(runDir, "prompt.md");
  const feedbackPromptPath = join(runDir, "feedback.md");
  const hasPrompt = await exists(promptPath);
  const hasManualPrompt = await exists(feedbackPromptPath);
  const hasReport = await exists(reportPath);
  const exitCode = typeof metadata.exitCode === "number" ? metadata.exitCode : null;
  const stderrSummary = await readSummary(join(runDir, "stderr.log"));
  const metadataFailureReason = stringField(metadata.failureReason);
  const updateTimes = await runFileUpdateTimes(runDir, metadataPath);
  return {
    kind: "feedback",
    ref: feedbackId ?? "feedback",
    feedbackId,
    sourceReviewBlockRef,
    taskId,
    runId,
    executor: stringField(metadata.executor) ?? (hasManualPrompt ? "manual" : null),
    adapter: isExecutorAdapter(metadata.adapter) ? metadata.adapter : hasManualPrompt ? "manual" : null,
    status: feedbackStatusForRun({ feedbackId, state: options.state, hasReport, currentFeedbackId: options.currentFeedbackId }),
    startedAt: stringField(metadata.startedAt),
    finishedAt: stringField(metadata.finishedAt),
    stdoutSummary: stringField(metadata.nextCommand) ?? (await readSummary(join(runDir, "stdout.md"))),
    stderrSummary,
    failureReason: metadataFailureReason ?? (exitCode !== null && exitCode !== 0 ? stderrSummary || null : null),
    promptPath: hasPrompt ? promptPath : feedbackPromptPath,
    reportPath: hasReport ? reportPath : null,
    metadataPath,
    ...updateTimes,
    tmuxSessionName: stringField(metadata.tmuxSessionName),
    tmuxAttachCommand: stringField(metadata.tmuxAttachCommand),
    tmuxReadOnlyAttachCommand: stringField(metadata.tmuxReadOnlyAttachCommand)
  };
}

async function claimForBatchRef(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
}): Promise<BlockClaim> {
  const manifest: PlanPackageManifest = options.session?.fileSnapshot.manifest ?? (await loadPackage(options.projectRoot)).manifest;
  const { taskId, blockId } = parseBlockRef(options.ref);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (task?.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  const block = task.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  return {
    kind: "block",
    ref: options.ref,
    taskId,
    blockId,
    blockType: block.type,
    effectiveExecutor: block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? "default",
    reason: "claimed"
  };
}

async function executeBlockClaim(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executor: ExecutorAdapter;
  session?: ExecutionGraphSession;
}): Promise<SubmittedOrManualStep | BlockedStep> {
  const prompt = await renderPrompt({
    projectRoot: options.projectRoot,
    ref: options.claim.ref,
    session: options.session,
    includeSubmissionInstructions: false
  });
  let adapterResult: Awaited<ReturnType<ExecutorAdapter["runBlock"]>>;
  try {
    adapterResult = await options.executor.runBlock({ claim: options.claim, prompt });
  } catch (error) {
    const reason = `Executor failed for ${options.claim.ref}: ${errorMessage(error)}`;
    const blocked = await markBlockBlocked({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      reason,
      session: options.session
    });
    return {
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: blocked.ref,
        reason: blocked.reason
      }
    };
  }
  if (adapterResult.kind === "manual") {
    return { kind: "manual", claim: options.claim, adapterResult };
  }
  if (options.claim.blockType === "review") {
    if (adapterResult.kind !== "review") {
      throw new Error("Executor adapter must return a review result for review block claims.");
    }
    const submitResult = await submitReviewResult({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      resultPath: adapterResult.resultPath,
      session: options.session
    });
    return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
  }
  if (adapterResult.kind !== "block") {
    throw new Error("Executor adapter must return a block report for implementation block claims.");
  }
  const submitResult = await submitBlockResult({
    projectRoot: options.projectRoot,
    ref: options.claim.ref,
    reportPath: adapterResult.reportPath,
    runId: adapterResult.runId,
    session: options.session
  });
  return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
}

export async function runAutoRunStep(options: {
  projectRoot: PackageWorkspaceRef;
  executor?: ExecutorAdapter;
  executorName?: string;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
  parallel?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
}): Promise<AutoRunStepResult> {
  let claim = await claimNext({ projectRoot: options.projectRoot, parallel: options.parallel, scope: options.scope, session: options.session });
  if (claim.kind === "none" && claim.reason === "no_parallel_blocks") {
    claim = await claimNext({ projectRoot: options.projectRoot, scope: options.scope, session: options.session });
  }
  if (claim.kind === "none") {
    return { kind: "idle", claim };
  }
  if (claim.kind === "blocked") {
    return { kind: "blocked", claim };
  }
  if (claim.kind === "batch") {
    const executor =
      options.executor ??
      createExecutorAdapter({
        projectRoot: options.projectRoot,
        executorName: options.executorName,
        runtime: { tmuxEnabled: options.tmuxEnabled, tmuxOwnerRunId: options.tmuxOwnerRunId }
      });
    const steps: SubmittedOrManualStep[] = [];
    for (const ref of claim.refs) {
      const blockClaim = await claimForBatchRef({ projectRoot: options.projectRoot, ref, session: options.session });
      const step = await executeBlockClaim({
        projectRoot: options.projectRoot,
        claim: blockClaim,
        executor,
        session: options.session
      });
      if (step.kind === "blocked") {
        return step;
      }
      steps.push(step);
    }
    return { kind: "batch_submitted", claim, steps };
  }

  const executor =
    options.executor ??
    createExecutorAdapter({
      projectRoot: options.projectRoot,
      executorName: options.executorName,
      runtime: { tmuxEnabled: options.tmuxEnabled, tmuxOwnerRunId: options.tmuxOwnerRunId }
    });
  if (claim.kind === "feedback") {
    let adapterResult: Awaited<ReturnType<ExecutorAdapter["runFeedback"]>>;
    try {
      adapterResult = await executor.runFeedback({ claim });
    } catch (error) {
      return {
        kind: "blocked",
        claim: {
          kind: "blocked",
          reason: `Executor failed for feedback: ${errorMessage(error)}`
        }
      };
    }
    if (adapterResult.kind === "manual") {
      return { kind: "manual", claim, adapterResult };
    }
    if (adapterResult.kind !== "feedback") {
      throw new Error("Executor adapter must return a feedback report for feedback claims.");
    }
    const submitResult = await submitFeedback({
      projectRoot: options.projectRoot,
      reportPath: adapterResult.reportPath,
      session: options.session
    });
    return { kind: "submitted", claim, adapterResult, submitResult };
  }

  return executeBlockClaim({ projectRoot: options.projectRoot, claim, executor, session: options.session });
}

export async function getAutoRunStatus(options: { projectRoot: PackageWorkspaceRef; session?: ExecutionGraphSession }): Promise<AutoRunStatus> {
  const { manifest, workspace } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  const executionStatus = await getExecutionStatus({ projectRoot: options.projectRoot, session: options.session });
  const state = await readState(workspace.stateFile);
  const latestRuns: AutoRunLatestRunSummary[] = [];

  for (const block of executionStatus.blocks) {
    const runRoot = join(workspace.resultsDir, block.taskId, "blocks", block.blockId, "runs");
    const runId = await latestRunId(runRoot);
    if (!runId) {
      continue;
    }
    const runDir = join(runRoot, runId);
    const metadataPath = join(runDir, "metadata.json");
    const metadata = (await exists(metadataPath)) ? await readJsonFile<Record<string, unknown>>(metadataPath) : {};
    const exitCode = typeof metadata.exitCode === "number" ? metadata.exitCode : null;
    const stderrSummary = await readSummary(join(runDir, "stderr.log"));
    const metadataFailureReason = stringField(metadata.failureReason);
    const updateTimes = await runFileUpdateTimes(runDir, metadataPath);
    latestRuns.push({
      kind: "block",
      ref: block.ref,
      taskId: block.taskId,
      blockId: block.blockId,
      runId,
      executor: typeof metadata.executor === "string" ? metadata.executor : null,
      adapter: isExecutorAdapter(metadata.adapter) ? metadata.adapter : null,
      status: block.status,
      startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : null,
      finishedAt: typeof metadata.finishedAt === "string" ? metadata.finishedAt : null,
      stdoutSummary: await readSummary(join(runDir, "stdout.md")),
      stderrSummary,
      failureReason: metadataFailureReason ?? (exitCode !== null && exitCode !== 0 ? ((stderrSummary || block.reason) ?? null) : block.reason ?? null),
      promptPath: join(runDir, "prompt.md"),
      reportPath: (await exists(join(runDir, "report.md"))) ? join(runDir, "report.md") : null,
      metadataPath,
      ...updateTimes,
      tmuxSessionName: stringField(metadata.tmuxSessionName),
      tmuxAttachCommand: stringField(metadata.tmuxAttachCommand),
      tmuxReadOnlyAttachCommand: stringField(metadata.tmuxReadOnlyAttachCommand)
    });
  }
  const feedbackRun = await latestFeedbackRunSummary({
    resultsDir: workspace.resultsDir,
    state,
    currentFeedbackId: executionStatus.currentFeedbackId
  });
  if (feedbackRun) {
    latestRuns.push(feedbackRun);
  }
  const latestRun = selectExplanationRun(latestRuns, executionStatus.currentRefs, executionStatus.currentFeedbackId);
  const currentRef = executionStatus.currentRefs[0] ?? executionStatus.currentFeedbackId ?? executionStatus.currentReviewBlockRef ?? null;
  const currentExecutor = currentEffectiveExecutor({ executionStatus, graph, latestRun, manifest, state });
  const error = executionStatus.warnings[0]?.message ?? latestRun?.failureReason ?? null;
  const phase = autoRunStatusPhase({
    currentRefs: executionStatus.currentRefs,
    feedbackId: executionStatus.currentFeedbackId,
    reviewBlockRef: executionStatus.currentReviewBlockRef,
    nextClaimable: executionStatus.nextClaimable,
    latestRun,
    warnings: executionStatus.warnings
  });

  return {
    current: {
      refs: executionStatus.currentRefs,
      feedbackId: executionStatus.currentFeedbackId,
      reviewBlockRef: executionStatus.currentReviewBlockRef
    },
    latestRuns,
    explanation: createAutoRunExplanation({
      phase,
      currentRef,
      currentExecutor,
      latestRecordId: latestRecordId(latestRun),
      latestRecordPath: latestRun?.metadataPath ?? null,
      latestOutputSummary: latestOutputSummary(latestRun),
      error,
      nextClaimableRefs: executionStatus.nextClaimable
    }),
    warnings: executionStatus.warnings
  };
}

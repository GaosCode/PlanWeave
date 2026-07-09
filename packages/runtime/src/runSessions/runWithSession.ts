import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { getAutoRunStatus, runAutoRunStep } from "../taskManager/autoRun.js";
import type { AutoRunStatus, AutoRunStepResult, ClaimScope, ReviewVerdict } from "../types.js";
import { appendRunSessionEvent, createRunSession, updateRunSession } from "./repository.js";
import { resetRuntimeState } from "./reset.js";
import type {
  RunSessionAutoRunSummary,
  RunSessionPhase,
  RunSessionScope,
  RunWithSessionOptions,
  RunWithSessionResult,
  UpdateRunSessionPatch
} from "./types.js";

const defaultStepLimit = 10_000;

type RunStopReason = NonNullable<RunSessionAutoRunSummary["stopReason"]>;

type StepRecordLink = {
  recordId: string;
  recordPath: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionScope(scope: ClaimScope | undefined): RunSessionScope {
  return scope ?? { kind: "project" };
}

function claimRefs(step: AutoRunStepResult): string[] {
  if (step.kind === "submitted" || step.kind === "manual") {
    if (step.claim.kind === "block") {
      return [step.claim.ref];
    }
    if (step.claim.kind === "feedback") {
      return [step.claim.sourceReviewBlockRef];
    }
    return [];
  }
  if (step.kind === "blocked") {
    return step.claim.kind === "blocked" && step.claim.ref ? [step.claim.ref] : [];
  }
  if (step.kind === "batch_submitted") {
    return [...step.claim.refs];
  }
  if (step.kind === "batch") {
    return step.claim.kind === "batch" ? [...step.claim.refs] : [];
  }
  return [];
}

function reviewAttemptId(step: AutoRunStepResult): string | null {
  if (step.kind !== "submitted") {
    return null;
  }
  return "reviewAttemptId" in step.submitResult ? step.submitResult.reviewAttemptId : null;
}

function reviewVerdict(step: AutoRunStepResult): ReviewVerdict | null {
  if (step.kind !== "submitted") {
    return null;
  }
  return "verdict" in step.submitResult ? step.submitResult.verdict : null;
}

function feedbackId(step: AutoRunStepResult): string | null {
  if (step.kind !== "submitted" && step.kind !== "manual") {
    return null;
  }
  if (step.claim.kind === "feedback") {
    return step.claim.feedbackId;
  }
  return step.kind === "submitted" && "feedbackId" in step.submitResult
    ? (step.submitResult.feedbackId ?? null)
    : null;
}

async function sessionWorkspace(projectRoot: RunWithSessionOptions["projectRoot"]) {
  return (await loadPackage(projectRoot)).workspace;
}

async function blockRunRecordPath(
  projectRoot: RunWithSessionOptions["projectRoot"],
  ref: string,
  runId: string
): Promise<string> {
  const workspace = await sessionWorkspace(projectRoot);
  const { taskId, blockId } = parseBlockRef(ref);
  return join(workspace.resultsDir, taskId, "blocks", blockId, "runs", runId, "metadata.json");
}

async function feedbackRunRecordPath(
  projectRoot: RunWithSessionOptions["projectRoot"],
  runId: string
): Promise<string> {
  const workspace = await sessionWorkspace(projectRoot);
  return join(workspace.resultsDir, "feedback-runs", runId, "metadata.json");
}

async function stepRecordLink(
  projectRoot: RunWithSessionOptions["projectRoot"],
  step: Extract<AutoRunStepResult, { kind: "submitted" | "manual" }>
): Promise<StepRecordLink | null> {
  if (!step.adapterResult.runId) {
    return null;
  }
  if (step.claim.kind === "block") {
    return {
      recordId: `${step.claim.ref}::${step.adapterResult.runId}`,
      recordPath: await blockRunRecordPath(projectRoot, step.claim.ref, step.adapterResult.runId)
    };
  }
  if (step.claim.kind === "feedback") {
    return {
      recordId: `${step.claim.feedbackId}::${step.adapterResult.runId}`,
      recordPath: await feedbackRunRecordPath(projectRoot, step.adapterResult.runId)
    };
  }
  return null;
}

async function stepRecordLinks(
  projectRoot: RunWithSessionOptions["projectRoot"],
  step: AutoRunStepResult
): Promise<StepRecordLink[]> {
  if (step.kind === "batch_submitted") {
    const nested = await Promise.all(step.steps.map((item) => stepRecordLinks(projectRoot, item)));
    return nested.flat();
  }
  if (step.kind !== "submitted" && step.kind !== "manual") {
    return [];
  }
  const link = await stepRecordLink(projectRoot, step);
  return link ? [link] : [];
}

function activeStatusRecord(status: AutoRunStatus): StepRecordLink | null {
  if (status.current.feedbackId) {
    const feedbackRun = status.latestRuns.find(
      (run): run is Extract<AutoRunStatus["latestRuns"][number], { kind: "feedback" }> =>
        run.kind === "feedback" && run.feedbackId === status.current.feedbackId && !run.finishedAt
    );
    return feedbackRun?.feedbackId
      ? {
          recordId: `${feedbackRun.feedbackId}::${feedbackRun.runId}`,
          recordPath: feedbackRun.metadataPath
        }
      : null;
  }
  const activeRefs = new Set(status.current.refs);
  const blockRun = status.latestRuns.find(
    (run): run is Extract<AutoRunStatus["latestRuns"][number], { kind: "block" }> =>
      run.kind === "block" && activeRefs.has(run.ref) && !run.finishedAt
  );
  return blockRun
    ? { recordId: `${blockRun.ref}::${blockRun.runId}`, recordPath: blockRun.metadataPath }
    : null;
}

function currentClaimRefs(status: AutoRunStatus): string[] {
  if (status.current.refs.length > 0) {
    return [...status.current.refs];
  }
  return status.current.reviewBlockRef ? [status.current.reviewBlockRef] : [];
}

function executorName(step: AutoRunStepResult): string | null {
  if (step.kind === "submitted" || step.kind === "manual") {
    return step.adapterResult.executor ?? null;
  }
  if (step.kind === "batch_submitted") {
    return step.steps.find((item) => item.adapterResult.executor)?.adapterResult.executor ?? null;
  }
  return null;
}

function outputSummary(step: AutoRunStepResult): string | null {
  if (step.kind === "submitted") {
    return "stdout" in step.adapterResult
      ? step.adapterResult.stdout?.trim().slice(0, 300) || null
      : null;
  }
  if (step.kind === "manual") {
    return step.adapterResult.nextCommand;
  }
  if (step.kind === "batch_submitted") {
    const manualCount = step.steps.filter((item) => item.kind === "manual").length;
    if (manualCount === step.steps.length) {
      return `Manual prompts generated for ${step.steps.length} block(s).`;
    }
    if (manualCount > 0) {
      return `Batch completed with manual prompts for ${manualCount} of ${step.steps.length} block(s).`;
    }
    return `${step.steps.length} block(s) submitted.`;
  }
  if (step.kind === "blocked") {
    return step.claim.kind === "blocked" ? step.claim.reason : "Auto Run blocked.";
  }
  if (step.kind === "idle") {
    return step.claim.kind === "none"
      ? (step.claim.reason ?? "No claimable work.")
      : "No claimable work.";
  }
  return null;
}

function finalPhaseForStep(step: AutoRunStepResult, status: AutoRunStatus): RunSessionPhase | null {
  if (step.kind === "idle") {
    return status.warnings.length > 0 ? "blocked" : "completed";
  }
  if (
    step.kind === "manual" ||
    (step.kind === "batch_submitted" && step.steps.some((item) => item.kind === "manual"))
  ) {
    return "manual";
  }
  if (step.kind === "blocked" || step.kind === "batch") {
    return "blocked";
  }
  return null;
}

function autoRunSummary(options: {
  stepCount: number;
  parallel: boolean;
  executorName: string | undefined;
  stopReason: RunStopReason | null;
}): RunSessionAutoRunSummary {
  return {
    desktopRunId: null,
    stepCount: options.stepCount,
    parallel: options.parallel,
    executorOverride: options.executorName ?? null,
    stopReason: options.stopReason
  };
}

function finalEventType(
  phase: RunSessionPhase
): "session_completed" | "session_manual" | "session_blocked" | "session_stopped" {
  if (phase === "completed") {
    return "session_completed";
  }
  if (phase === "manual") {
    return "session_manual";
  }
  if (phase === "blocked") {
    return "session_blocked";
  }
  return "session_stopped";
}

function terminalReasonForPhase(
  phase: RunSessionPhase,
  stopReason: RunStopReason | null
): RunWithSessionResult["terminalReason"] {
  if (stopReason === "step_limit") {
    return "step_limit_reached";
  }
  if (phase === "manual") {
    return "manual";
  }
  if (phase === "blocked") {
    return "blocked";
  }
  return "completed";
}

async function updateSessionAutoRunSummary(options: {
  projectRoot: RunWithSessionOptions["projectRoot"];
  sessionId: string;
  phase: RunSessionPhase;
  stepCount: number;
  parallel: boolean;
  executorName: string | undefined;
  stopReason: RunStopReason | null;
  status: AutoRunStatus;
  latestRecord: StepRecordLink | null;
  finishedAt?: string;
  error?: string | null;
}) {
  const summary = autoRunSummary(options);
  const patch: UpdateRunSessionPatch = {
    phase: options.phase,
    autoRun: summary,
    latestRecordId: options.latestRecord?.recordId ?? null,
    latestRecordPath: options.latestRecord?.recordPath ?? null,
    error: options.error ?? options.status.explanation.error
  };
  if (options.finishedAt !== undefined) {
    patch.finishedAt = options.finishedAt;
  }
  return updateRunSession(options.projectRoot, options.sessionId, patch);
}

export async function runWithSession(
  options: RunWithSessionOptions
): Promise<RunWithSessionResult> {
  const session = await createRunSession({
    projectRoot: options.projectRoot,
    kind: "run",
    scope: sessionScope(options.scope)
  });
  const steps: AutoRunStepResult[] = [];
  const parallel = options.parallel === true;
  const stepLimit = options.stepLimit ?? defaultStepLimit;
  let status = await getAutoRunStatus({ projectRoot: options.projectRoot });
  let latestSessionRecord: StepRecordLink | null = null;

  try {
    if (options.reset === true) {
      await resetRuntimeState({
        projectRoot: options.projectRoot,
        force: options.force,
        reason: options.reason,
        session
      });
      status = await getAutoRunStatus({ projectRoot: options.projectRoot });
    }

    await updateSessionAutoRunSummary({
      projectRoot: options.projectRoot,
      sessionId: session.sessionId,
      phase: "running",
      stepCount: 0,
      parallel,
      executorName: options.executorName,
      stopReason: null,
      status,
      latestRecord: latestSessionRecord
    });

    let finalPhase: RunSessionPhase | null = null;
    let stopReason: RunStopReason | null = null;
    if (stepLimit <= 0) {
      finalPhase = "completed";
      stopReason = "no_steps";
    }
    while (finalPhase === null && steps.length < stepLimit) {
      let stepSettled = false;
      let stepStartError: unknown;
      let startedRecordId: string | null = null;
      let wakeStepStartTracker: (() => void) | null = null;
      const waitForNextStepStartPoll = (): Promise<void> =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            wakeStepStartTracker = null;
            resolve();
          }, 250);
          wakeStepStartTracker = () => {
            clearTimeout(timer);
            wakeStepStartTracker = null;
            resolve();
          };
        });
      const stepPromise = runAutoRunStep({
        projectRoot: options.projectRoot,
        executorName: options.executorName,
        tmuxEnabled: options.tmuxEnabled,
        parallel,
        scope: options.scope
      });
      const stepStartTracker = (async () => {
        while (!stepSettled) {
          await waitForNextStepStartPoll();
          if (stepSettled) {
            return;
          }
          const pendingStatus = await getAutoRunStatus({ projectRoot: options.projectRoot });
          const activeRecord = activeStatusRecord(pendingStatus);
          if (!activeRecord || activeRecord.recordId === startedRecordId) {
            continue;
          }
          startedRecordId = activeRecord.recordId;
          latestSessionRecord = activeRecord;
          await appendRunSessionEvent(options.projectRoot, session.sessionId, "step_start", {
            phase: "running",
            claimRefs: currentClaimRefs(pendingStatus),
            recordId: activeRecord.recordId,
            recordPath: activeRecord.recordPath,
            recordLinks: [activeRecord],
            executorName: pendingStatus.explanation.currentExecutor,
            latestOutputSummary: pendingStatus.explanation.latestOutputSummary
          });
          await updateSessionAutoRunSummary({
            projectRoot: options.projectRoot,
            sessionId: session.sessionId,
            phase: "running",
            stepCount: steps.length,
            parallel,
            executorName: options.executorName,
            stopReason: null,
            status: pendingStatus,
            latestRecord: latestSessionRecord
          });
        }
      })().catch((error: unknown) => {
        stepStartError = error;
      });
      const step = await stepPromise.finally(() => {
        stepSettled = true;
        wakeStepStartTracker?.();
      });
      await stepStartTracker;
      if (stepStartError) {
        throw stepStartError;
      }
      steps.push(step);
      status = await getAutoRunStatus({ projectRoot: options.projectRoot });
      const recordLinks = await stepRecordLinks(options.projectRoot, step);
      const latestStepRecord = recordLinks.at(-1) ?? null;
      if (latestStepRecord) {
        latestSessionRecord = latestStepRecord;
      }
      await appendRunSessionEvent(options.projectRoot, session.sessionId, "step_finish", {
        phase: "running",
        stepKind: step.kind,
        claimRefs: claimRefs(step),
        recordId: latestStepRecord?.recordId ?? null,
        recordPath: latestStepRecord?.recordPath ?? null,
        recordLinks,
        reviewAttemptId: reviewAttemptId(step),
        reviewVerdict: reviewVerdict(step),
        feedbackId: feedbackId(step),
        executorName: executorName(step),
        outputSummary: outputSummary(step)
      });
      await updateSessionAutoRunSummary({
        projectRoot: options.projectRoot,
        sessionId: session.sessionId,
        phase: "running",
        stepCount: steps.length,
        parallel,
        executorName: options.executorName,
        stopReason: null,
        status,
        latestRecord: latestSessionRecord
      });
      finalPhase = finalPhaseForStep(step, status);
      if (finalPhase === null && options.once === true) {
        finalPhase = "completed";
        stopReason = "once";
      }
    }

    if (finalPhase === null) {
      finalPhase = "completed";
      stopReason = "step_limit";
    }
    const finishedAt = new Date().toISOString();
    const finalSession = await updateSessionAutoRunSummary({
      projectRoot: options.projectRoot,
      sessionId: session.sessionId,
      phase: finalPhase,
      stepCount: steps.length,
      parallel,
      executorName: options.executorName,
      stopReason,
      status,
      latestRecord: latestSessionRecord,
      finishedAt
    });
    await appendRunSessionEvent(
      options.projectRoot,
      session.sessionId,
      finalEventType(finalPhase),
      {
        phase: finalPhase,
        finishedAt,
        stepCount: steps.length,
        stopReason
      }
    );
    return {
      session: finalSession,
      steps,
      status,
      ok: finalPhase === "completed" || finalPhase === "manual",
      terminalReason: terminalReasonForPhase(finalPhase, stopReason)
    };
  } catch (error) {
    status = await getAutoRunStatus({ projectRoot: options.projectRoot });
    const message = errorMessage(error);
    const finishedAt = new Date().toISOString();
    const failedSession = await updateSessionAutoRunSummary({
      projectRoot: options.projectRoot,
      sessionId: session.sessionId,
      phase: "failed",
      stepCount: steps.length,
      parallel,
      executorName: options.executorName,
      stopReason: null,
      status,
      latestRecord: latestSessionRecord,
      finishedAt,
      error: message
    });
    await appendRunSessionEvent(options.projectRoot, session.sessionId, "session_failed", {
      phase: "failed",
      finishedAt,
      stepCount: steps.length,
      error: message
    });
    return { session: failedSession, steps, status, ok: false, terminalReason: "failed" };
  }
}

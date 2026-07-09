import { createAutoRunExplanation } from "../taskManager/autoRun.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getReviewAttempts, getRunRecord } from "./recordsApi.js";
import { cloneAutoRunState } from "./runStateStore.js";
import {
  readLatestPersistedAutoRunState,
  readPersistedAutoRunEventLog,
  readPersistedAutoRunStateWithDiagnostics
} from "./runStateRepository.js";
import type {
  DesktopAutoRunLogEvent,
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunState
} from "./types.js";

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordRefFromRecordId(recordId: string | null): string | null {
  const ref = recordId?.split("::")[0] ?? null;
  return ref?.includes("#") ? ref : null;
}

function completedRefsFromEvents(
  events: DesktopAutoRunLogEvent[],
  diagnostics: ValidationIssue[]
): string[] {
  const refs = new Set<string>();
  for (const event of events) {
    if (event.type !== "step_finish") {
      continue;
    }
    const stepKind = stringOrNull(event.data.stepKind);
    if (stepKind !== "submitted" && stepKind !== "batch_submitted") {
      continue;
    }
    const completedRefs = stringArray(event.data.completedRefs);
    if (!completedRefs) {
      diagnostics.push({
        code: "auto_run_retrospective_missing_completed_refs",
        message: `Auto Run event log line ${event.line} is missing step_finish completedRefs; completedBlockRefs were not inferred from current state.`
      });
      continue;
    }
    for (const ref of completedRefs) {
      if (ref.includes("#")) {
        refs.add(ref);
      }
    }
  }
  return [...refs];
}

function reviewAttemptSummaryFromAttempts(
  attempts: Awaited<ReturnType<typeof getReviewAttempts>>,
  ref: string,
  attemptId: string,
  diagnostics: ValidationIssue[]
): DesktopAutoRunRetrospectiveSummary["reviewVerdicts"][number] | null {
  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!attempt) {
    diagnostics.push({
      code: "auto_run_retrospective_review_attempt_missing",
      message: `Auto Run event references review attempt '${attemptId}' for '${ref}', but that attempt was not found.`
    });
    return null;
  }
  return {
    ref,
    attemptId: attempt.attemptId,
    verdict: attempt.verdict,
    contentPreview: attempt.contentPreview
  };
}

function blockedRefFromState(state: DesktopAutoRunState): string | null {
  if (state.phase !== "blocked" && state.phase !== "failed") {
    return null;
  }
  return (
    state.currentRef ??
    state.explanation.nextAction.ref ??
    recordRefFromRecordId(state.latestRecordId)
  );
}

async function latestReportPath(
  workspace: ProjectWorkspace,
  recordId: string | null,
  diagnostics: ValidationIssue[]
): Promise<string | null> {
  if (!recordId) {
    return null;
  }
  try {
    return (await getRunRecord(workspace, recordId)).reportPath;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    diagnostics.push({
      code: "auto_run_retrospective_record_unreadable",
      message: `Failed to read latest Auto Run record '${recordId}': ${detail}`
    });
    return null;
  }
}

async function reviewVerdictsFromEvents(
  workspace: ProjectWorkspace,
  events: DesktopAutoRunLogEvent[],
  diagnostics: ValidationIssue[]
): Promise<DesktopAutoRunRetrospectiveSummary["reviewVerdicts"]> {
  const reviewAttempts: Array<{ ref: string; attemptId: string }> = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (
      event.type !== "step_finish" ||
      event.data.reviewVerdict === undefined ||
      event.data.reviewVerdict === null
    ) {
      continue;
    }
    const attemptId = stringOrNull(event.data.reviewAttemptId);
    if (!attemptId) {
      diagnostics.push({
        code: "auto_run_retrospective_missing_review_attempt_id",
        message: `Auto Run event log line ${event.line} has reviewVerdict but no reviewAttemptId; review attempt was not inferred.`
      });
      continue;
    }
    const claimRefs = stringArray(event.data.claimRefs);
    if (!claimRefs) {
      diagnostics.push({
        code: "auto_run_retrospective_missing_review_claim_refs",
        message: `Auto Run event log line ${event.line} has reviewVerdict but no claimRefs; review attempt was not inferred.`
      });
      continue;
    }
    for (const ref of claimRefs) {
      if (!ref.includes("#")) {
        continue;
      }
      const key = `${ref}\u0000${attemptId}`;
      if (!seen.has(key)) {
        reviewAttempts.push({ ref, attemptId });
        seen.add(key);
      }
    }
  }

  const summaries: DesktopAutoRunRetrospectiveSummary["reviewVerdicts"] = [];
  for (const { ref, attemptId } of reviewAttempts) {
    try {
      const summary = reviewAttemptSummaryFromAttempts(
        await getReviewAttempts(workspace, ref),
        ref,
        attemptId,
        diagnostics
      );
      if (summary) {
        summaries.push(summary);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        code: "auto_run_retrospective_review_unreadable",
        message: `Failed to read review attempts for '${ref}': ${detail}`
      });
    }
  }
  return summaries;
}

function refreshedExplanation(state: DesktopAutoRunState): DesktopAutoRunState["explanation"] {
  return createAutoRunExplanation({
    phase: state.phase,
    currentRef: state.currentRef,
    currentExecutor: state.currentExecutor,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    latestOutputSummary: state.latestOutputSummary,
    error: state.error
  });
}

function diagnosticMessage(diagnostic: ValidationIssue): string {
  return diagnostic.path
    ? `${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`
    : `${diagnostic.code}: ${diagnostic.message}`;
}

async function buildAutoRunRetrospective(
  workspace: ProjectWorkspace,
  state: DesktopAutoRunState,
  stateReadDiagnostics: ValidationIssue[] = []
): Promise<DesktopAutoRunRetrospectiveSummary> {
  const clonedState = cloneAutoRunState(state);
  const eventLog = await readPersistedAutoRunEventLog(workspace, clonedState.runId);
  const diagnostics: ValidationIssue[] = [
    ...stateReadDiagnostics,
    ...eventLog.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      path: diagnostic.path
    }))
  ];
  const explanation = refreshedExplanation(clonedState);
  return {
    runId: clonedState.runId,
    projectRoot: clonedState.projectRoot,
    canvasId: clonedState.canvasId,
    phase: clonedState.phase,
    scope: { ...clonedState.scope },
    startedAt: clonedState.startedAt,
    updatedAt: clonedState.updatedAt,
    elapsedMs: clonedState.elapsedMs,
    stepCount: clonedState.stepCount,
    completedBlockRefs: completedRefsFromEvents(eventLog.events, diagnostics),
    blockedRef: blockedRefFromState({ ...clonedState, explanation }),
    failedReason:
      clonedState.phase === "failed" || clonedState.phase === "blocked" ? clonedState.error : null,
    reviewVerdicts: await reviewVerdictsFromEvents(workspace, eventLog.events, diagnostics),
    latestRecordId: clonedState.latestRecordId,
    latestRecordPath: clonedState.latestRecordPath,
    latestReportPath: await latestReportPath(workspace, clonedState.latestRecordId, diagnostics),
    nextAction: { ...explanation.nextAction },
    diagnostics
  };
}

export async function getAutoRunRetrospective(
  projectRoot: string,
  canvasId: string | null | undefined,
  runId: string
): Promise<DesktopAutoRunRetrospectiveSummary> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  const { state, diagnostics } = await readPersistedAutoRunStateWithDiagnostics(workspace, runId);
  if (!state && diagnostics.length === 0) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  if (!state) {
    throw new Error(
      `Auto Run '${runId}' could not be read: ${diagnostics.map(diagnosticMessage).join("; ")}`
    );
  }
  return buildAutoRunRetrospective(workspace, state);
}

export async function getLatestAutoRunRetrospective(
  projectRoot: string,
  canvasId?: string | null
): Promise<DesktopAutoRunRetrospectiveSummary | null> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  const normalizedCanvasId = canvasId ?? null;
  const { state, diagnostics } = await readLatestPersistedAutoRunState(workspace, {
    matches: (candidate) =>
      candidate.projectRoot === projectRoot && candidate.canvasId === normalizedCanvasId
  });
  return state ? buildAutoRunRetrospective(workspace, state, diagnostics) : null;
}

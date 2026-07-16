import { createAutoRunExplanation } from "../taskManager/autoRun.js";
import type { AutoRunExplanation } from "../types.js";
import type {
  DesktopAutoRunOptions,
  DesktopAutoRunPhase,
  DesktopAutoRunScope,
  DesktopAutoRunState
} from "./types.js";
import { isInFlightAutoRunPhase } from "./autoRunPhasePolicy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeScope(value: unknown): DesktopAutoRunScope | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "project") {
    return { kind: "project" };
  }
  if (value.kind === "task" && typeof value.taskId === "string" && value.taskId.length > 0) {
    return { kind: "task", taskId: value.taskId };
  }
  if (value.kind === "block" && typeof value.blockRef === "string" && value.blockRef.length > 0) {
    return { kind: "block", blockRef: value.blockRef };
  }
  return null;
}

function normalizePhase(value: unknown): DesktopAutoRunPhase | null {
  if (
    value === "idle" ||
    value === "running" ||
    value === "pausing" ||
    value === "paused" ||
    value === "manual" ||
    value === "completed" ||
    value === "blocked" ||
    value === "failed" ||
    value === "stopped"
  ) {
    return value;
  }
  return null;
}

function normalizeNextActionKind(value: unknown): AutoRunExplanation["nextAction"]["kind"] | null {
  if (
    value === "start" ||
    value === "wait" ||
    value === "resume" ||
    value === "submit_manual_result" ||
    value === "inspect_record" ||
    value === "resolve_error" ||
    value === "review_status"
  ) {
    return value;
  }
  return null;
}

function normalizeOptions(value: unknown): Required<DesktopAutoRunOptions> | null {
  if (!isRecord(value) || typeof value.tmuxEnabled !== "boolean") {
    return null;
  }
  return { tmuxEnabled: value.tmuxEnabled };
}

function validExplanation(value: unknown): AutoRunExplanation | null {
  if (!isRecord(value) || !isRecord(value.nextAction)) {
    return null;
  }
  const phase = normalizePhase(value.phase);
  const actionKind = normalizeNextActionKind(value.nextAction.kind);
  const actionMessage = value.nextAction.message;
  const targetPath = stringOrNull(value.nextAction.targetPath);
  if (!phase || !actionKind || typeof actionMessage !== "string") {
    return null;
  }
  const baseAction = {
    message: actionMessage,
    command: stringOrNull(value.nextAction.command),
    ref: stringOrNull(value.nextAction.ref)
  };
  let nextAction: AutoRunExplanation["nextAction"];
  if (actionKind === "inspect_record") {
    if (targetPath === null) {
      return null;
    }
    nextAction = {
      ...baseAction,
      kind: actionKind,
      targetPath
    };
  } else {
    nextAction = {
      ...baseAction,
      kind: actionKind,
      targetPath
    };
  }
  return {
    phase,
    currentRef: stringOrNull(value.currentRef),
    currentExecutor: stringOrNull(value.currentExecutor),
    latestRecordId: stringOrNull(value.latestRecordId),
    latestRecordPath: stringOrNull(value.latestRecordPath),
    latestOutputSummary: stringOrNull(value.latestOutputSummary),
    error: stringOrNull(value.error),
    nextAction
  };
}

function withRecoveredExplanation(
  state: Omit<DesktopAutoRunState, "explanation">
): DesktopAutoRunState {
  return {
    ...state,
    explanation: createAutoRunExplanation({
      phase: state.phase,
      currentRef: state.currentRef,
      currentExecutor: state.currentExecutor,
      latestRecordId: state.latestRecordId,
      latestRecordPath: state.latestRecordPath,
      latestOutputSummary: state.latestOutputSummary,
      error: state.error
    })
  };
}

export function normalizePersistedAutoRunState(
  value: unknown,
  paths: { statePath: string; eventLogPath: string }
): DesktopAutoRunState | null {
  if (!isRecord(value)) {
    return null;
  }
  const phase = normalizePhase(value.phase);
  const scope = normalizeScope(value.scope);
  const options = normalizeOptions(value.options);
  const runId = requiredString(value, "runId");
  const projectRoot = requiredString(value, "projectRoot");
  const stepCount = requiredNumber(value, "stepCount");
  const stepLimit = requiredNumber(value, "stepLimit");
  const elapsedMs = requiredNumber(value, "elapsedMs");
  const startedAt = requiredString(value, "startedAt");
  const updatedAt = requiredString(value, "updatedAt");
  if (
    !phase ||
    !scope ||
    !options ||
    !runId ||
    !projectRoot ||
    stepCount === null ||
    stepLimit === null ||
    elapsedMs === null ||
    !startedAt ||
    !updatedAt
  ) {
    return null;
  }
  const state: DesktopAutoRunState = {
    runId,
    runSessionId: stringOrNull(value.runSessionId),
    projectRoot,
    canvasId: stringOrNull(value.canvasId),
    scope,
    phase,
    stepCount,
    stepLimit,
    currentRef: stringOrNull(value.currentRef),
    currentExecutor: stringOrNull(value.currentExecutor),
    elapsedMs,
    latestOutputSummary: stringOrNull(value.latestOutputSummary),
    latestRecordId: stringOrNull(value.latestRecordId),
    latestRecordPath: stringOrNull(value.latestRecordPath),
    explanation:
      validExplanation(value.explanation) ??
      createAutoRunExplanation({
        phase,
        currentRef: stringOrNull(value.currentRef),
        currentExecutor: stringOrNull(value.currentExecutor),
        latestRecordId: stringOrNull(value.latestRecordId),
        latestRecordPath: stringOrNull(value.latestRecordPath),
        latestOutputSummary: stringOrNull(value.latestOutputSummary),
        error: stringOrNull(value.error)
      }),
    statePath: paths.statePath,
    eventLogPath: paths.eventLogPath,
    options,
    error: stringOrNull(value.error),
    startedAt,
    updatedAt
  };
  return state;
}

export function recoverPersistedAutoRunState(
  state: DesktopAutoRunState,
  hasActiveLoop: boolean
): DesktopAutoRunState {
  // In-flight phase classification is policy-owned; hasActiveLoop is only process evidence.
  if (hasActiveLoop || !isInFlightAutoRunPhase(state.phase)) {
    return state;
  }
  const interruptedPhase = state.phase;
  return withRecoveredExplanation({
    ...state,
    phase: "failed",
    error: `Auto Run was interrupted while ${interruptedPhase}; the desktop process exited before this run reached a terminal state. Inspect the latest record, then start a new Auto Run when ready.`
  });
}

import { join } from "node:path";
import { killTmuxSessionsForRun } from "../autoRun/tmuxExecutor.js";
import { createAutoRunExplanation, runAutoRunStep } from "../taskManager/autoRun.js";
import { resetMaxCycleReviewsForRetry } from "../taskManager/reviewRetry.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import type { ProjectWorkspace } from "../types.js";
import type {
  DesktopAutoRunEventLog,
  DesktopAutoRunEventListener,
  DesktopAutoRunOptions,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopRuntimeResetOptions,
  DesktopRuntimeResetResult
} from "./types.js";
import { appendAutoRunEvent, autoRunRoot, cloneAutoRunState, createAutoRunEvent, now } from "./runStateStore.js";
import { listPersistedAutoRunStates, nextPersistedAutoRunId, readPersistedAutoRunEventLog, writePersistedAutoRunState } from "./runStateRepository.js";
import { claimRef, claimRefs, claimScope, completedRefs, executorName, latestStatus, outputSummary, phaseAfterStep, reviewAttemptId, reviewVerdict, terminalPatch } from "./runStepState.js";
import { invalidateDesktopProjectProjection } from "./graph/projectProjectionModel.js";
import { appendRunSessionEvent, createRunSession, resetRuntimeState, updateRunSession } from "../runSessions/index.js";

const runs = new Map<string, DesktopAutoRunState>();
const runWorkspaces = new Map<string, ProjectWorkspace>();
const activeLoops = new Set<string>();
const autoRunEventListeners = new Set<DesktopAutoRunEventListener>();

function normalizeAutoRunOptions(options?: DesktopAutoRunOptions): Required<DesktopAutoRunOptions> {
  return {
    tmuxEnabled: options?.tmuxEnabled ?? true
  };
}

async function setState(runId: string, patch: Partial<DesktopAutoRunState>, eventType?: string, data: Record<string, unknown> = {}): Promise<DesktopAutoRunState> {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  const previousPhase = current.phase;
  const next = withExplanation({ ...current, ...patch, updatedAt: now() });
  const immediateVisibility = eventType === "pause_requested" || eventType === "run_stopped";
  if (immediateVisibility) {
    runs.set(runId, next);
  }
  await writePersistedAutoRunState(next);
  let changedEventType: string | null = null;
  if (eventType || previousPhase !== next.phase) {
    const resolvedEventType = eventType ?? "phase_change";
    await appendAutoRunEvent(next, resolvedEventType, { previousPhase, nextPhase: next.phase, ...data });
    changedEventType = resolvedEventType;
  }
  if (!immediateVisibility) {
    runs.set(runId, next);
  }
  if (changedEventType) {
    emitAutoRunChanged(next, changedEventType);
  }
  releaseRunResources(runId, next);
  return next;
}

function withExplanation(state: Omit<DesktopAutoRunState, "explanation"> & { explanation?: DesktopAutoRunState["explanation"] }): DesktopAutoRunState {
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

function emitAutoRunChanged(state: DesktopAutoRunState, eventType: string): void {
  for (const listener of autoRunEventListeners) {
    const event = createAutoRunEvent(state, eventType);
    try {
      listener(event);
    } catch (error) {
      console.error("Auto Run event listener failed.", error);
    }
  }
}

export function subscribeAutoRunEvents(listener: DesktopAutoRunEventListener): () => void {
  autoRunEventListeners.add(listener);
  return () => {
    autoRunEventListeners.delete(listener);
  };
}

async function runLoop(runId: string): Promise<void> {
  if (activeLoops.has(runId)) {
    return;
  }
  activeLoops.add(runId);
  try {
    while (true) {
      const current = runs.get(runId);
      if (!current || (current.phase !== "running" && current.phase !== "pausing")) {
        return;
      }
      if (current.phase === "pausing") {
        await setState(runId, { phase: "paused" }, "pause_completed");
        return;
      }
      if (current.stepCount >= current.stepLimit) {
        await setState(runId, { phase: "paused", error: "Step limit reached." }, "step_limit_reached");
        return;
      }
      try {
        const workspace = runWorkspaces.get(runId) ?? (await resolveTaskCanvasWorkspace(current.projectRoot, current.canvasId));
        const { manifest } = await loadPackage(workspace);
        await appendAutoRunEvent(current, "step_start", { scope: current.scope });
        const step = await runAutoRunStep({
          projectRoot: workspace,
          parallel: manifest.execution.parallel.enabled,
          scope: claimScope(current.scope),
          tmuxEnabled: current.options.tmuxEnabled,
          tmuxOwnerRunId: runId
        });
        invalidateDesktopProjectProjection(current.projectRoot);
        const { record, warnings } = await latestStatus(workspace);
        const patch = terminalPatch(step, warnings);
        const afterStep = runs.get(runId);
        if (!afterStep || afterStep.phase === "stopped") {
          if (afterStep?.phase === "stopped") {
            await appendAutoRunEvent(afterStep, "stopped_step_ignored", { stepKind: step.kind, stoppedPhase: afterStep.phase });
          }
          return;
        }
        const nextPhase = phaseAfterStep(afterStep, patch);
        await setState(
          runId,
          {
            stepCount: afterStep.stepCount + 1,
            currentRef: claimRef(step),
            currentExecutor: executorName(step),
            latestOutputSummary: outputSummary(step),
            latestRecordId: record?.recordId ?? null,
            latestRecordPath: record?.path ?? null,
            ...(patch ?? {}),
            phase: nextPhase
          },
          "step_finish",
          {
            stepKind: step.kind,
            claimRefs: claimRefs(step),
            completedRefs: completedRefs(step),
            recordId: record?.recordId ?? null,
            recordPath: record?.path ?? null,
            reviewAttemptId: reviewAttemptId(step),
            reviewVerdict: reviewVerdict(step),
            pausedAfterStep: afterStep.phase === "pausing"
          }
        );
      } catch (error) {
        const afterError = runs.get(runId);
        if (!afterError || afterError.phase === "stopped") {
          return;
        }
        await setState(
          runId,
          {
            phase: "failed",
            error: error instanceof Error ? error.message : String(error)
          },
          "run_failed"
        );
        return;
      }
    }
  } finally {
    activeLoops.delete(runId);
    releaseRunResources(runId);
  }
}

function launchRunLoop(runId: string): void {
  void runLoop(runId);
}

function canRehydratePersistedRun(state: DesktopAutoRunState): boolean {
  return state.phase === "paused" || state.phase === "manual";
}

function isRunIdConflictProtected(state: DesktopAutoRunState): boolean {
  return state.phase === "running" || state.phase === "pausing" || state.phase === "paused" || state.phase === "manual";
}

function sameAutoRunTarget(state: DesktopAutoRunState, projectRoot: string, canvasId: string | null): boolean {
  return state.projectRoot === projectRoot && state.canvasId === canvasId;
}

async function stopResetTargetAutoRuns(projectRoot: string, canvasId: string | null): Promise<string[]> {
  const latest = await getLatestAutoRunSummary(projectRoot, canvasId);
  const runIds = new Set(
    [...runs.values()]
      .filter((run) => sameAutoRunTarget(run, projectRoot, canvasId) && (run.phase === "paused" || run.phase === "manual"))
      .map((run) => run.runId)
  );
  if (latest && sameAutoRunTarget(latest, projectRoot, canvasId) && (latest.phase === "paused" || latest.phase === "manual")) {
    runIds.add(latest.runId);
  }

  const stoppedRunIds: string[] = [];
  for (const runId of runIds) {
    const current = runs.get(runId);
    if (!current || (current.phase !== "paused" && current.phase !== "manual")) {
      continue;
    }
    await stopAutoRun(runId);
    stoppedRunIds.push(runId);
  }
  return stoppedRunIds;
}

function activeResetTargetAutoRunIds(projectRoot: string, canvasId: string | null): string[] {
  return [...runs.values()]
    .filter((run) => sameAutoRunTarget(run, projectRoot, canvasId) && (run.phase === "running" || run.phase === "pausing" || activeLoops.has(run.runId)))
    .map((run) => run.runId)
    .sort();
}

function releaseRunResources(runId: string, state = runs.get(runId)): void {
  if (!state || isRunIdConflictProtected(state)) {
    return;
  }
  runWorkspaces.delete(runId);
  if (activeLoops.has(runId)) {
    return;
  }
  runs.delete(runId);
}

function assertRunIdMatchesExistingTarget(state: DesktopAutoRunState): void {
  const existing = runs.get(state.runId);
  if (!existing || !isRunIdConflictProtected(existing) || (existing.projectRoot === state.projectRoot && existing.canvasId === state.canvasId)) {
    return;
  }
  throw new Error(
    `Auto Run '${state.runId}' already belongs to project '${existing.projectRoot}' canvas '${existing.canvasId ?? "default"}'.`
  );
}

function rehydratePersistedRun(state: DesktopAutoRunState, workspace: ProjectWorkspace): DesktopAutoRunState {
  const rehydrated = state.phase === "paused" ? withExplanation(state) : state;
  assertRunIdMatchesExistingTarget(rehydrated);
  runs.set(rehydrated.runId, rehydrated);
  runWorkspaces.set(rehydrated.runId, workspace);
  return rehydrated;
}

export async function startAutoRun(
  projectRoot: string,
  canvasId: string | null | undefined,
  scope: DesktopAutoRunScope = { kind: "project" },
  stepLimit = 20,
  options?: DesktopAutoRunOptions
): Promise<DesktopAutoRunState> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  const resetReviews = await resetMaxCycleReviewsForRetry({ projectRoot: workspace, scope: claimScope(scope) });
  const runId = await nextPersistedAutoRunId(workspace, {
    isReserved: (candidateRunId) => {
      const existing = runs.get(candidateRunId);
      return activeLoops.has(candidateRunId) || (existing ? isRunIdConflictProtected(existing) : false);
    }
  });
  const root = autoRunRoot(workspace, runId);
  const timestamp = now();
  const state = withExplanation({
    runId,
    projectRoot,
    canvasId: canvasId ?? null,
    scope,
    phase: "running",
    stepCount: 0,
    stepLimit,
    currentRef: null,
    currentExecutor: null,
    elapsedMs: 0,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    statePath: join(root, "state.json"),
    eventLogPath: join(root, "events.ndjson"),
    options: normalizeAutoRunOptions(options),
    error: null,
    startedAt: timestamp,
    updatedAt: timestamp
  });
  runs.set(runId, state);
  runWorkspaces.set(runId, workspace);
  await writePersistedAutoRunState(state);
  await appendAutoRunEvent(state, "run_started", { scope, resetMaxCycleReviewRefs: resetReviews.refs });
  emitAutoRunChanged(state, "run_started");
  launchRunLoop(runId);
  return cloneAutoRunState(state);
}

export async function pauseAutoRun(runId: string): Promise<DesktopAutoRunState> {
  const state = runs.get(runId);
  if (!state) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  if (state.phase === "running") {
    return cloneAutoRunState(await setState(runId, { phase: "pausing" }, "pause_requested"));
  }
  return cloneAutoRunState(state);
}

export async function resumeAutoRun(runId: string): Promise<DesktopAutoRunState> {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  if (current.phase !== "paused" && current.phase !== "pausing") {
    return cloneAutoRunState(current);
  }
  const state = await setState(runId, { phase: "running", error: null }, "run_resumed");
  launchRunLoop(runId);
  return cloneAutoRunState(state);
}

export async function stopAutoRun(runId: string): Promise<DesktopAutoRunState> {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  const killed = current.phase === "running" || current.phase === "pausing" ? await killTmuxSessionsForRun(runId) : [];
  const stopped = await setState(runId, { phase: "stopped" }, "run_stopped", { killedTmuxSessions: killed });
  return cloneAutoRunState(stopped);
}

export async function resetDesktopRuntimeState(
  projectRoot: string,
  canvasId: string | null | undefined,
  options: DesktopRuntimeResetOptions = {}
): Promise<DesktopRuntimeResetResult> {
  const normalizedCanvasId = canvasId ?? null;
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, normalizedCanvasId);
  const session = await createRunSession({ projectRoot: workspace, kind: "reset", trigger: "desktop", phase: "resetting" });
  let stoppedAutoRunIds: string[] = [];

  try {
    await appendRunSessionEvent(workspace, session.sessionId, "reset_started", {
      phase: "resetting",
      force: options.force === true,
      reason: options.reason ?? null
    });
    const activeRunIds = activeResetTargetAutoRunIds(projectRoot, normalizedCanvasId);
    if (activeRunIds.length > 0) {
      throw new Error(`Cannot reset runtime state while Auto Run is active (${activeRunIds.join(", ")}). Stop Auto Run and wait for the current step to settle first.`);
    }
    if (options.force === true) {
      stoppedAutoRunIds = await stopResetTargetAutoRuns(projectRoot, normalizedCanvasId);
    }
    const reset = await resetRuntimeState({
      projectRoot: workspace,
      force: options.force,
      session
    });
    invalidateDesktopProjectProjection(projectRoot);
    const finishedAt = new Date().toISOString();
    const completedSession = await updateRunSession(workspace, session.sessionId, {
      phase: "completed",
      finishedAt
    });
    await appendRunSessionEvent(workspace, session.sessionId, "session_completed", {
      phase: "completed",
      finishedAt,
      stoppedAutoRunIds
    });
    return {
      ...reset,
      session: completedSession,
      stoppedAutoRunIds
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    await updateRunSession(workspace, session.sessionId, {
      phase: "failed",
      finishedAt,
      error: message
    });
    await appendRunSessionEvent(workspace, session.sessionId, "session_failed", {
      phase: "failed",
      finishedAt,
      error: message,
      stoppedAutoRunIds
    });
    throw error;
  }
}

export async function getAutoRunState(runId: string): Promise<DesktopAutoRunState> {
  const state = runs.get(runId);
  if (!state) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  return cloneAutoRunState(state);
}

export async function getLatestAutoRunSummary(projectRoot: string, canvasId?: string | null): Promise<DesktopAutoRunState | null> {
  const normalizedCanvasId = canvasId ?? null;
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, normalizedCanvasId);
  const latest = [...runs.values()]
    .filter((run) => run.projectRoot === projectRoot && run.canvasId === normalizedCanvasId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  if (latest) {
    return cloneAutoRunState(latest);
  }
  const persistedLatest = (await listPersistedAutoRunStates(workspace, { hasActiveLoop: (runId) => activeLoops.has(runId) }))
    .filter((run) => (run.projectRoot === projectRoot || run.projectRoot === workspace.rootPath) && run.canvasId === normalizedCanvasId)
    .at(0);
  if (!persistedLatest) {
    return null;
  }
  const state = canRehydratePersistedRun(persistedLatest)
    ? rehydratePersistedRun(persistedLatest, workspace)
    : persistedLatest;
  return cloneAutoRunState(state);
}

export async function listAutoRunEvents(projectRoot: string, canvasId: string | null | undefined, runId: string): Promise<DesktopAutoRunEventLog> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  return readPersistedAutoRunEventLog(workspace, runId);
}

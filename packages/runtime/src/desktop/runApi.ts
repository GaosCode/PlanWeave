import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { killTmuxSessionsForRun } from "../autoRun/tmuxExecutor.js";
import { listExecutorProfilesForManifest } from "../autoRun/executors.js";
import {
  activeAgentRunRegistry,
  shutdownDesktopAgentRun,
  type ActiveAgentRunActionIdentity,
  type ActiveAgentRunSessionActionIdentity
} from "../autoRun/activeAgentRunRegistry.js";
import type { JsonRpcValue, RunnerInteractionBroker } from "../autoRun/liveControl.js";
import { redactRunnerEventText } from "../autoRun/runnerEventRedaction.js";
import { createAutoRunExplanation, runAutoRunStep } from "../taskManager/autoRun.js";
import {
  resetMaxCycleReviewsForRetryWithRollback,
  type MaxCycleReviewResetTransaction
} from "../taskManager/reviewRetry.js";
import { loadPackage } from "../package/loadPackage.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import {
  assertDesktopAgentRunControlAccepted,
  executeDesktopAgentRunControl
} from "./agentRunControlApi.js";
import type { AgentRunControlRespondOutcome } from "../autoRun/agentRunControlContract.js";
import type { PackageWorkspaceRef, ProjectWorkspace, ValidationIssue } from "../types.js";
import type {
  DesktopAutoRunEventLog,
  DesktopAutoRunEventListener,
  DesktopAutoRunOptions,
  DesktopAutoRunPhase,
  DesktopLatestAutoRunSummary,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopCanvasReference,
  DesktopRuntimeRefreshSnapshot,
  DesktopRuntimeResetOptions,
  DesktopRuntimeResetResult
} from "./types.js";
import {
  appendAutoRunEvent,
  autoRunRoot,
  cloneAutoRunState,
  createAutoRunEvent,
  now
} from "./runStateStore.js";
import {
  nextPersistedAutoRunId,
  listPersistedAutoRunStatesWithDiagnostics,
  listRunDirectories,
  readLatestPersistedAutoRunState,
  readPersistedAutoRunEventLog,
  writePersistedAutoRunState
} from "./runStateRepository.js";
import {
  mutateAutoRunTransition,
  inspectPendingTransitionsForWorkspace,
  recoverAllPendingTransitions,
  recoverPendingTransition,
  type SessionSummaryBuilder,
  type TransitionDiagnostic
} from "./autoRunTransition.js";
import {
  claimRef,
  claimRefs,
  claimScope,
  completedRefs,
  executorName,
  latestStatus,
  outputSummary,
  phaseAfterStep,
  reviewAttemptId,
  reviewVerdict,
  terminalPatch
} from "./runStepState.js";
import { invalidateDesktopProjectProjection } from "./graph/projectProjectionModel.js";
import { formatDesktopDiagnostic } from "./graph/desktopDiagnostics.js";
import {
  appendRunSessionEvent,
  createRunSession,
  resetRuntimeState,
  updateRunSession
} from "../runSessions/index.js";
import { discardRunSessionInitialization } from "../runSessions/repository.js";
import type { RunSessionAutoRunSummary, RunSessionPhase } from "../runSessions/index.js";
import {
  latestAutoRunStatePointerPath,
  readLatestAutoRunStatePointer,
  writeLatestAutoRunStatePointer
} from "./runStatePointer.js";
import {
  isInFlightAutoRunPhase,
  isNonTerminalAutoRunPhase,
  isRecoverableAutoRunPhase
} from "./autoRunPhasePolicy.js";

const runs = new Map<string, DesktopAutoRunState>();
const runWorkspaces = new Map<string, ProjectWorkspace>();
const stopOperations = new Map<string, Promise<DesktopAutoRunState>>();
const stopIntents = new Set<string>();
const activeLoops = new Set<string>();
type DesktopRunLoopOperation = {
  result: Promise<void>;
  handled: Promise<void>;
  error: unknown | null;
  inFlight: boolean;
};
const runLoopOperations = new Map<string, DesktopRunLoopOperation>();
const runAbortControllers = new Map<string, AbortController>();
const runCliAbortControllers = new Map<string, AbortController>();
const autoRunEventListeners = new Set<DesktopAutoRunEventListener>();
const desktopInteractionBroker: RunnerInteractionBroker = {
  mode: "interactive",
  requestAvailable: () => undefined
};

type DesktopRunSessionStopReason = RunSessionAutoRunSummary["stopReason"];

function normalizeAutoRunOptions(options?: DesktopAutoRunOptions): Required<DesktopAutoRunOptions> {
  return {
    tmuxEnabled: options?.tmuxEnabled ?? true,
    acpRecovery: options?.acpRecovery ?? null
  };
}

const buildAutoRunSessionSummary: SessionSummaryBuilder = async (workspace, state, eventType) =>
  autoRunSessionSummary(workspace, state, stopReasonForAutoRunEvent(eventType));

function transitionValidationIssue(diagnostic: TransitionDiagnostic): ValidationIssue {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.transitionId ? { transitionId: diagnostic.transitionId } : {})
  };
}

async function setState(
  runId: string,
  patch: Partial<DesktopAutoRunState>,
  eventType?: string,
  data: Record<string, unknown> = {},
  shouldApply: (authority: DesktopAutoRunState) => boolean = () => true
): Promise<DesktopAutoRunState> {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  const workspace = await workspaceForAutoRunState(current);
  const mutation = await mutateAutoRunTransition({
    workspace,
    runId,
    memoryState: current,
    eventType: eventType ?? "phase_change",
    data,
    buildSessionSummary: buildAutoRunSessionSummary,
    mutate: (authority) =>
      shouldApply(authority) ? withExplanation({ ...authority, ...patch, updatedAt: now() }) : null
  });
  runs.set(runId, mutation.state);
  if (mutation.applied && mutation.eventType) {
    emitAutoRunChanged(mutation.state, mutation.eventType);
  }
  releaseRunResources(runId, mutation.state);
  return mutation.state;
}

async function workspaceForAutoRunState(state: DesktopAutoRunState): Promise<ProjectWorkspace> {
  return (
    runWorkspaces.get(state.runId) ?? resolveTaskCanvasWorkspace(state.projectRoot, state.canvasId)
  );
}

function runSessionPhaseForAutoRunPhase(phase: DesktopAutoRunPhase): RunSessionPhase {
  if (
    phase === "completed" ||
    phase === "manual" ||
    phase === "blocked" ||
    phase === "failed" ||
    phase === "stopped"
  ) {
    return phase;
  }
  return "running";
}

async function autoRunSessionSummary(
  workspace: ProjectWorkspace,
  state: DesktopAutoRunState,
  stopReason: DesktopRunSessionStopReason
): Promise<RunSessionAutoRunSummary> {
  const { manifest } = await loadPackage(workspace);
  const profileEvidence = state.currentExecutor
    ? listExecutorProfilesForManifest(manifest).find(
        (profile) => profile.name === state.currentExecutor
      )
    : undefined;
  return {
    desktopRunId: state.runId,
    stepCount: state.stepCount,
    parallel: manifest.execution.parallel.enabled,
    executorOverride: null,
    effectiveExecutor: state.currentExecutor,
    agentId: profileEvidence?.agentId ?? null,
    runnerKind: profileEvidence?.runnerKind ?? null,
    stopReason
  };
}

function stopReasonForAutoRunEvent(eventType: string): DesktopRunSessionStopReason {
  return eventType === "step_limit_reached" ? "step_limit" : null;
}

async function appendDesktopRunSessionEvent(
  state: DesktopAutoRunState,
  eventType: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  if (!state.runSessionId) {
    return;
  }
  const workspace = await workspaceForAutoRunState(state);
  await appendRunSessionEvent(workspace, state.runSessionId, eventType, {
    phase: runSessionPhaseForAutoRunPhase(state.phase),
    desktopRunId: state.runId,
    autoRunPhase: state.phase,
    stepCount: state.stepCount,
    ...data
  });
}

function withExplanation(
  state: Omit<DesktopAutoRunState, "explanation"> & {
    explanation?: DesktopAutoRunState["explanation"];
  }
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
      if (
        !current ||
        stopIntents.has(runId) ||
        (current.phase !== "running" && current.phase !== "pausing")
      ) {
        return;
      }
      if (current.phase === "pausing") {
        await setState(runId, { phase: "paused" }, "pause_completed");
        return;
      }
      if (current.stepCount >= current.stepLimit) {
        await setState(
          runId,
          { phase: "paused", error: "Step limit reached." },
          "step_limit_reached"
        );
        return;
      }
      try {
        const workspace =
          runWorkspaces.get(runId) ??
          (await resolveTaskCanvasWorkspace(current.projectRoot, current.canvasId));
        const { manifest } = await loadPackage(workspace);
        await appendAutoRunEvent(current, "step_start", { scope: current.scope });
        await appendDesktopRunSessionEvent(current, "step_start", { scope: current.scope });
        const beforeClaim = runs.get(runId);
        const operation = runLoopOperations.get(runId);
        if (
          !beforeClaim ||
          stopIntents.has(runId) ||
          beforeClaim.phase === "stopped" ||
          runAbortControllers.get(runId)?.signal.aborted
        ) {
          return;
        }
        if (operation) operation.inFlight = true;
        const step = await runAutoRunStep({
          projectRoot: workspace,
          parallel: manifest.execution.parallel.enabled,
          scope: claimScope(current.scope),
          tmuxEnabled: current.options.tmuxEnabled,
          tmuxOwnerRunId: runId,
          desktopRunId: runId,
          runSessionId: current.runSessionId ?? undefined,
          signal: runAbortControllers.get(runId)?.signal,
          cliSignal: runCliAbortControllers.get(runId)?.signal,
          interactionBroker: desktopInteractionBroker,
          acpRecovery: current.options.acpRecovery ?? undefined
        });
        if (operation) operation.inFlight = false;
        invalidateDesktopProjectProjection(current.projectRoot);
        const { record, warnings } = await latestStatus(workspace);
        const patch = terminalPatch(step, warnings);
        const afterStep = runs.get(runId);
        if (!afterStep || stopIntents.has(runId) || afterStep.phase === "stopped") {
          if (afterStep?.phase === "stopped") {
            await appendAutoRunEvent(afterStep, "stopped_step_ignored", {
              stepKind: step.kind,
              stoppedPhase: afterStep.phase
            });
            await appendDesktopRunSessionEvent(afterStep, "stopped_step_ignored", {
              stepKind: step.kind,
              stoppedPhase: afterStep.phase
            });
          }
          return;
        }
        const nextPhase = phaseAfterStep(afterStep, patch);
        const completedWithoutWork = step.kind === "idle";
        const hasExecutedStep = afterStep.stepCount > 0;
        await setState(
          runId,
          {
            stepCount: afterStep.stepCount + (completedWithoutWork ? 0 : 1),
            currentRef: completedWithoutWork ? afterStep.currentRef : claimRef(step),
            currentExecutor: completedWithoutWork ? afterStep.currentExecutor : executorName(step),
            latestOutputSummary:
              completedWithoutWork && hasExecutedStep
                ? afterStep.latestOutputSummary
                : outputSummary(step),
            latestRecordId: completedWithoutWork
              ? afterStep.latestRecordId
              : (record?.recordId ?? null),
            latestRecordPath: completedWithoutWork
              ? afterStep.latestRecordPath
              : (record?.path ?? null),
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
        const operation = runLoopOperations.get(runId);
        if (operation) operation.inFlight = false;
        const afterError = runs.get(runId);
        if (!afterError || stopIntents.has(runId) || afterError.phase === "stopped") {
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

export function listDesktopPendingAgentRequests(identity: ActiveAgentRunActionIdentity) {
  return activeAgentRunRegistry.listPending(identity);
}

export function respondToDesktopAgentRequest(
  ref: DesktopCanvasReference,
  recordId: string,
  identity: ActiveAgentRunActionIdentity,
  outcome: AgentRunControlRespondOutcome
): Promise<void> {
  return executeDesktopAgentRunControl({
    ref,
    recordId,
    action: { kind: "respond", identity, outcome }
  }).then(assertDesktopAgentRunControlAccepted);
}

export function respondToDesktopAgentAuthenticationRequest(
  identity: ActiveAgentRunActionIdentity,
  value: JsonRpcValue
): Promise<void> {
  if (identity.desktopRunId == null) {
    return Promise.reject(new Error("Desktop authentication requires an exact desktopRunId."));
  }
  return activeAgentRunRegistry.respondAuthentication(identity, value);
}

export function cancelDesktopAgentRun(
  ref: DesktopCanvasReference,
  recordId: string,
  identity: ActiveAgentRunSessionActionIdentity
): Promise<void> {
  return executeDesktopAgentRunControl({
    ref,
    recordId,
    action: { kind: "cancel", identity }
  }).then(assertDesktopAgentRunControlAccepted);
}

function launchRunLoop(runId: string): void {
  if (runLoopOperations.has(runId)) return;
  const result = runLoop(runId);
  const operation: DesktopRunLoopOperation = {
    result,
    handled: Promise.resolve(),
    error: null,
    inFlight: false
  };
  operation.handled = result.then(
    () => {
      if (runLoopOperations.get(runId) === operation) {
        runLoopOperations.delete(runId);
      }
    },
    (error: unknown) => {
      operation.error = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Desktop Auto Run '${runId}' loop failed: ${redactRunnerEventText(message).text}`
      );
    }
  );
  runLoopOperations.set(runId, operation);
}

function canRehydratePersistedRun(state: DesktopAutoRunState): boolean {
  return isRecoverableAutoRunPhase(state.phase);
}

function isRunIdConflictProtected(state: DesktopAutoRunState): boolean {
  // Ownership comes from phase policy; activeLoops is process evidence, not a second rule set.
  return isNonTerminalAutoRunPhase(state.phase);
}

function sameAutoRunTarget(
  state: DesktopAutoRunState,
  projectRoot: string,
  canvasId: string | null
): boolean {
  return state.projectRoot === projectRoot && state.canvasId === canvasId;
}

async function stopResetTargetAutoRuns(
  projectRoot: string,
  canvasId: string | null
): Promise<string[]> {
  const latest = await getLatestAutoRunSummary(projectRoot, canvasId);
  const runIds = new Set(
    [...runs.values()]
      .filter(
        (run) =>
          sameAutoRunTarget(run, projectRoot, canvasId) && isRecoverableAutoRunPhase(run.phase)
      )
      .map((run) => run.runId)
  );
  if (
    latest &&
    sameAutoRunTarget(latest, projectRoot, canvasId) &&
    isRecoverableAutoRunPhase(latest.phase)
  ) {
    runIds.add(latest.runId);
  }

  const stoppedRunIds: string[] = [];
  for (const runId of runIds) {
    const current = runs.get(runId);
    if (!current || !isRecoverableAutoRunPhase(current.phase)) {
      continue;
    }
    await stopAutoRun(runId);
    stoppedRunIds.push(runId);
  }
  return stoppedRunIds;
}

function activeResetTargetAutoRunIds(projectRoot: string, canvasId: string | null): string[] {
  return [...runs.values()]
    .filter(
      (run) =>
        sameAutoRunTarget(run, projectRoot, canvasId) &&
        // activeLoops is runtime loop evidence only; phase ownership stays in the policy.
        (isInFlightAutoRunPhase(run.phase) || activeLoops.has(run.runId))
    )
    .map((run) => run.runId)
    .sort();
}

function releaseRunResources(runId: string, state = runs.get(runId)): void {
  if (!state || isRunIdConflictProtected(state)) {
    return;
  }
  if (activeLoops.has(runId)) {
    return;
  }
  runWorkspaces.delete(runId);
  runAbortControllers.delete(runId);
  runCliAbortControllers.delete(runId);
  runs.delete(runId);
}

function assertRunIdMatchesExistingTarget(state: DesktopAutoRunState): void {
  const existing = runs.get(state.runId);
  if (
    !existing ||
    !isRunIdConflictProtected(existing) ||
    (existing.projectRoot === state.projectRoot && existing.canvasId === state.canvasId)
  ) {
    return;
  }
  throw new Error(
    `Auto Run '${state.runId}' already belongs to project '${existing.projectRoot}' canvas '${existing.canvasId ?? "default"}'.`
  );
}

function rehydratePersistedRun(
  state: DesktopAutoRunState,
  workspace: ProjectWorkspace
): DesktopAutoRunState {
  const rehydrated = state.phase === "paused" ? withExplanation(state) : state;
  assertRunIdMatchesExistingTarget(rehydrated);
  runs.set(rehydrated.runId, rehydrated);
  runWorkspaces.set(rehydrated.runId, workspace);
  runAbortControllers.set(rehydrated.runId, new AbortController());
  runCliAbortControllers.set(rehydrated.runId, new AbortController());
  return rehydrated;
}

function clearAutoRunInitializationMemory(runId: string): void {
  activeLoops.delete(runId);
  runs.delete(runId);
  runWorkspaces.delete(runId);
  runAbortControllers.delete(runId);
  runCliAbortControllers.delete(runId);
  runLoopOperations.delete(runId);
  stopOperations.delete(runId);
  stopIntents.delete(runId);
}

async function rollbackAutoRunInitialization(options: {
  workspace: ProjectWorkspace;
  runId: string;
  sessionId: string | null;
  previousPointer: Awaited<ReturnType<typeof readLatestAutoRunStatePointer>>;
  originalError: unknown;
}): Promise<never> {
  clearAutoRunInitializationMemory(options.runId);
  const cleanupOperations: Promise<unknown>[] = [
    rm(autoRunRoot(options.workspace, options.runId), { recursive: true, force: true }),
    options.previousPointer === null
      ? rm(latestAutoRunStatePointerPath(options.workspace), { force: true })
      : writeLatestAutoRunStatePointer(options.workspace, options.previousPointer)
  ];
  if (options.sessionId !== null) {
    cleanupOperations.push(discardRunSessionInitialization(options.workspace, options.sessionId));
  }
  const cleanupResults = await Promise.allSettled(cleanupOperations);
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [options.originalError, ...cleanupErrors],
      `Auto Run '${options.runId}' initialization failed and cleanup did not complete.`
    );
  }
  throw options.originalError;
}

export async function initializeAutoRunUnderCanvasLock(
  workspace: ProjectWorkspace,
  projectRoot: string,
  canvasId: string | null | undefined,
  scope: DesktopAutoRunScope = { kind: "project" },
  stepLimit = 20,
  options?: DesktopAutoRunOptions
): Promise<DesktopAutoRunState> {
  if (await hasAutoRunInWorkspace(workspace)) {
    throw new Error("Cannot start Auto Run while another Auto Run is active.");
  }
  const { manifest } = await loadPackage(workspace);
  const previousPointer = await readLatestAutoRunStatePointer(workspace);
  const runId = await nextPersistedAutoRunId(workspace, {
    isReserved: (candidateRunId) => {
      const existing = runs.get(candidateRunId);
      return (
        activeLoops.has(candidateRunId) || (existing ? isRunIdConflictProtected(existing) : false)
      );
    }
  });
  let sessionId: string | null = null;
  let reviewReset: MaxCycleReviewResetTransaction | null = null;
  try {
    const session = await createRunSession({
      projectRoot: workspace,
      kind: "run",
      trigger: "desktop",
      scope
    });
    sessionId = session.sessionId;
    const root = autoRunRoot(workspace, runId);
    const timestamp = now();
    const state = withExplanation({
      runId,
      runSessionId: session.sessionId,
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
    runAbortControllers.set(runId, new AbortController());
    runCliAbortControllers.set(runId, new AbortController());
    runWorkspaces.set(runId, workspace);
    await writePersistedAutoRunState(state);
    reviewReset = await resetMaxCycleReviewsForRetryWithRollback({
      projectRoot: workspace,
      scope: claimScope(scope)
    });
    await appendAutoRunEvent(state, "run_started", {
      scope,
      resetMaxCycleReviewRefs: reviewReset.refs
    });
    await updateRunSession(workspace, session.sessionId, {
      phase: "running",
      autoRun: {
        desktopRunId: runId,
        stepCount: 0,
        parallel: manifest.execution.parallel.enabled,
        executorOverride: null,
        effectiveExecutor: null,
        agentId: null,
        runnerKind: null,
        stopReason: null
      },
      error: null
    });
    await appendRunSessionEvent(workspace, session.sessionId, "run_started", {
      phase: "running",
      desktopRunId: runId,
      scope,
      resetMaxCycleReviewRefs: reviewReset.refs
    });
    emitAutoRunChanged(state, "run_started");
    return cloneAutoRunState(state);
  } catch (error) {
    let initializationError = error;
    if (reviewReset !== null) {
      try {
        await reviewReset.rollback();
      } catch (rollbackError) {
        initializationError = new AggregateError(
          [error, rollbackError],
          `Auto Run '${runId}' initialization failed and review retry state rollback did not complete.`
        );
      }
    }
    return rollbackAutoRunInitialization({
      workspace,
      runId,
      sessionId,
      previousPointer,
      originalError: initializationError
    });
  }
}

export async function startAutoRun(
  projectRoot: string,
  canvasId: string | null | undefined,
  scope: DesktopAutoRunScope = { kind: "project" },
  stepLimit = 20,
  options?: DesktopAutoRunOptions
): Promise<DesktopAutoRunState> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  const state = await withCanvasLock(dirname(workspace.stateFile), () =>
    initializeAutoRunUnderCanvasLock(workspace, projectRoot, canvasId, scope, stepLimit, options)
  );
  launchInitializedAutoRun(state.runId);
  return state;
}

export function launchInitializedAutoRun(runId: string): void {
  launchRunLoop(runId);
}

export async function pauseAutoRun(runId: string): Promise<DesktopAutoRunState> {
  if (!runs.has(runId)) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  return cloneAutoRunState(
    await setState(
      runId,
      { phase: "pausing" },
      "pause_requested",
      {},
      (authority) => authority.phase === "running"
    )
  );
}

export async function resumeAutoRun(runId: string): Promise<DesktopAutoRunState> {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  if (!runAbortControllers.has(runId)) {
    runAbortControllers.set(runId, new AbortController());
  }
  if (!runCliAbortControllers.has(runId)) {
    runCliAbortControllers.set(runId, new AbortController());
  }
  const state = await setState(
    runId,
    { phase: "running", error: null },
    "run_resumed",
    {},
    (authority) => authority.phase === "paused" || authority.phase === "pausing"
  );
  if (state.phase === "running") launchRunLoop(runId);
  return cloneAutoRunState(state);
}

export async function stopAutoRun(runId: string): Promise<DesktopAutoRunState> {
  const pendingStop = stopOperations.get(runId);
  if (pendingStop) {
    return cloneAutoRunState(await pendingStop);
  }
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  if (current.phase === "stopped") {
    return cloneAutoRunState(current);
  }
  stopIntents.add(runId);
  const stopOperation = (async () => {
    const latest = runs.get(runId);
    if (!latest) {
      throw new Error(`Auto Run '${runId}' does not exist.`);
    }
    if (latest.phase === "stopped") {
      return latest;
    }
    const loopOperation = runLoopOperations.get(runId);
    let killed: string[] = [];
    let tmuxCleanupError: unknown;
    try {
      killed = isInFlightAutoRunPhase(latest.phase) ? await killTmuxSessionsForRun(runId) : [];
    } catch (error) {
      tmuxCleanupError = error;
    }
    let agentCleanupError: unknown;
    try {
      await shutdownDesktopAgentRun(runId, "Desktop Auto Run stopped.");
    } catch (error) {
      agentCleanupError = error;
    } finally {
      runAbortControllers.get(runId)?.abort(new Error("Desktop Auto Run stopped."));
    }
    if (agentCleanupError !== undefined && tmuxCleanupError !== undefined) {
      throw new AggregateError(
        [agentCleanupError, tmuxCleanupError],
        `Auto Run '${runId}' Agent and tmux cleanup did not complete cleanly.`
      );
    }
    if (agentCleanupError !== undefined) throw agentCleanupError;
    if (tmuxCleanupError !== undefined) throw tmuxCleanupError;
    let stopped: DesktopAutoRunState | undefined;
    let terminalError: unknown;
    try {
      stopped = await setState(runId, { phase: "stopped" }, "run_stopped", {
        killedTmuxSessions: killed
      });
    } catch (error) {
      terminalError = error;
    }
    let loopError: unknown;
    if (loopOperation && !loopOperation.inFlight) {
      try {
        await loopOperation.result;
      } catch (error) {
        loopError = loopOperation.error ?? error;
      } finally {
        await loopOperation.handled;
        if (runLoopOperations.get(runId) === loopOperation) {
          runLoopOperations.delete(runId);
        }
      }
    }
    if (terminalError !== undefined && loopError !== undefined) {
      throw new AggregateError(
        [terminalError, loopError],
        `Desktop Auto Run '${runId}' stop and loop settlement both failed.`
      );
    }
    if (terminalError !== undefined) throw terminalError;
    if (loopError !== undefined) throw loopError;
    if (!stopped) throw new Error(`Desktop Auto Run '${runId}' did not persist its stopped state.`);
    return stopped;
  })();
  stopOperations.set(runId, stopOperation);
  try {
    return cloneAutoRunState(await stopOperation);
  } finally {
    if (stopOperations.get(runId) === stopOperation) {
      stopOperations.delete(runId);
    }
    stopIntents.delete(runId);
  }
}

export async function shutdownDesktopAutoRuns(
  reason = "PlanWeave Desktop is shutting down."
): Promise<void> {
  const runIds = new Set([
    ...runLoopOperations.keys(),
    ...[...runs.values()].filter((run) => isRunIdConflictProtected(run)).map((run) => run.runId)
  ]);
  const loopOperations = [...runIds].flatMap((runId) => {
    const operation = runLoopOperations.get(runId);
    return operation ? [{ runId, operation }] : [];
  });
  for (const runId of runIds) {
    runAbortControllers.get(runId)?.abort(new Error(reason));
    runCliAbortControllers.get(runId)?.abort(new Error(reason));
  }
  const stopResults = await Promise.allSettled([...runIds].map((runId) => stopAutoRun(runId)));
  const loopResults = await Promise.allSettled(
    loopOperations.map(({ operation }) => operation.result)
  );
  await Promise.all(loopOperations.map(({ operation }) => operation.handled));
  for (const { runId, operation } of loopOperations) {
    if (runLoopOperations.get(runId) === operation) {
      runLoopOperations.delete(runId);
    }
  }
  const agentCleanup = await Promise.allSettled([activeAgentRunRegistry.shutdown(reason)]);
  const failures = [...stopResults, ...loopResults, ...agentCleanup].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Desktop Auto Run shutdown did not complete cleanly.");
  }
}

export async function resetDesktopRuntimeState(
  projectRoot: string,
  canvasId: string | null | undefined,
  options: DesktopRuntimeResetOptions = {}
): Promise<DesktopRuntimeResetResult> {
  const normalizedCanvasId = canvasId ?? null;
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, normalizedCanvasId);
  const session = await createRunSession({
    projectRoot: workspace,
    kind: "reset",
    trigger: "desktop",
    phase: "resetting"
  });
  let stoppedAutoRunIds: string[] = [];

  try {
    const activeRunIds = activeResetTargetAutoRunIds(projectRoot, normalizedCanvasId);
    if (activeRunIds.length > 0) {
      throw new Error(
        `Cannot reset runtime state while Auto Run is active (${activeRunIds.join(", ")}). Stop Auto Run and wait for the current step to settle first.`
      );
    }
    if (options.force === true) {
      stoppedAutoRunIds = await stopResetTargetAutoRuns(projectRoot, normalizedCanvasId);
    }
    const reset = await resetRuntimeState({
      projectRoot: workspace,
      force: options.force,
      reason: options.reason,
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

export async function getLatestAutoRunSummaryWithDiagnostics(
  projectRoot: string,
  canvasId?: string | null
): Promise<DesktopLatestAutoRunSummary> {
  const normalizedCanvasId = canvasId ?? null;
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, normalizedCanvasId);
  const latest = [...runs.values()]
    .filter((run) => run.projectRoot === projectRoot && run.canvasId === normalizedCanvasId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  const { state: persistedLatest, diagnostics } = await readLatestPersistedAutoRunState(workspace, {
    hasActiveLoop: (runId) => activeLoops.has(runId),
    matches: (run) =>
      (run.projectRoot === projectRoot || run.projectRoot === workspace.rootPath) &&
      run.canvasId === normalizedCanvasId
  });

  // Always recover pending transitions before returning — memory hits must not skip healing.
  const recoveryTargets = new Set<string>();
  if (latest) recoveryTargets.add(latest.runId);
  if (persistedLatest) recoveryTargets.add(persistedLatest.runId);
  // Also scan for unreadable/incomplete intents on other runs (start-gate / diagnostics).
  try {
    const remaining = await recoverAllPendingTransitions(
      workspace,
      () => listRunDirectories(workspace),
      (rid) => runs.get(rid) ?? null,
      {
        buildSessionSummary: buildAutoRunSessionSummary,
        onRecoveredAuthority: (authority) => runs.set(authority.runId, authority)
      }
    );
    for (const d of remaining) {
      diagnostics.push(transitionValidationIssue(d));
    }
  } catch (e) {
    diagnostics.push({
      code: "auto_run_transition_recovery_error",
      message: `Transition recovery error: ${e instanceof Error ? e.message : String(e)}`
    });
  }
  // Targeted recover for known latest (covers race where directory list lagged)
  for (const runId of recoveryTargets) {
    try {
      const rec = await recoverPendingTransition(workspace, runId, (rid) => runs.get(rid) ?? null, {
        buildSessionSummary: buildAutoRunSessionSummary
      });
      if (rec.recovered && rec.authorityState) {
        runs.set(runId, rec.authorityState);
      }
      for (const d of rec.diagnostics) {
        if (!diagnostics.some((x) => x.code === d.code && x.message === d.message)) {
          diagnostics.push(transitionValidationIssue(d));
        }
      }
    } catch (e) {
      diagnostics.push({
        code: "auto_run_transition_recovery_error",
        message: `Transition recovery error for '${runId}': ${e instanceof Error ? e.message : String(e)}`
      });
    }
  }

  if (latest) {
    return { state: cloneAutoRunState(runs.get(latest.runId) ?? latest), diagnostics };
  }
  if (!persistedLatest) {
    return { state: null, diagnostics };
  }
  // Re-read after recovery so process-interrupt derivation runs after intent healing.
  const { state: refreshed } = await readLatestPersistedAutoRunState(workspace, {
    hasActiveLoop: (runId) => activeLoops.has(runId),
    matches: (run) =>
      (run.projectRoot === projectRoot || run.projectRoot === workspace.rootPath) &&
      run.canvasId === normalizedCanvasId
  });
  const display = refreshed ?? persistedLatest;
  const state = canRehydratePersistedRun(display)
    ? rehydratePersistedRun(display, workspace)
    : display;
  return { state: cloneAutoRunState(state), diagnostics };
}

export async function getLatestAutoRunSummary(
  projectRoot: string,
  canvasId?: string | null
): Promise<DesktopAutoRunState | null> {
  return (await getLatestAutoRunSummaryWithDiagnostics(projectRoot, canvasId)).state;
}

export async function hasNonTerminalAutoRunForTarget(
  projectRoot: string,
  canvasId?: string | null
): Promise<boolean> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  return hasAutoRunInWorkspace(workspace);
}

/**
 * Whether the workspace already has a non-terminal Auto Run that owns it.
 * Phase ownership is decided solely by {@link isNonTerminalAutoRunPhase}.
 * `activeLoops` is additional in-process loop evidence and must not redefine phase meaning.
 */
async function hasAutoRunInWorkspace(workspace: ProjectWorkspace): Promise<boolean> {
  // Pending transition evidence must be inspected before any other start-gate result so
  // diagnostics retain the transition identity even when authority state is unreadable.
  const remaining = await recoverAllPendingTransitions(
    workspace,
    () => listRunDirectories(workspace),
    (rid) => runs.get(rid) ?? null,
    {
      buildSessionSummary: buildAutoRunSessionSummary,
      onRecoveredAuthority: (authority) => runs.set(authority.runId, authority)
    }
  );
  const blocking = remaining.filter(
    (d) =>
      d.code === "auto_run_pending_transition_unreadable" ||
      d.code === "auto_run_pending_transition_incomplete" ||
      d.code === "auto_run_authority_state_unreadable" ||
      d.code.includes("heal_failed")
  );
  if (blocking.length > 0) {
    throw new Error(
      `Cannot start Auto Run because pending transition evidence is unreadable or unrecovered: ${blocking
        .map((d) => d.message)
        .join("; ")}`
    );
  }

  const targetStateFile = resolve(workspace.stateFile);
  if (
    [...runs.values()].some((run) => {
      const runWorkspace = runWorkspaces.get(run.runId);
      return (
        runWorkspace !== undefined &&
        resolve(runWorkspace.stateFile) === targetStateFile &&
        (isNonTerminalAutoRunPhase(run.phase) || activeLoops.has(run.runId))
      );
    })
  ) {
    return true;
  }
  const persisted = await listPersistedAutoRunStatesWithDiagnostics(workspace, {
    hasActiveLoop: (runId) => activeLoops.has(runId)
  });
  if (persisted.diagnostics.length > 0) {
    throw new Error(
      `Cannot start Auto Run because persisted Auto Run state is unreadable: ${persisted.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`
    );
  }

  return persisted.states.some((state) => isNonTerminalAutoRunPhase(state.phase));
}

export async function getDesktopRuntimeRefresh(
  ref: DesktopCanvasReference
): Promise<DesktopRuntimeRefreshSnapshot> {
  const summary = await getLatestAutoRunSummaryWithDiagnostics(ref.projectRoot, ref.canvasId);
  return {
    latestAutoRun: summary.state,
    diagnostics: summary.diagnostics,
    errors: summary.diagnostics.map(formatDesktopDiagnostic)
  };
}

export async function listAutoRunEvents(
  projectRoot: PackageWorkspaceRef,
  canvasId: string | null | undefined,
  runId: string
): Promise<DesktopAutoRunEventLog> {
  const workspace =
    typeof projectRoot === "string"
      ? await resolveTaskCanvasWorkspace(projectRoot, canvasId)
      : projectRoot;
  return readPersistedAutoRunEventLog(workspace, runId);
}

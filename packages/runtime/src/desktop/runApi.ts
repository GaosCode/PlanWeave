import { join } from "node:path";
import { killActiveTmuxSessions } from "../autoRun/tmuxExecutor.js";
import { runAutoRunStep } from "../taskManager/autoRun.js";
import { resetMaxCycleReviewsForRetry } from "../taskManager/reviewRetry.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopAutoRunEventListener, DesktopAutoRunOptions, DesktopAutoRunScope, DesktopAutoRunState } from "./types.js";
import { appendAutoRunEvent, autoRunRoot, cloneAutoRunState, createAutoRunEvent, nextRunId, now, writeAutoRunState } from "./runStateStore.js";
import { claimRef, claimScope, executorName, latestStatus, outputSummary, phaseAfterStep, terminalPatch } from "./runStepState.js";

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
  const next = { ...current, ...patch, updatedAt: now() };
  const immediateVisibility = eventType === "pause_requested" || eventType === "run_stopped";
  if (immediateVisibility) {
    runs.set(runId, next);
  }
  await writeAutoRunState(next);
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
  return next;
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
          tmuxEnabled: current.options.tmuxEnabled
        });
        const { record, warnings } = await latestStatus(workspace);
        const patch = terminalPatch(step, warnings);
        const afterStep = runs.get(runId);
        if (!afterStep || afterStep.phase === "stopped") {
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
          { stepKind: step.kind, pausedAfterStep: afterStep.phase === "pausing" }
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
  }
}

function launchRunLoop(runId: string): void {
  void runLoop(runId);
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
  const runId = nextRunId();
  const root = autoRunRoot(workspace, runId);
  const timestamp = now();
  const state: DesktopAutoRunState = {
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
  };
  runs.set(runId, state);
  runWorkspaces.set(runId, workspace);
  await writeAutoRunState(state);
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
  const killed = current.phase === "running" || current.phase === "pausing" ? await killActiveTmuxSessions() : [];
  const stopped = await setState(runId, { phase: "stopped" }, "run_stopped", { killedTmuxSessions: killed });
  runWorkspaces.delete(runId);
  return cloneAutoRunState(stopped);
}

export async function getAutoRunState(runId: string): Promise<DesktopAutoRunState> {
  const state = runs.get(runId);
  if (!state) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  return cloneAutoRunState(state);
}

export async function getLatestAutoRunSummary(projectRoot: string, canvasId?: string | null): Promise<DesktopAutoRunState | null> {
  const latest = [...runs.values()]
    .filter((run) => run.projectRoot === projectRoot && run.canvasId === (canvasId ?? null))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  return latest ? cloneAutoRunState(latest) : null;
}

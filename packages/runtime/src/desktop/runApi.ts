import { getAutoRunStatus, runAutoRunStep } from "../taskManager/autoRun.js";
import type { AutoRunStepResult, ClaimScope } from "../types.js";
import type { DesktopAutoRunScope, DesktopAutoRunState } from "./types.js";

const runs = new Map<string, DesktopAutoRunState>();
let nextRunNumber = 1;

function now(): string {
  return new Date().toISOString();
}

function nextRunId(): string {
  return `DESKTOP-RUN-${String(nextRunNumber++).padStart(4, "0")}`;
}

function clone(state: DesktopAutoRunState): DesktopAutoRunState {
  const endTime = state.phase === "running" ? Date.now() : Date.parse(state.updatedAt);
  return {
    ...state,
    elapsedMs: Math.max(0, endTime - Date.parse(state.startedAt)),
    scope: { ...state.scope }
  };
}

function setState(runId: string, patch: Partial<DesktopAutoRunState>): DesktopAutoRunState {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  const next = { ...current, ...patch, updatedAt: now() };
  runs.set(runId, next);
  return next;
}

function claimRef(step: AutoRunStepResult): string | null {
  if (step.kind === "submitted" || step.kind === "manual") {
    return step.claim.kind === "block" ? step.claim.ref : null;
  }
  if (step.kind === "blocked") {
    return step.claim.kind === "blocked" ? step.claim.ref ?? null : null;
  }
  if (step.kind === "batch_submitted") {
    return step.claim.refs[0] ?? null;
  }
  return null;
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
    return "stdout" in step.adapterResult ? step.adapterResult.stdout?.trim().slice(0, 300) || null : null;
  }
  if (step.kind === "manual") {
    return step.adapterResult.nextCommand;
  }
  if (step.kind === "batch_submitted") {
    return `${step.steps.length} block(s) submitted.`;
  }
  if (step.kind === "blocked") {
    return step.claim.kind === "blocked" ? step.claim.reason : "Auto Run blocked.";
  }
  if (step.kind === "idle") {
    return step.claim.kind === "none" ? step.claim.reason ?? "No claimable work." : "No claimable work.";
  }
  return null;
}

function terminalPatch(step: AutoRunStepResult): Partial<DesktopAutoRunState> | null {
  if (step.kind === "idle") {
    return { phase: "completed" };
  }
  if (step.kind === "blocked") {
    return { phase: "blocked", error: step.claim.kind === "blocked" ? step.claim.reason : "Auto Run blocked." };
  }
  if (step.kind === "manual") {
    return { phase: "manual" };
  }
  if (step.kind === "batch") {
    return { phase: "blocked", error: "Parallel batch was not submitted." };
  }
  return null;
}

async function latestRecord(projectRoot: string): Promise<{ recordId: string; path: string } | null> {
  const status = await getAutoRunStatus({ projectRoot });
  const latestRun = status.latestRuns[0];
  if (!latestRun) {
    return null;
  }
  return {
    recordId: `${latestRun.ref}::${latestRun.runId}`,
    path: latestRun.metadataPath
  };
}

function claimScope(scope: DesktopAutoRunScope): ClaimScope {
  if (scope.kind === "task") {
    return { kind: "task", taskId: scope.taskId };
  }
  if (scope.kind === "block") {
    return { kind: "block", blockRef: scope.blockRef };
  }
  return { kind: "project" };
}

async function runLoop(runId: string): Promise<void> {
  while (true) {
    const current = runs.get(runId);
    if (!current || current.phase !== "running") {
      return;
    }
    if (current.stepCount >= current.stepLimit) {
      setState(runId, { phase: "paused", error: "Step limit reached." });
      return;
    }
    try {
      const step = await runAutoRunStep({ projectRoot: current.projectRoot, scope: claimScope(current.scope) });
      const patch = terminalPatch(step);
      const record = await latestRecord(current.projectRoot);
      setState(runId, {
        stepCount: current.stepCount + 1,
        currentRef: claimRef(step),
        currentExecutor: executorName(step),
        latestOutputSummary: outputSummary(step),
        latestRecordId: record?.recordId ?? null,
        latestRecordPath: record?.path ?? null,
        ...(patch ?? {})
      });
    } catch (error) {
      setState(runId, {
        phase: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  }
}

export async function startAutoRun(
  projectRoot: string,
  scope: DesktopAutoRunScope = { kind: "project" },
  stepLimit = 20
): Promise<DesktopAutoRunState> {
  const runId = nextRunId();
  const state: DesktopAutoRunState = {
    runId,
    projectRoot,
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
    error: null,
    startedAt: now(),
    updatedAt: now()
  };
  runs.set(runId, state);
  void runLoop(runId);
  return clone(state);
}

export async function pauseAutoRun(runId: string): Promise<DesktopAutoRunState> {
  return clone(setState(runId, { phase: "paused" }));
}

export async function resumeAutoRun(runId: string): Promise<DesktopAutoRunState> {
  const state = setState(runId, { phase: "running", error: null });
  void runLoop(runId);
  return clone(state);
}

export async function stopAutoRun(runId: string): Promise<DesktopAutoRunState> {
  return clone(setState(runId, { phase: "stopped" }));
}

export async function getAutoRunState(runId: string): Promise<DesktopAutoRunState> {
  const state = runs.get(runId);
  if (!state) {
    throw new Error(`Auto Run '${runId}' does not exist.`);
  }
  return clone(state);
}

export async function getLatestAutoRunSummary(projectRoot: string): Promise<DesktopAutoRunState | null> {
  const latest = [...runs.values()]
    .filter((run) => run.projectRoot === projectRoot)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  return latest ? clone(latest) : null;
}

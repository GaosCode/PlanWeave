import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopAutoRunEvent, DesktopAutoRunState } from "./types.js";
import { isInFlightAutoRunPhase } from "./autoRunPhasePolicy.js";

export function now(): string {
  return new Date().toISOString();
}

export function cloneAutoRunState(state: DesktopAutoRunState): DesktopAutoRunState {
  const endTime = isInFlightAutoRunPhase(state.phase)
    ? Date.now()
    : Date.parse(state.updatedAt);
  return {
    ...state,
    elapsedMs: Math.max(0, endTime - Date.parse(state.startedAt)),
    scope: { ...state.scope },
    options: { ...state.options },
    explanation: {
      ...state.explanation,
      nextAction: { ...state.explanation.nextAction }
    }
  };
}

export function createAutoRunEvent(
  state: DesktopAutoRunState,
  eventType: string
): DesktopAutoRunEvent {
  const clonedState = cloneAutoRunState(state);
  return {
    projectRoot: clonedState.projectRoot,
    canvasId: clonedState.canvasId,
    runId: clonedState.runId,
    phase: clonedState.phase,
    state: clonedState,
    currentRef: clonedState.currentRef,
    latestRecordId: clonedState.latestRecordId,
    latestRecordPath: clonedState.latestRecordPath,
    eventType,
    triggeredAt: now()
  };
}

export function autoRunRoot(workspace: ProjectWorkspace, runId: string): string {
  return join(workspace.resultsDir, "auto-runs", runId);
}

export async function writeAutoRunState(state: DesktopAutoRunState): Promise<void> {
  await mkdir(dirname(state.statePath), { recursive: true });
  await writeJsonFile(state.statePath, cloneAutoRunState(state));
}

export async function appendAutoRunEvent(
  state: DesktopAutoRunState,
  type: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await mkdir(dirname(state.eventLogPath), { recursive: true });
  await appendFile(
    state.eventLogPath,
    `${JSON.stringify({
      timestamp: now(),
      runId: state.runId,
      type,
      phase: state.phase,
      stepCount: state.stepCount,
      currentRef: state.currentRef,
      ...data
    })}\n`,
    "utf8"
  );
}

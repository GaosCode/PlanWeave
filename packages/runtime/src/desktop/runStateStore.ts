import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopAutoRunState } from "./types.js";

let nextRunNumber = 1;

export function now(): string {
  return new Date().toISOString();
}

export function nextRunId(): string {
  return `DESKTOP-RUN-${String(nextRunNumber++).padStart(4, "0")}`;
}

export function cloneAutoRunState(state: DesktopAutoRunState): DesktopAutoRunState {
  const endTime = state.phase === "running" || state.phase === "pausing" ? Date.now() : Date.parse(state.updatedAt);
  return {
    ...state,
    elapsedMs: Math.max(0, endTime - Date.parse(state.startedAt)),
    scope: { ...state.scope }
  };
}

export function autoRunRoot(workspace: ProjectWorkspace, runId: string): string {
  return join(workspace.resultsDir, "auto-runs", runId);
}

export async function writeAutoRunState(state: DesktopAutoRunState): Promise<void> {
  await mkdir(dirname(state.statePath), { recursive: true });
  await writeJsonFile(state.statePath, cloneAutoRunState(state));
}

export async function appendAutoRunEvent(state: DesktopAutoRunState, type: string, data: Record<string, unknown> = {}): Promise<void> {
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

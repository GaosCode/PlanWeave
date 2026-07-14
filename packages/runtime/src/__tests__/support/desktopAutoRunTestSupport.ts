import { join } from "node:path";
import { getAutoRunState } from "../../desktop/index.js";
import type { DesktopAutoRunState } from "../../desktop/index.js";
import type { ProjectWorkspace } from "../../types.js";

export function persistedAutoRunState(
  workspace: ProjectWorkspace,
  patch: Partial<Omit<DesktopAutoRunState, "explanation">> = {}
): DesktopAutoRunState {
  const runId = patch.runId ?? "DESKTOP-RUN-0001";
  const runRoot = join(workspace.resultsDir, "auto-runs", runId);
  const state = {
    runId,
    projectRoot: workspace.rootPath,
    canvasId: null,
    scope: { kind: "project" },
    phase: "completed",
    stepCount: 1,
    stepLimit: 20,
    currentRef: "T-001#B-001",
    currentExecutor: "fake-codex",
    elapsedMs: 1250,
    latestOutputSummary: "persisted output",
    latestRecordId: "T-001#B-001::RUN-001",
    latestRecordPath: join(
      workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-001",
      "metadata.json"
    ),
    statePath: join(runRoot, "state.json"),
    eventLogPath: join(runRoot, "events.ndjson"),
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:01.250Z",
    ...patch
  } satisfies Omit<DesktopAutoRunState, "explanation">;
  return {
    ...state,
    explanation: {
      phase: state.phase,
      currentRef: state.currentRef,
      currentExecutor: state.currentExecutor,
      latestRecordId: state.latestRecordId,
      latestRecordPath: state.latestRecordPath,
      latestOutputSummary: state.latestOutputSummary,
      error: state.error,
      nextAction: {
        kind: "review_status",
        message: "Review the final status and latest run record.",
        command: null,
        targetPath: null,
        ref: state.currentRef
      }
    }
  };
}

export async function waitForDesktopAutoRun(
  runId: string,
  predicate: (state: Awaited<ReturnType<typeof getAutoRunState>>) => boolean
) {
  let state = await getAutoRunState(runId);
  for (let attempt = 0; attempt < 500 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getAutoRunState(runId);
  }
  return state;
}

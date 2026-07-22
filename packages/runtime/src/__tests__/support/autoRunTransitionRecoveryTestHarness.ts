import {
  buildExpectedAuthority,
  generateTransitionId,
  type TransitionPersistenceAdapters
} from "../../desktop/autoRunTransition.js";
import { initializeAutoRunUnderCanvasLock, stopAutoRun } from "../../desktop/runApi.js";
import { writePersistedAutoRunState } from "../../desktop/runStateRepository.js";
import { appendAutoRunEvent } from "../../desktop/runStateStore.js";
import type { DesktopAutoRunState } from "../../desktop/types.js";
import { canvasDirFromStateFile, withCanvasLock } from "../../fs/withCanvasLock.js";
import { appendRunSessionEvent, updateRunSession } from "../../runSessions/index.js";
import type { ProjectWorkspace } from "../../types.js";

const startedRunIds = new Set<string>();
const noTmux = { tmuxEnabled: false } as const;

export async function cleanupTransitionTestRuns(): Promise<void> {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
}

export function forgetTransitionTestRun(runId: string): void {
  startedRunIds.delete(runId);
}

export async function initializeTransitionTestRun(
  root: string,
  workspace: ProjectWorkspace
): Promise<DesktopAutoRunState> {
  const run = await withCanvasLock(canvasDirFromStateFile(workspace.stateFile), () =>
    initializeAutoRunUnderCanvasLock(workspace, root, null, { kind: "project" }, 2, noTmux)
  );
  startedRunIds.add(run.runId);
  return run;
}

export function makeIntent(
  run: DesktopAutoRunState,
  nextPhase: DesktopAutoRunState["phase"],
  eventType: string,
  options: {
    transitionId?: string;
    expectedAuthority?: ReturnType<typeof buildExpectedAuthority>;
    extra?: Partial<DesktopAutoRunState>;
  } = {}
) {
  const next = {
    ...run,
    phase: nextPhase,
    updatedAt: options.expectedAuthority?.updatedAt ?? new Date().toISOString(),
    ...options.extra
  };
  const expectedAuthority =
    options.expectedAuthority ?? buildExpectedAuthority({ ...run, ...next, phase: nextPhase });
  return {
    version: 2 as const,
    transitionId: options.transitionId ?? generateTransitionId(),
    runId: run.runId,
    previousPhase: "running" as const,
    nextPhase,
    eventType,
    previousAuthority: buildExpectedAuthority(run),
    expectedAuthority,
    data: { previousPhase: "running", nextPhase },
    createdAt: new Date().toISOString()
  };
}

export async function writeCommittedState(
  run: DesktopAutoRunState,
  phase: DesktopAutoRunState["phase"],
  extra: Partial<DesktopAutoRunState> = {}
): Promise<DesktopAutoRunState> {
  const next = {
    ...run,
    phase,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  await writePersistedAutoRunState(next);
  return next;
}

export function sessionSummaryBuilder(parallel = false) {
  return async (_workspace: ProjectWorkspace, state: DesktopAutoRunState) => ({
    desktopRunId: state.runId,
    stepCount: state.stepCount,
    parallel,
    executorOverride: null,
    effectiveExecutor: state.currentExecutor,
    agentId: null,
    runnerKind: null,
    stopReason: null
  });
}

/** Inject one failure at the selected persistence boundary. */
export function onceFaultAdapters(
  boundary: "writeState" | "appendAutoRunEvent" | "updateSession" | "appendSessionEvent"
): TransitionPersistenceAdapters {
  let failed = false;
  return {
    writeState: async (state) => {
      if (boundary === "writeState" && !failed) {
        failed = true;
        throw new Error("injected writeState failure");
      }
      await writePersistedAutoRunState(state);
    },
    appendAutoRunEvent: async (state, type, data) => {
      if (boundary === "appendAutoRunEvent" && !failed) {
        failed = true;
        throw new Error("injected appendAutoRunEvent failure");
      }
      await appendAutoRunEvent(state, type, data);
    },
    updateSession: async (workspace, sessionId, patch) => {
      if (boundary === "updateSession" && !failed) {
        failed = true;
        throw new Error("injected updateSession failure");
      }
      return updateRunSession(workspace, sessionId, patch);
    },
    appendSessionEvent: async (workspace, sessionId, eventType, data) => {
      if (boundary === "appendSessionEvent" && !failed) {
        failed = true;
        throw new Error("injected appendSessionEvent failure");
      }
      await appendRunSessionEvent(workspace, sessionId, eventType, data);
    }
  };
}

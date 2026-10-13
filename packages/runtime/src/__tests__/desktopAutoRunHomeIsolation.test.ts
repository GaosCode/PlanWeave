import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAutoRunState,
  getLatestAutoRunSummary,
  getLatestAutoRunSummaryWithDiagnostics,
  pauseAutoRun,
  resetDesktopRuntimeState,
  resolveTaskCanvasWorkspace,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import { createRunSession } from "../runSessions/index.js";
import { mutateAutoRunTransition } from "../desktop/autoRunTransition.js";
import { clearLatestAutoRunStateSelection } from "../desktop/runStatePointer.js";

vi.mock("../runSessions/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runSessions/index.js")>();
  return { ...actual, createRunSession: vi.fn(actual.createRunSession) };
});
vi.mock("../desktop/autoRunTransition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktop/autoRunTransition.js")>();
  return { ...actual, mutateAutoRunTransition: vi.fn(actual.mutateAutoRunTransition) };
});

vi.mock("../desktop/runStatePointer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktop/runStatePointer.js")>();
  return {
    ...actual,
    clearLatestAutoRunStateSelection: vi.fn(actual.clearLatestAutoRunStateSelection)
  };
});

import { writePersistedAutoRunState } from "../desktop/runStateRepository.js";
import { initWorkspace } from "../initWorkspace.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import {
  persistedAutoRunState,
  waitForDesktopAutoRun
} from "./support/desktopAutoRunTestSupport.js";

const startedRunIds = new Set<string>();

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function homesWithPausedRun() {
  const { root, home: homeA } = await createTestWorkspace(basicManifest());
  const homeB = await mkdtemp(join(tmpdir(), "planweave-auto-run-home-b-"));
  await initWorkspace({ projectRoot: root, planweaveHome: homeB });
  const started = await startAutoRun(root, "default", { kind: "project" }, 0, {
    tmuxEnabled: false
  });
  startedRunIds.add(started.runId);
  const runA = await waitForDesktopAutoRun(started.runId, (state) => state.phase === "paused");
  expect(runA.phase).toBe("paused");
  process.env.PLANWEAVE_HOME = homeB;
  const workspaceB = await resolveTaskCanvasWorkspace(root, "default");
  return { root, homeA, homeB, runA, workspaceB };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// An ordering barrier must fail promptly if the real persistence boundary is never reached.
async function reached(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Persistence boundary was not reached.")), 5000);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("Auto Run Home memory ownership", () => {
  it("does not clear a new Home owner after reset waits to clear its previous terminal run", async () => {
    const { root, homeA, runA, workspaceB } = await homesWithPausedRun();
    await stopAutoRun(runA.runId);
    const pausedB = persistedAutoRunState(workspaceB, {
      runId: runA.runId,
      projectRoot: root,
      canvasId: "default",
      phase: "paused",
      stepCount: 0,
      stepLimit: 0,
      currentRef: null,
      currentExecutor: null,
      latestRecordId: null,
      latestRecordPath: null
    });
    await writePersistedAutoRunState(pausedB);
    await expect(getLatestAutoRunSummary(root, "default")).resolves.toMatchObject({
      phase: "paused",
      statePath: pausedB.statePath
    });
    const actualTransitions = await vi.importActual<
      typeof import("../desktop/autoRunTransition.js")
    >("../desktop/autoRunTransition.js");
    await vi.mocked(mutateAutoRunTransition).withImplementation(
      (input) =>
        actualTransitions.mutateAutoRunTransition({
          ...input,
          adapters: {
            appendAutoRunEvent: async () => {
              throw new Error("run_stopped projection interrupted");
            }
          }
        }),
      async () => {
        await expect(stopAutoRun(runA.runId)).rejects.toThrow("run_stopped projection interrupted");
      }
    );
    await expect(getLatestAutoRunSummary(root, "default")).resolves.toMatchObject({
      phase: "stopped",
      statePath: pausedB.statePath
    });
    // Recovery retained the terminal in-process owner even though normal stop releases it.
    await expect(getAutoRunState(runA.runId)).resolves.toMatchObject({
      phase: "stopped",
      statePath: pausedB.statePath
    });
    const entered = deferred();
    const release = deferred();
    const actualPointer = await vi.importActual<typeof import("../desktop/runStatePointer.js")>(
      "../desktop/runStatePointer.js"
    );
    await vi.mocked(clearLatestAutoRunStateSelection).withImplementation(
      async (workspace, highestRunId) => {
        entered.resolve();
        await release.promise;
        return actualPointer.clearLatestAutoRunStateSelection(workspace, highestRunId);
      },
      async () => {
        const resetting = resetDesktopRuntimeState(root, "default", { force: true });
        try {
          await reached(entered.promise);
          process.env.PLANWEAVE_HOME = homeA;
          await writePersistedAutoRunState(runA);
          const restoredA = await getLatestAutoRunSummary(root, "default");
          expect(restoredA).toMatchObject({ phase: "paused", statePath: runA.statePath });
          release.resolve();
          await resetting;
          await expect(getAutoRunState(runA.runId)).resolves.toEqual(restoredA);
          await expect(getLatestAutoRunSummary(root, "default")).resolves.toEqual(restoredA);
          await expect(resumeAutoRun(runA.runId)).resolves.toMatchObject({
            phase: "running",
            statePath: runA.statePath
          });
          const resumed = await waitForDesktopAutoRun(
            runA.runId,
            (state) => state.phase === "paused"
          );
          expect(resumed.statePath).toBe(runA.statePath);
        } finally {
          release.resolve();
          await resetting.catch(() => undefined);
        }
      }
    );
  });

  it("rejects a late start without clearing the other Home's run adopted during initialization", async () => {
    const { root, home: homeA } = await createTestWorkspace(basicManifest());
    const homeB = await mkdtemp(join(tmpdir(), "planweave-auto-run-start-home-b-"));
    await initWorkspace({ projectRoot: root, planweaveHome: homeB });
    const entered = deferred();
    const release = deferred();
    const actual =
      await vi.importActual<typeof import("../runSessions/index.js")>("../runSessions/index.js");
    await vi.mocked(createRunSession).withImplementation(
      async (options) => {
        const session = await actual.createRunSession(options);
        entered.resolve();
        await release.promise;
        return session;
      },
      async () => {
        const starting = startAutoRun(root, "default", { kind: "project" }, 0, {
          tmuxEnabled: false
        });
        const rejected = expect(starting).rejects.toThrow("in another workspace");
        try {
          await reached(entered.promise);
          process.env.PLANWEAVE_HOME = homeB;
          const workspaceB = await resolveTaskCanvasWorkspace(root, "default");
          const pausedB = persistedAutoRunState(workspaceB, {
            runId: "DESKTOP-RUN-0001",
            canvasId: "default",
            phase: "paused",
            currentRef: null,
            currentExecutor: null,
            latestRecordId: null,
            latestRecordPath: null
          });
          await writePersistedAutoRunState(pausedB);
          const adopted = await getLatestAutoRunSummary(root, "default");
          expect(adopted).toMatchObject({
            runId: pausedB.runId,
            statePath: pausedB.statePath,
            phase: "paused"
          });
          startedRunIds.add(pausedB.runId);
          release.resolve();
          await rejected;
          await expect(getAutoRunState(pausedB.runId)).resolves.toEqual(adopted);
          await expect(getLatestAutoRunSummary(root, "default")).resolves.toEqual(adopted);
          process.env.PLANWEAVE_HOME = homeA;
          await expect(getLatestAutoRunSummary(root, "default")).resolves.toBeNull();
          await expect(getAutoRunState(pausedB.runId)).resolves.toEqual(adopted);
        } finally {
          release.resolve();
          await starting.catch(() => undefined);
        }
      }
    );
  });

  it("does not adopt an ID until a queued old-Home control has finished after stop", async () => {
    const { root, runA, workspaceB } = await homesWithPausedRun();
    const pausedB = persistedAutoRunState(workspaceB, {
      runId: runA.runId,
      canvasId: "default",
      phase: "paused",
      stepCount: 0,
      stepLimit: 0,
      currentRef: null,
      currentExecutor: null,
      latestRecordId: null,
      latestRecordPath: null
    });
    await writePersistedAutoRunState(pausedB);
    const entered = deferred();
    const release = deferred();
    const actual = await vi.importActual<typeof import("../desktop/autoRunTransition.js")>(
      "../desktop/autoRunTransition.js"
    );
    await vi.mocked(mutateAutoRunTransition).withImplementation(
      async (input) => {
        if (input.eventType === "pause_requested") {
          entered.resolve();
          await release.promise;
        }
        return actual.mutateAutoRunTransition(input);
      },
      async () => {
        const pausing = pauseAutoRun(runA.runId);
        try {
          await reached(entered.promise);
          await expect(stopAutoRun(runA.runId)).resolves.toMatchObject({
            phase: "stopped",
            statePath: runA.statePath
          });
          await expect(getLatestAutoRunSummary(root, "default")).rejects.toThrow(
            "in another workspace"
          );
          release.resolve();
          await expect(pausing).resolves.toMatchObject({
            phase: "stopped",
            statePath: runA.statePath
          });
          await expect(getLatestAutoRunSummary(root, "default")).resolves.toMatchObject({
            phase: "paused",
            statePath: pausedB.statePath
          });
          await expect(getAutoRunState(runA.runId)).resolves.toMatchObject({
            phase: "paused",
            statePath: pausedB.statePath
          });
        } finally {
          release.resolve();
          await pausing.catch(() => undefined);
        }
      }
    );
  });
  it("does not return another Home's run when this registration has no history", async () => {
    const { root, homeA, runA } = await homesWithPausedRun();
    await expect(getLatestAutoRunSummary(root, "default")).resolves.toBeNull();
    await expect(getAutoRunState(runA.runId)).resolves.toEqual(runA);
    process.env.PLANWEAVE_HOME = homeA;
    await expect(getLatestAutoRunSummary(root, "default")).resolves.toEqual(runA);
  });

  it.each([
    "paused",
    "manual"
  ] as const)("refuses to adopt a persisted %s run ID already owned in another Home", async (phase) => {
    const { root, runA, workspaceB } = await homesWithPausedRun();
    const persistedB = persistedAutoRunState(workspaceB, {
      runId: runA.runId,
      canvasId: "default",
      phase,
      currentRef: null,
      currentExecutor: null,
      latestRecordId: null,
      latestRecordPath: null
    });
    await writePersistedAutoRunState(persistedB);
    await expect(getLatestAutoRunSummaryWithDiagnostics(root, "default")).rejects.toThrow(
      "in another workspace"
    );
    await expect(getAutoRunState(runA.runId)).resolves.toEqual(runA);
  });

  it("allows force reset in an empty Home without stopping or clearing another Home's paused run", async () => {
    const { root, homeA, runA } = await homesWithPausedRun();
    const reset = await resetDesktopRuntimeState(root, "default", { force: true });
    expect(reset.stoppedAutoRunIds).toEqual([]);
    await expect(getAutoRunState(runA.runId)).resolves.toEqual(runA);
    process.env.PLANWEAVE_HOME = homeA;
    await expect(getLatestAutoRunSummary(root, "default")).resolves.toEqual(runA);
    await expect(resumeAutoRun(runA.runId)).resolves.toMatchObject({
      runId: runA.runId,
      phase: "running",
      statePath: runA.statePath
    });
    const resumed = await waitForDesktopAutoRun(runA.runId, (state) => state.phase === "paused");
    expect(resumed.statePath).toBe(runA.statePath);
  });

  it("reads completed history and rehydrates a non-conflicting paused run in the selected Home", async () => {
    const { root, runA, workspaceB } = await homesWithPausedRun();
    const completedB = persistedAutoRunState(workspaceB, {
      runId: runA.runId,
      canvasId: "default",
      phase: "completed"
    });
    await writePersistedAutoRunState(completedB);
    await expect(getLatestAutoRunSummary(root, "default")).resolves.toMatchObject({
      runId: completedB.runId,
      statePath: completedB.statePath,
      phase: "completed"
    });
    const pausedB = persistedAutoRunState(workspaceB, {
      runId: "DESKTOP-RUN-990001",
      canvasId: "default",
      phase: "paused",
      stepCount: 0,
      stepLimit: 0,
      currentRef: null,
      currentExecutor: null,
      latestRecordId: null,
      latestRecordPath: null,
      updatedAt: new Date().toISOString()
    });
    await writePersistedAutoRunState(pausedB);
    await expect(getLatestAutoRunSummary(root, "default")).resolves.toMatchObject({
      runId: pausedB.runId,
      statePath: pausedB.statePath,
      phase: "paused"
    });
    startedRunIds.add(pausedB.runId);
    await expect(resumeAutoRun(pausedB.runId)).resolves.toMatchObject({
      runId: pausedB.runId,
      statePath: pausedB.statePath,
      phase: "running"
    });
    const resumed = await waitForDesktopAutoRun(pausedB.runId, (state) => state.phase === "paused");
    expect(resumed.statePath).toBe(pausedB.statePath);
    await expect(getAutoRunState(runA.runId)).resolves.toEqual(runA);
  });
});

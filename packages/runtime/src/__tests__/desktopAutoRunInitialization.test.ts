import type { PathLike } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsObservations = vi.hoisted(() => ({
  canvasLockAcquisitions: 0,
  failInitializationAt: null as "auto-run-state" | "auto-run-event" | "run-session-event" | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (path: PathLike, ...args: unknown[]) => {
      if (path.toString().endsWith("/.planweave.lock")) {
        fsObservations.canvasLockAcquisitions += 1;
      }
      return actual.mkdir(
        path,
        ...(args as Parameters<typeof actual.mkdir> extends [PathLike, ...infer Rest]
          ? Rest
          : never)
      );
    },
    appendFile: async (path: PathLike, ...args: unknown[]) => {
      if (
        ((fsObservations.failInitializationAt === "auto-run-event" &&
          path.toString().includes("/auto-runs/")) ||
          (fsObservations.failInitializationAt === "run-session-event" &&
            path.toString().includes("/run-sessions/"))) &&
        path.toString().endsWith("/events.ndjson")
      ) {
        throw new Error(`injected ${fsObservations.failInitializationAt} failure`);
      }
      return actual.appendFile(
        path,
        ...(args as Parameters<typeof actual.appendFile> extends [PathLike, ...infer Rest]
          ? Rest
          : never)
      );
    },
    writeFile: async (path: PathLike, ...args: unknown[]) => {
      if (
        fsObservations.failInitializationAt === "auto-run-state" &&
        path.toString().includes("/auto-runs/") &&
        path.toString().includes(".state.json.")
      ) {
        throw new Error("injected auto-run-state failure");
      }
      return actual.writeFile(
        path,
        ...(args as Parameters<typeof actual.writeFile> extends [PathLike, ...infer Rest]
          ? Rest
          : never)
      );
    }
  };
});

import {
  getLatestAutoRunSummary,
  shutdownDesktopAutoRuns,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import { hasNonTerminalAutoRunForTarget } from "../desktop/runApi.js";
import {
  listPersistedAutoRunStates,
  writePersistedAutoRunState
} from "../desktop/runStateRepository.js";
import { listRunDirectories } from "../desktop/runStatePersistence.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { listRunSessions } from "../runSessions/index.js";
import { readState, writeState } from "../state.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import {
  persistedAutoRunState,
  waitForDesktopAutoRun
} from "./support/desktopAutoRunTestSupport.js";

const startedRunIds = new Set<string>();
const noTmux = { tmuxEnabled: false } as const;

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  await shutdownDesktopAutoRuns().catch(() => undefined);
  startedRunIds.clear();
  fsObservations.canvasLockAcquisitions = 0;
  fsObservations.failInitializationAt = null;
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop Auto Run initialization", () => {
  it("serializes concurrent starts without creating two active runs", async () => {
    const { root } = await createTestWorkspace(manifestTestBuilder().build());

    const results = await Promise.allSettled([
      startAutoRun(root, null, { kind: "project" }, 20, noTmux),
      startAutoRun(root, null, { kind: "project" }, 20, noTmux)
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startAutoRun>>> =>
        result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [rejectedStart] = rejected;
    if (!rejectedStart) {
      throw new Error("Expected one concurrent Auto Run start to be rejected");
    }
    expect((rejectedStart.reason as Error).message).toMatch(/active/);
    const [fulfilledStart] = fulfilled;
    if (!fulfilledStart) {
      throw new Error("Expected one concurrent Auto Run start to be fulfilled");
    }
    startedRunIds.add(fulfilledStart.value.runId);
  });

  it.each([
    "paused",
    "manual"
  ] as const)("finds an older persisted %s run even when a newer run is terminal", async (phase) => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0001",
        phase,
        updatedAt: "2026-05-23T00:00:01.000Z"
      })
    );
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0002",
        phase: "completed",
        updatedAt: "2026-05-23T00:00:02.000Z"
      })
    );

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(true);
  });

  it.each([
    "running",
    "pausing"
  ] as const)("recovers a persisted %s run without a live process owner and permits a new start", async (phase) => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0001", phase })
    );

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);
    expect(started.phase).toBe("running");
  });

  it("fails closed when persisted Auto Run state is corrupt", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const corrupt = persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0001" });
    await mkdir(dirname(corrupt.statePath), { recursive: true });
    await writeFile(corrupt.statePath, "{", "utf8");

    await expect(hasNonTerminalAutoRunForTarget(root, null)).rejects.toThrow(
      /persisted Auto Run state is unreadable.*not valid JSON/
    );
    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      /persisted Auto Run state is unreadable.*not valid JSON/
    );
  });

  it("launches the Run Loop after leaving initialization lock context", async () => {
    const { root } = await createTestWorkspace(manifestTestBuilder().build());
    const started = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(started.runId);
    const acquisitionsAfterInitialization = fsObservations.canvasLockAcquisitions;

    await waitForDesktopAutoRun(started.runId, (state) => state.phase !== "running");

    expect(fsObservations.canvasLockAcquisitions).toBeGreaterThan(acquisitionsAfterInitialization);
  });

  it("normalizes explicit default Canvas lookup to the resolved default workspace", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0001",
        canvasId: null,
        phase: "manual"
      })
    );

    await expect(hasNonTerminalAutoRunForTarget(root, "default")).resolves.toBe(true);
  });

  it.each([
    "auto-run-state",
    "auto-run-event",
    "run-session-event"
  ] as const)("rolls back a failed %s initialization write and permits a clean subsequent start", async (failureTarget) => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    fsObservations.failInitializationAt = failureTarget;

    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      `injected ${failureTarget} failure`
    );
    fsObservations.failInitializationAt = null;

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
    await expect(listRunDirectories(init.workspace)).resolves.toEqual([]);
    await expect(listPersistedAutoRunStates(init.workspace)).resolves.toEqual([]);
    await expect(listRunSessions(init.workspace)).resolves.toMatchObject({ sessions: [] });
    await expect(getLatestAutoRunSummary(root, null)).resolves.toBeNull();

    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);
    expect(started.phase).toBe("running");
  });

  it("preserves max-cycle review state when Auto Run initialization fails", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#R-001"] = {
      status: "completed",
      completionReason: "max_cycles_reached"
    };
    await writeState(init.workspace.stateFile, state);
    const taskIndexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    await mkdir(dirname(taskIndexPath), { recursive: true });
    await writeJsonFile(taskIndexPath, {
      reviewCompletionReasonByBlock: { "T-001#R-001": "max_cycles_reached" },
      warnings: [
        {
          code: "review_max_cycles_reached",
          message: "Review reached its maximum feedback cycles.",
          path: "T-001#R-001"
        }
      ]
    });
    fsObservations.failInitializationAt = "run-session-event";

    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      "injected run-session-event failure"
    );

    await expect(readState(init.workspace.stateFile)).resolves.toMatchObject({
      blocks: {
        "T-001#R-001": {
          status: "completed",
          completionReason: "max_cycles_reached"
        }
      }
    });
    await expect(readJsonFile(taskIndexPath)).resolves.toMatchObject({
      reviewCompletionReasonByBlock: { "T-001#R-001": "max_cycles_reached" },
      warnings: [expect.objectContaining({ code: "review_max_cycles_reached" })]
    });
  });
});

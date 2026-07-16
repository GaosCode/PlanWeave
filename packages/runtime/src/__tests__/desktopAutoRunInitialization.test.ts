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
  resetDesktopRuntimeState,
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
    "paused",
    "manual"
  ] as const)(
    "rejects a second start while a persisted %s Auto Run still owns the workspace",
    async (phase) => {
      const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
      await writePersistedAutoRunState(
        persistedAutoRunState(init.workspace, {
          runId: "DESKTOP-RUN-0001",
          phase
        })
      );

      await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(true);
      await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
        /Cannot start Auto Run while another Auto Run is active/
      );

      // Rehydrate via summary so stop can target the recoverable run.
      const summary = await getLatestAutoRunSummary(root, null);
      expect(summary).toMatchObject({ runId: "DESKTOP-RUN-0001", phase });
      if (!summary) {
        throw new Error("Expected recoverable Auto Run summary");
      }
      startedRunIds.add(summary.runId);
      await stopAutoRun(summary.runId);

      await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
      const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
      startedRunIds.add(started.runId);
      expect(started.phase).toBe("running");
    }
  );

  it("rejects a second start while an in-memory paused Auto Run owns the workspace", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('ownership paused ' + input.split('\\n')[0]); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);
    const started = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(started.runId);
    await waitForDesktopAutoRun(started.runId, (state) => state.phase === "paused");

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(true);
    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      /Cannot start Auto Run while another Auto Run is active/
    );

    await stopAutoRun(started.runId);
    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
    const afterStop = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(afterStop.runId);
    expect(afterStop.phase).toBe("running");
  });

  it("rejects a second start while an in-memory manual Auto Run owns the workspace", async () => {
    const { root } = await createTestWorkspace(
      manifestTestBuilder().withDefaultExecutor("manual").build()
    );
    const started = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(started.runId);
    await waitForDesktopAutoRun(started.runId, (state) => state.phase === "manual");

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(true);
    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      /Cannot start Auto Run while another Auto Run is active/
    );

    await stopAutoRun(started.runId);
    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
    const afterStop = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(afterStop.runId);
    expect(afterStop.phase).toBe("running");
  });

  it("rejects a second start when both persisted and in-memory recoverable ownership exist", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0001",
        phase: "paused",
        updatedAt: "2026-05-23T00:00:01.000Z"
      })
    );
    // Rehydrate the persisted recoverable run into memory, then keep it paused.
    const rehydrated = await getLatestAutoRunSummary(root, null);
    expect(rehydrated).toMatchObject({ runId: "DESKTOP-RUN-0001", phase: "paused" });
    if (!rehydrated) {
      throw new Error("Expected rehydrated paused Auto Run");
    }
    startedRunIds.add(rehydrated.runId);

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(true);
    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      /Cannot start Auto Run while another Auto Run is active/
    );
  });

  it("allows a new Auto Run after stop releases a recoverable paused owner", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('stop release ' + input.split('\\n')[0]); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);
    const first = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(first.runId);
    await waitForDesktopAutoRun(first.runId, (state) => state.phase === "paused");

    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      /Cannot start Auto Run while another Auto Run is active/
    );

    await stopAutoRun(first.runId);
    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
    const second = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(second.runId);
    expect(second.phase).toBe("running");
  });

  it("allows a new Auto Run after force-reset stops an in-memory manual owner", async () => {
    const { root } = await createTestWorkspace(
      manifestTestBuilder().withDefaultExecutor("manual").build()
    );
    const first = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(first.runId);
    await waitForDesktopAutoRun(first.runId, (state) => state.phase === "manual");

    await expect(startAutoRun(root, null, { kind: "project" }, 0, noTmux)).rejects.toThrow(
      /Cannot start Auto Run while another Auto Run is active/
    );

    const reset = await resetDesktopRuntimeState(root, null, {
      force: true,
      reason: "clear recoverable auto run for ownership policy test"
    });
    expect(reset.stoppedAutoRunIds).toContain(first.runId);

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);
    expect(started.phase).toBe("running");
  });

  it.each([
    "completed",
    "blocked",
    "failed",
    "stopped"
  ] as const)("allows a new Auto Run when the only persisted owner is terminal %s", async (phase) => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0001",
        phase
      })
    );

    await expect(hasNonTerminalAutoRunForTarget(root, null)).resolves.toBe(false);
    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);
    expect(started.phase).toBe("running");
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

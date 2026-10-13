import { describe, expect, it, vi } from "vitest";
import type { DesktopAutoRunEvent, DesktopAutoRunState } from "@planweave-ai/runtime";
import {
  CLAIM_BUS_STEP_LIMIT_ERROR,
  isClaimBusLocalUnitSuccess,
  runClaimBusLocalAutoRunUnit,
  waitForClaimBusLocalAutoRunUnit,
  waitForLocalAutoRunTerminal
} from "../renderer/collaboration/agentEndpointScopeRun";

function localRunState(
  phase: DesktopAutoRunState["phase"],
  overrides?: Partial<DesktopAutoRunState>
): DesktopAutoRunState {
  return {
    runId: "DESKTOP-RUN-LOCAL",
    projectRoot: "/workspace/project",
    canvasId: "canvas-main",
    scope: { kind: "block", blockRef: "T-001#B-001" },
    phase,
    stepCount: phase === "completed" || phase === "paused" ? 1 : 0,
    stepLimit: 1,
    currentRef: phase === "running" ? "T-001#B-001" : null,
    currentExecutor: phase === "running" ? "codex" : null,
    elapsedMs: 1,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    explanation: {
      phase,
      currentRef: phase === "running" ? "T-001#B-001" : null,
      currentExecutor: phase === "running" ? "codex" : null,
      latestRecordId: null,
      latestRecordPath: null,
      latestOutputSummary: null,
      error: overrides?.error ?? null,
      nextAction: {
        kind: "wait",
        message: "Wait.",
        command: null,
        targetPath: null,
        ref: null
      }
    },
    statePath: "/workspace/run/state.json",
    eventLogPath: "/workspace/run/events.ndjson",
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    ...overrides
  };
}

function localRunEvent(
  state: DesktopAutoRunState,
  workspaceRoot = "/home-b/projects/project"
): DesktopAutoRunEvent {
  return {
    projectRoot: state.projectRoot,
    workspaceRoot,
    planweaveHome: "/home-b",
    canvasId: state.canvasId,
    runId: state.runId,
    phase: state.phase,
    state,
    currentRef: state.currentRef,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    eventType: "phase_change",
    triggeredAt: state.updatedAt
  };
}

describe("waitForLocalAutoRunTerminal", () => {
  it("resolves immediately when the initial state is already terminal", async () => {
    const api = {
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn(() => () => undefined)
    };
    const terminal = await waitForLocalAutoRunTerminal({
      api,
      workspaceRoot: "/home-b/projects/project",
      initial: localRunState("completed")
    });
    expect(terminal.phase).toBe("completed");
    expect(api.getAutoRunState).not.toHaveBeenCalled();
    expect(api.onAutoRunChanged).not.toHaveBeenCalled();
  });

  it("resolves when onAutoRunChanged delivers a terminal state", async () => {
    let listener: ((event: DesktopAutoRunEvent) => void) | null = null;
    const api = {
      getAutoRunState: vi.fn(async () => localRunState("running")),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      })
    };

    const pending = waitForLocalAutoRunTerminal({
      api,
      workspaceRoot: "/home-b/projects/project",
      initial: localRunState("running"),
      fallbackRefreshMs: 60_000
    });

    expect(listener).not.toBeNull();
    listener?.(localRunEvent(localRunState("completed")));

    await expect(pending).resolves.toMatchObject({ phase: "completed" });
  });

  it("ignores a terminal event from another Home with the same root, canvas and run ID", async () => {
    let listener: ((event: DesktopAutoRunEvent) => void) | null = null;
    const api = {
      getAutoRunState: vi.fn(async () => localRunState("running")),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      })
    };
    const pending = waitForLocalAutoRunTerminal({
      api,
      workspaceRoot: "/home-b/projects/project",
      initial: localRunState("running"),
      fallbackRefreshMs: 60_000
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    listener?.(localRunEvent(localRunState("completed"), "/home-a/projects/project"));
    await Promise.resolve();
    expect(settled).toBe(false);
    listener?.(localRunEvent(localRunState("stopped")));
    await expect(pending).resolves.toMatchObject({ phase: "stopped" });
  });

  it("does not settle on paused (step-limit is not a resource-terminal phase)", async () => {
    let listener: ((event: DesktopAutoRunEvent) => void) | null = null;
    const api = {
      getAutoRunState: vi.fn(async () => localRunState("running")),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      })
    };

    const pending = waitForLocalAutoRunTerminal({
      api,
      workspaceRoot: "/home-b/projects/project",
      initial: localRunState("running"),
      fallbackRefreshMs: 60_000
    });
    listener?.(localRunEvent(localRunState("paused", { error: CLAIM_BUS_STEP_LIMIT_ERROR })));

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    listener?.(localRunEvent(localRunState("stopped")));
    await expect(pending).resolves.toMatchObject({ phase: "stopped" });
  });

  it("rejects when aborted before terminal", async () => {
    const controller = new AbortController();
    const api = {
      getAutoRunState: vi.fn(async () => localRunState("running")),
      onAutoRunChanged: vi.fn(() => () => undefined)
    };

    const pending = waitForLocalAutoRunTerminal({
      api,
      workspaceRoot: "/home-b/projects/project",
      initial: localRunState("running"),
      signal: controller.signal,
      fallbackRefreshMs: 60_000
    });
    controller.abort();

    await expect(pending).rejects.toThrow("agent_endpoint_scope_run_cancelled");
  });
});

describe("claim-bus local Auto Run unit semantics", () => {
  it("treats step-limit paused as unit success", () => {
    expect(
      isClaimBusLocalUnitSuccess(
        localRunState("paused", { error: CLAIM_BUS_STEP_LIMIT_ERROR, stepCount: 1 })
      )
    ).toBe(true);
    expect(isClaimBusLocalUnitSuccess(localRunState("completed"))).toBe(true);
    expect(isClaimBusLocalUnitSuccess(localRunState("paused", { error: "other" }))).toBe(false);
    expect(isClaimBusLocalUnitSuccess(localRunState("failed"))).toBe(false);
  });

  it("waitForClaimBusLocalAutoRunUnit settles on step-limit paused", async () => {
    let listener: ((event: DesktopAutoRunEvent) => void) | null = null;
    const api = {
      getAutoRunState: vi.fn(async () => localRunState("running")),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      })
    };

    const pending = waitForClaimBusLocalAutoRunUnit({
      api,
      workspaceRoot: "/home-b/projects/project",
      initial: localRunState("running"),
      fallbackRefreshMs: 60_000
    });
    listener?.(
      localRunEvent(localRunState("paused", { error: CLAIM_BUS_STEP_LIMIT_ERROR, stepCount: 1 }))
    );

    await expect(pending).resolves.toMatchObject({
      phase: "paused",
      error: CLAIM_BUS_STEP_LIMIT_ERROR
    });
  });

  it("runClaimBusLocalAutoRunUnit accepts step-limit pause and stops to free the workspace", async () => {
    const startLocal = vi.fn(async () => localRunState("running"));
    const stopLocal = vi.fn(async () => localRunState("stopped"));
    const waitForUnit = vi.fn(async () =>
      localRunState("paused", { error: CLAIM_BUS_STEP_LIMIT_ERROR, stepCount: 1 })
    );
    const api = {
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn(() => () => undefined)
    };

    const settled = await runClaimBusLocalAutoRunUnit({
      scope: { kind: "block", blockRef: "T-001#B-001" },
      startLocal,
      stopLocal,
      api,
      workspaceRoot: "/home-b/projects/project",
      unitLabel: "T-001#B-001",
      waitForUnit
    });

    expect(startLocal).toHaveBeenCalledWith(
      { kind: "block", blockRef: "T-001#B-001" },
      { stepLimit: 1 }
    );
    expect(waitForUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ phase: "running", runId: "DESKTOP-RUN-LOCAL" })
      })
    );
    expect(stopLocal).toHaveBeenCalledWith("DESKTOP-RUN-LOCAL", "/workspace/run/state.json");
    expect(settled).toMatchObject({
      phase: "paused",
      error: CLAIM_BUS_STEP_LIMIT_ERROR
    });
  });

  it("runClaimBusLocalAutoRunUnit allows a second start after stop releases paused ownership", async () => {
    let workspaceOwned = false;
    const startLocal = vi.fn(async () => {
      if (workspaceOwned) {
        throw new Error("Cannot start Auto Run while another Auto Run is active.");
      }
      workspaceOwned = true;
      return localRunState("running");
    });
    const stopLocal = vi.fn(async () => {
      workspaceOwned = false;
      return localRunState("stopped");
    });
    const waitForUnit = vi.fn(async () =>
      localRunState("paused", { error: CLAIM_BUS_STEP_LIMIT_ERROR, stepCount: 1 })
    );
    const api = {
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn(() => () => undefined)
    };

    await runClaimBusLocalAutoRunUnit({
      scope: { kind: "block", blockRef: "T-001#B-001" },
      startLocal,
      stopLocal,
      api,
      workspaceRoot: "/home-b/projects/project",
      unitLabel: "T-001#B-001",
      waitForUnit
    });
    await runClaimBusLocalAutoRunUnit({
      scope: { kind: "block", blockRef: "T-001#B-002" },
      startLocal,
      stopLocal,
      api,
      workspaceRoot: "/home-b/projects/project",
      unitLabel: "T-001#B-002",
      waitForUnit
    });

    expect(startLocal).toHaveBeenCalledTimes(2);
    expect(stopLocal).toHaveBeenCalledTimes(2);
    expect(workspaceOwned).toBe(false);
  });

  it("runClaimBusLocalAutoRunUnit fails failed phase after best-effort stop", async () => {
    const startLocal = vi.fn(async () => localRunState("running"));
    const stopLocal = vi.fn(async () => localRunState("stopped"));
    const waitForUnit = vi.fn(async () => localRunState("failed", { error: "executor blew up" }));
    const api = {
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn(() => () => undefined)
    };

    await expect(
      runClaimBusLocalAutoRunUnit({
        scope: { kind: "block", blockRef: "T-001#B-001" },
        startLocal,
        stopLocal,
        api,
        workspaceRoot: "/home-b/projects/project",
        unitLabel: "T-001#B-001",
        waitForUnit
      })
    ).rejects.toThrow("local_agent_unit_failed:T-001#B-001");
    // failed is resource-terminal; stop not required for ownership release
    expect(stopLocal).not.toHaveBeenCalled();
  });
});

describe("captured local run ownership", () => {
  it.each([
    "statePath",
    "eventLogPath",
    "projectRoot",
    "canvasId",
    "runId"
  ] as const)("rejects a poll whose %s no longer belongs to the started run before releasing its ID", async (field) => {
    const started = localRunState("running");
    const replacement = localRunState("paused", {
      error: CLAIM_BUS_STEP_LIMIT_ERROR,
      [field]: `other-${field}`
    });
    const stopLocal = vi.fn(async () => undefined);
    await expect(
      runClaimBusLocalAutoRunUnit({
        scope: started.scope,
        startLocal: async () => started,
        stopLocal,
        workspaceRoot: "/home-b/projects/project",
        unitLabel: "local-unit",
        api: {
          getAutoRunState: async () => replacement,
          onAutoRunChanged: () => () => undefined
        }
      })
    ).rejects.toThrow("auto_run_scope_mismatch");
    expect(stopLocal).toHaveBeenCalledWith(started.runId, started.statePath);
  });

  it.each([
    "statePath",
    "eventLogPath"
  ] as const)("ignores an event with foreign %s", async (field) => {
    let listener!: (event: DesktopAutoRunEvent) => void;
    const started = localRunState("running");
    const pending = waitForClaimBusLocalAutoRunUnit({
      initial: started,
      workspaceRoot: "/home-b/projects/project",
      api: {
        getAutoRunState: async () => started,
        onAutoRunChanged: (callback) => {
          listener = callback;
          return () => undefined;
        }
      },
      fallbackRefreshMs: 60_000
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    listener(localRunEvent(localRunState("paused", { [field]: `other-${field}` })));
    await Promise.resolve();
    expect(settled).toBe(false);
    listener(localRunEvent(localRunState("paused", { error: CLAIM_BUS_STEP_LIMIT_ERROR })));
    await expect(pending).resolves.toMatchObject({ statePath: started.statePath });
  });

  it("ignores a late poll after abort and releases only the captured run once", async () => {
    let finishPoll!: (state: DesktopAutoRunState) => void;
    const poll = new Promise<DesktopAutoRunState>((resolve) => {
      finishPoll = resolve;
    });
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    const stopLocal = vi.fn(async () => undefined);
    const started = localRunState("running");
    const pending = runClaimBusLocalAutoRunUnit({
      scope: started.scope,
      startLocal: async () => started,
      stopLocal,
      workspaceRoot: "/home-b/projects/project",
      unitLabel: "local-unit",
      signal: controller.signal,
      api: { getAutoRunState: () => poll, onAutoRunChanged: () => unsubscribe }
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("agent_endpoint_scope_run_cancelled");
    finishPoll(localRunState("paused", { statePath: "/home-c/run/state.json" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopLocal).toHaveBeenCalledExactlyOnceWith(started.runId, started.statePath);
  });
});

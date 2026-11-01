import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { executeAcp } from "../autoRun/acpExecutionEngine.js";
import type { AcpEngineEvent, ExecuteAcpOptions } from "../autoRun/acpExecutionEngineContracts.js";

const fixture = fileURLToPath(
  new URL("./support/acpInteractionTerminalAgent.mjs", import.meta.url)
);
function options(prompt: string, overrides: Partial<ExecuteAcpOptions> = {}): ExecuteAcpOptions {
  return {
    launch: { trusted: true, command: process.execPath, args: [fixture] },
    workspace: { cwd: process.cwd() },
    env: {},
    clientInfo: { name: "interaction-terminal-test", version: "1" },
    shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 1000 },
    capabilityPolicy: { required: [], optional: [] },
    prompt,
    sessionStart: { kind: "new" },
    limits: { operationTimeoutMs: 5000, interactionTimeoutMs: 100 },
    ...overrides
  };
}

const failedBroker = {
  requestPermission: () => {
    throw new Error("permission unavailable");
  },
  requestElicitation: () => {
    throw new Error("elicitation unavailable");
  }
};

describe("ACP interaction failure terminal ownership", () => {
  it.each([
    "permission",
    "elicitation"
  ])("fails when a real agent catches %s RPC failure and ends normally", async (prompt) => {
    const events: AcpEngineEvent[] = [];
    const lifecycle: string[] = [];
    const result = await executeAcp(
      options(prompt, {
        interactionBroker: failedBroker,
        followUpPrompts: (async function* () {
          yield "success";
        })(),
        eventSink: (event) => {
          events.push(event);
        },
        lifecycleObserver: (event) => {
          lifecycle.push(event.kind);
        }
      })
    );
    expect(result.output).toContain("rpcError");
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_failed" });
    expect(result.cleanup).toEqual({ attempted: true, completed: true });
    expect(events.at(-1)).toMatchObject({ kind: "terminal", terminal: { state: "failed" } });
    expect(lifecycle.filter((kind) => kind === "prompt_starting")).toHaveLength(1);
    expect(lifecycle).not.toContain("prompts_completed");
  });

  it.each([
    "prompt_completed",
    "prompts_completed",
    "usage"
  ])("fails a new permission arriving during the final %s await", async (window) => {
    const requestPermission = vi.fn(() => {
      throw new Error("late permission unavailable");
    });
    const events: AcpEngineEvent[] = [];
    const result = await executeAcp(
      options(window === "usage" ? "late-usage" : "late-permission", {
        interactionBroker: { requestPermission, requestElicitation: () => ({ action: "cancel" }) },
        lifecycleObserver: async (event) => {
          if (event.kind === window) await new Promise((resolve) => setTimeout(resolve, 100));
        },
        eventSink: async (event) => {
          events.push(event);
          if (window === "usage" && event.kind === "usage")
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_failed" });
    expect(events.at(-1)).toMatchObject({ kind: "terminal", terminal: { state: "failed" } });
    expect(result.cleanup.completed).toBe(true);
  });

  it("rejects new requests after final admission closes without calling the broker", async () => {
    let notifyUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      notifyUpdateStarted = resolve;
    });
    const requestPermission = vi.fn(() => {
      throw new Error("late permission must not reach broker");
    });
    const events: AcpEngineEvent[] = [];
    const result = await executeAcp(
      options("late-after-seal", {
        interactionBroker: { requestPermission, requestElicitation: () => ({ action: "cancel" }) },
        lifecycleObserver: async (event) => {
          if (event.kind === "prompts_completed") await updateStarted;
        },
        eventSink: async (event) => {
          events.push(event);
          if (
            event.kind === "session_update" &&
            event.body.kind === "message" &&
            event.body.content === "late-final-update"
          ) {
            notifyUpdateStarted();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      })
    );
    expect(result.stderr.join("")).toContain("late request rejected");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "interaction")).toBe(false);
    expect(result.terminal.state).toBe("succeeded");
    expect(result.cleanup.completed).toBe(true);
  });

  it("does not start a follow-up after a late failure during prompt completion", async () => {
    let promptStarts = 0;
    const result = await executeAcp(
      options("late-permission", {
        followUpPrompts: (async function* () {
          yield "success";
        })(),
        interactionBroker: failedBroker,
        lifecycleObserver: async (event) => {
          if (event.kind === "prompt_starting") promptStarts += 1;
          if (event.kind === "prompt_completed")
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })
    );
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_failed" });
    expect(promptStarts).toBe(1);
  });

  it.each([
    "pending-permission",
    "pending-elicitation"
  ])("waits for %s that the agent did not await", async (prompt) => {
    const failLater = () =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late broker failure")), 50);
      });
    const result = await executeAcp(
      options(prompt, {
        interactionBroker: { requestPermission: failLater, requestElicitation: failLater }
      })
    );
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_failed" });
    expect(result.cleanup.completed).toBe(true);
  });

  it.each([
    "requested",
    "resolved"
  ])("bounds an unawaited interaction whose %s sink never settles", async (state) => {
    const result = await executeAcp(
      options("pending-permission", {
        interactionBroker: {
          requestPermission: () => ({ kind: "cancel" }),
          requestElicitation: () => ({ action: "cancel" })
        },
        eventSink: (event) => {
          if (event.kind === "interaction" && event.state === state) {
            return new Promise<never>(() => undefined);
          }
        }
      })
    );
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_timeout" });
    expect(result.cleanup.completed).toBe(true);
  }, 2000);

  it.each([
    { termination: "timeout", settlement: "resolve" },
    { termination: "timeout", settlement: "reject" },
    { termination: "cancel", settlement: "resolve" },
    { termination: "cancel", settlement: "reject" }
  ])("does not reopen interactions after $termination when a requested sink settles with $settlement", async ({
    termination,
    settlement
  }) => {
    const controller = new AbortController();
    let settle!: () => void;
    const gate = new Promise<void>((resolve, reject) => {
      settle = () =>
        settlement === "resolve" ? resolve() : reject(new Error("late sink rejection"));
    });
    const requestPermission = vi.fn(() => ({ kind: "cancel" as const }));
    const events: AcpEngineEvent[] = [];
    const result = await executeAcp(
      options("pending-permission", {
        signal: controller.signal,
        interactionBroker: { requestPermission, requestElicitation: () => ({ action: "cancel" }) },
        eventSink: (event) => {
          events.push(event);
          if (event.kind === "interaction" && event.state === "requested") {
            if (termination === "cancel")
              controller.abort(new Error("caller stopped pending sink"));
            return gate;
          }
        }
      })
    );
    expect(result.terminal).toMatchObject(
      termination === "cancel"
        ? { state: "cancelled" }
        : { state: "failed", reason: "interaction_timeout" }
    );
    const completedEvents = [...events];
    settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events).toEqual(completedEvents);
    expect(result.cleanup.completed).toBe(true);
  });

  it("cancels an unawaited pending interaction without waiting for its long deadline", async () => {
    const controller = new AbortController();
    const result = await executeAcp(
      options("pending-permission", {
        signal: controller.signal,
        limits: { operationTimeoutMs: 5000, interactionTimeoutMs: 5000 },
        interactionBroker: {
          requestPermission: () => {
            setTimeout(() => controller.abort(new Error("caller stopped pending interaction")), 25);
            return new Promise<never>(() => undefined);
          },
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );
    expect(result.terminal.state).toBe("cancelled");
    expect(result.cleanup.completed).toBe(true);
  }, 2000);

  it("settles an ACP-cancelled prompt without waiting for an unawaited interaction deadline", async () => {
    const result = await executeAcp(
      options("pending-permission-cancelled", {
        limits: { operationTimeoutMs: 5000, interactionTimeoutMs: 5000 },
        interactionBroker: {
          requestPermission: () => new Promise<never>(() => undefined),
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );
    expect(result.terminal.state).toBe("cancelled");
    expect(result.cleanup.completed).toBe(true);
  }, 2000);

  it("fails a later follow-up turn instead of reusing its previous success", async () => {
    const result = await executeAcp(
      options("success", {
        followUpPrompts: (async function* () {
          yield "permission";
        })(),
        interactionBroker: failedBroker
      })
    );
    expect(result.output).toContain("rpcError");
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_failed" });
  });

  it("fails a swallowed permission timeout", async () => {
    const result = await executeAcp(
      options("permission", {
        interactionBroker: {
          requestPermission: () => new Promise<never>(() => undefined),
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_timeout" });
  });

  it.each([
    "permission",
    "elicitation"
  ])("preserves caller cancellation over %s failure", async (prompt) => {
    const controller = new AbortController();
    const fail = () => {
      controller.abort(new Error("caller stopped"));
      throw new Error("broker stopped");
    };
    const result = await executeAcp(
      options(prompt, {
        signal: controller.signal,
        interactionBroker: { requestPermission: fail, requestElicitation: fail }
      })
    );
    expect(result.terminal.state).toBe("cancelled");
    expect(result.cleanup.completed).toBe(true);
  });

  it("preserves the ACP cancelled stop reason over a swallowed failure", async () => {
    const result = await executeAcp(
      options("permission-cancelled", { interactionBroker: failedBroker })
    );
    expect(result.terminal.state).toBe("cancelled");
  });

  it.each([
    "requested",
    "resolved"
  ])("captures a swallowed interaction %s sink failure", async (state) => {
    const result = await executeAcp(
      options("permission", {
        interactionBroker: {
          requestPermission: () => ({ kind: "cancel" }),
          requestElicitation: () => ({ action: "cancel" })
        },
        eventSink: (event) => {
          if (event.kind === "interaction" && event.state === state)
            throw new Error("interaction sink unavailable");
        }
      })
    );
    expect(result.terminal).toMatchObject({ state: "failed", reason: "event_sink_failed" });
  });

  it.each([
    "permission",
    "elicitation",
    "success"
  ])("allows legal %s denial or cancellation and fresh executions", async (prompt) => {
    const result = await executeAcp(
      options(prompt, {
        interactionBroker: {
          requestPermission: () => ({ kind: "select", optionId: "deny" }),
          requestElicitation: () => ({ action: "decline" })
        }
      })
    );
    expect(result.terminal.state).toBe("succeeded");
    expect(result.cleanup.completed).toBe(true);
    if (prompt === "permission") expect(result.output).toContain('"optionId":"deny"');
    if (prompt === "elicitation") expect(result.output).toContain('"action":"decline"');
  });

  it("fails a swallowed interaction from a loaded continuation", async () => {
    const result = await executeAcp(
      options("elicitation", {
        sessionStart: { kind: "load", sessionId: "existing-session" },
        interactionBroker: failedBroker
      })
    );
    expect(result.sessionId).toBe("existing-session");
    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_failed" });
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAcpConnection, type AcpConnection } from "../autoRun/acpConnection.js";
import { executeAcp } from "../autoRun/acpExecutionEngine.js";
import type { AcpEngineEvent, ExecuteAcpOptions } from "../autoRun/acpExecutionEngineContracts.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

function engineOptions(
  scenario: string,
  overrides: Partial<ExecuteAcpOptions> = {}
): ExecuteAcpOptions {
  return {
    launch: { trusted: true, command: process.execPath, args: [fixture, scenario] },
    workspace: { cwd: process.cwd() },
    env: environment,
    clientInfo: { name: "planweave-engine-test", version: "1.0.0" },
    shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
    capabilityPolicy: { required: [], optional: [] },
    prompt: "exercise the ACP engine",
    sessionStart: { kind: "new" },
    limits: {
      operationTimeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      interactionTimeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS
    },
    ...overrides
  };
}

describe("storage-neutral ACP execution engine", () => {
  it("gates required capabilities before authentication or session RPCs", async () => {
    const events: AcpEngineEvent[] = [];
    const connection = {
      processId: 123,
      pendingOperationCount: 0,
      pendingOperations: new Map(),
      stderr: [],
      closed: Promise.resolve(),
      terminalFailure: undefined,
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "missing-capability", version: "1" }
      })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "must-not-open" })),
      loadSession: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
      cancel: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => ({})),
      setSessionMode: vi.fn(async () => ({})),
      setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
      dispose: vi.fn(async () => undefined)
    } satisfies AcpConnection;

    const result = await executeAcp(
      engineOptions("success", {
        capabilityPolicy: { required: ["history-load"], optional: ["image"] },
        connect: () => connection,
        eventSink: (event) => events.push(event)
      })
    );

    expect(result.terminal).toMatchObject({ state: "failed", reason: "capability_missing" });
    expect(result.capabilitySnapshot?.missing).toEqual(["history-load"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "capability_snapshot",
        snapshot: expect.objectContaining({ missing: ["history-load"] })
      })
    );
    expect(connection.initialize).toHaveBeenCalledTimes(1);
    expect(connection.authenticate).not.toHaveBeenCalled();
    expect(connection.newSession).not.toHaveBeenCalled();
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.prompt).not.toHaveBeenCalled();
  });
  it("executes initialize/new/prompt/cleanup and emits normalized ordered events", async () => {
    const events: AcpEngineEvent[] = [];
    const result = await executeAcp(
      engineOptions("streaming", { eventSink: (event) => events.push(event) })
    );

    expect(result.terminal).toEqual({ state: "succeeded", stopReason: "end_turn" });
    expect(result.sessionId).toMatch(/^mock-session-/);
    expect(result.output).toContain("hello from mock-session-");
    expect(result.cleanup).toEqual({ attempted: true, completed: true });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "session_update",
        body: expect.objectContaining({ kind: "usage_update", usedTokens: 12 })
      })
    );
    expect(events.at(-1)).toMatchObject({ kind: "terminal", terminal: { state: "succeeded" } });
  });

  it("publishes session identity before updates emitted during session creation", async () => {
    const events: AcpEngineEvent[] = [];
    let sessionStarted = false;
    const result = await executeAcp(
      engineOptions("early-session-update", {
        eventSink: (event) => {
          if (event.kind === "session_update" && !sessionStarted) {
            throw new Error("remote_execution_session_identity_stale");
          }
          events.push(event);
          if (event.kind === "session_started") sessionStarted = true;
        }
      })
    );
    expect(result.terminal).toEqual({ state: "succeeded", stopReason: "end_turn" });
    expect(events.findIndex((event) => event.kind === "session_started")).toBeLessThan(
      events.findIndex((event) => event.kind === "session_update")
    );
    expect(result.output).toContain("update before session/new response");
  });

  it("loads a caller-selected session without adding persistence semantics", async () => {
    const result = await executeAcp(
      engineOptions("load-capable", {
        sessionStart: { kind: "load", sessionId: "caller-session" }
      })
    );

    expect(result.terminal.state).toBe("succeeded");
    expect(result.sessionId).toBe("caller-session");
    expect(result.output).toContain("historical replay");
  });

  it("normalizes prompt-response usage independently from storage", async () => {
    const events: AcpEngineEvent[] = [];
    const result = await executeAcp(
      engineOptions("prompt-usage", { eventSink: (event) => events.push(event) })
    );

    expect(result.usage).toEqual({
      totalTokens: 15,
      inputTokens: 9,
      outputTokens: 6,
      thoughtTokens: 2,
      cachedReadTokens: 3,
      cachedWriteTokens: null
    });
    expect(events).toContainEqual(expect.objectContaining({ kind: "usage", usage: result.usage }));
  });

  it("routes permission and elicitation through the explicit broker", async () => {
    const permission = vi.fn(() => ({ kind: "select" as const, optionId: "allow" }));
    const permissionResult = await executeAcp(
      engineOptions("permission", {
        interactionBroker: {
          requestPermission: permission,
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );
    expect(permissionResult.terminal.state).toBe("succeeded");
    expect(permission).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "permission:1",
        options: [expect.objectContaining({ optionId: "allow", decision: "approve" })]
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal), deadline: expect.any(Date) })
    );

    const elicitation = vi.fn(() => ({ action: "accept" as const, content: { value: "chosen" } }));
    const elicitationResult = await executeAcp(
      engineOptions("elicitation", {
        interactionBroker: {
          requestPermission: () => ({ kind: "cancel" }),
          requestElicitation: elicitation
        }
      })
    );
    expect(elicitationResult.terminal.state).toBe("succeeded");
    expect(elicitation).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "elicitation:1", message: "Choose a test value" }),
      expect.any(Object)
    );
  });

  it("redacts elicitation content before exposing it to the broker", async () => {
    const requestElicitation = vi.fn(() => ({ action: "cancel" as const }));
    const result = await executeAcp(
      engineOptions("engine-elicitation-secret", {
        interactionBroker: {
          requestPermission: () => ({ kind: "cancel" }),
          requestElicitation
        }
      })
    );

    expect(result.terminal.state).toBe("succeeded");
    const brokerInput = JSON.stringify(requestElicitation.mock.calls);
    expect(brokerInput).not.toContain("secret-token");
    expect(brokerInput).not.toContain("raw-secret");
    expect(brokerInput).toContain("[REDACTED:CREDENTIAL]");
  });

  it("cancels interactions by default in headless mode", async () => {
    const events: AcpEngineEvent[] = [];
    const result = await executeAcp(
      engineOptions("permission", { eventSink: (event) => events.push(event) })
    );

    expect(result.terminal.state).toBe("succeeded");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "interaction",
        interaction: "permission",
        state: "resolved",
        outcome: "cancelled"
      })
    );
  });

  it("does not advertise elicitation when the adapter disables that capability", async () => {
    let advertisedCapabilities: unknown;
    const result = await executeAcp(
      engineOptions("success", {
        interactionBroker: {
          advertiseElicitation: false,
          requestPermission: () => ({ kind: "cancel" }),
          requestElicitation: () => ({ action: "cancel" })
        },
        connect: (options) => {
          advertisedCapabilities = options.clientCapabilities;
          return createAcpConnection(options);
        }
      })
    );

    expect(result.terminal.state).toBe("succeeded");
    expect(advertisedCapabilities).toBeUndefined();
    expect(result.capabilities?.client.elicitation).toBe(false);
  });

  it("fails closed on broker errors and unknown permission options", async () => {
    const failedBroker = await executeAcp(
      engineOptions("permission", {
        interactionBroker: {
          requestPermission: () => {
            throw new Error("broker unavailable");
          },
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );
    expect(failedBroker.terminal).toMatchObject({
      state: "failed",
      reason: "interaction_failed"
    });

    const unknownOption = await executeAcp(
      engineOptions("permission", {
        interactionBroker: {
          requestPermission: () => ({ kind: "select", optionId: "not-advertised" }),
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );
    expect(unknownOption.terminal).toMatchObject({
      state: "failed",
      reason: "interaction_failed"
    });
  });

  it("enforces the injected-clock interaction deadline", async () => {
    const requestPermission = vi.fn(() => new Promise<never>(() => undefined));
    const result = await executeAcp(
      engineOptions("permission", {
        clock: {
          now: () => new Date("2026-07-23T08:00:00.000Z"),
          sleep: async () => undefined
        },
        limits: { interactionTimeoutMs: 123 },
        interactionBroker: {
          requestPermission,
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );

    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_timeout" });
    expect(requestPermission).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deadline: new Date("2026-07-23T08:00:00.123Z") })
    );
  });

  it("reports authentication and session-load capability failures without fallback", async () => {
    const authentication = await executeAcp(engineOptions("action-required"));
    expect(authentication.terminal).toMatchObject({
      state: "failed",
      reason: "authentication_required"
    });

    const load = await executeAcp(
      engineOptions("success", { sessionStart: { kind: "load", sessionId: "missing" } })
    );
    expect(load.terminal).toMatchObject({ state: "failed", reason: "capability_missing" });
  });

  it("keeps authentication fail-closed by default and probes only when explicitly requested", async () => {
    const defaultResult = await executeAcp(engineOptions("session-ready-with-agent-auth"));
    expect(defaultResult.terminal).toMatchObject({
      state: "failed",
      reason: "authentication_required"
    });

    const lifecycle: string[] = [];
    const probed = await executeAcp(
      engineOptions("session-ready-with-agent-auth", {
        authentication: { requiredPolicy: "probe_session" },
        lifecycleObserver: (event) =>
          lifecycle.push(
            event.kind === "authentication_probe" ? `${event.kind}:${event.state}` : event.kind
          )
      })
    );

    expect(probed.terminal.state).toBe("succeeded");
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        "authentication_probe:starting",
        "authentication_probe:succeeded",
        "session_ready"
      ])
    );
  });

  it("keeps every prompt turn in the engine while exposing ordered lifecycle persistence points", async () => {
    const lifecycle: string[] = [];
    const result = await executeAcp(
      engineOptions("success", {
        followUpPrompts: (async function* () {
          yield "first follow-up";
          yield "second follow-up";
        })(),
        lifecycleObserver: (event) => {
          lifecycle.push(
            event.kind === "prompt_starting" || event.kind === "prompt_completed"
              ? `${event.kind}:${event.turn}:${event.followUp}`
              : event.kind
          );
        }
      })
    );

    expect(result.terminal.state).toBe("succeeded");
    expect(result.output.match(/hello from/g)).toHaveLength(3);
    expect(lifecycle).toEqual([
      "connection_ready",
      "initialized",
      "capability_gated",
      "authentication_completed",
      "session_ready",
      "prompt_starting:1:false",
      "prompt_completed:1:false",
      "prompt_starting:2:true",
      "prompt_completed:2:true",
      "prompt_starting:3:true",
      "prompt_completed:3:true",
      "prompts_completed",
      "cleanup_starting",
      "cleanup_completed"
    ]);
  });

  it("uses an adapter-supplied durable interaction deadline when present", async () => {
    const deadline = new Date("2026-07-23T08:00:00.075Z");
    const requestPermission = vi.fn(() => new Promise<never>(() => undefined));
    const result = await executeAcp(
      engineOptions("permission", {
        clock: {
          now: () => new Date("2026-07-23T08:00:00.000Z"),
          sleep: async () => undefined
        },
        limits: { interactionTimeoutMs: 999 },
        interactionDeadline: () => deadline,
        interactionBroker: {
          requestPermission,
          requestElicitation: () => ({ action: "cancel" })
        }
      })
    );

    expect(result.terminal).toMatchObject({ state: "failed", reason: "interaction_timeout" });
    expect(requestPermission).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ deadline })
    );
  });

  it("maps malformed, oversized, timed-out, and exited transports to explicit failures", async () => {
    const malformed = await executeAcp(engineOptions("invalid-envelope-pending"));
    expect(malformed.terminal).toMatchObject({ state: "failed", reason: "protocol_error" });

    const oversized = await executeAcp(
      engineOptions("oversized-frame", { limits: { inboundMessageMaxBytes: 1_024 } })
    );
    expect(oversized.terminal).toMatchObject({ state: "failed", reason: "limit_exceeded" });

    const timedOut = await executeAcp(
      engineOptions("delayed", { limits: { operationTimeoutMs: 5 } })
    );
    expect(timedOut.terminal).toMatchObject({ state: "failed", reason: "operation_timeout" });

    const exited = await executeAcp(engineOptions("early-exit"));
    expect(exited.terminal).toMatchObject({ state: "failed", reason: "process_error" });
  });

  it("returns cancellation and never falls back to another runner", async () => {
    const controller = new AbortController();
    const execution = executeAcp(engineOptions("long-prompt", { signal: controller.signal }));
    setTimeout(() => controller.abort(new Error("caller cancelled")), 20);

    await expect(execution).resolves.toMatchObject({
      terminal: { state: "cancelled", message: "caller cancelled" }
    });
  });

  it("turns event sink and cleanup failures into failed terminal results", async () => {
    const sink = await executeAcp(
      engineOptions("success", {
        eventSink: () => {
          throw new Error("sink unavailable");
        }
      })
    );
    expect(sink.terminal).toMatchObject({ state: "failed", reason: "event_sink_failed" });

    let cleanupConnection: AcpConnection | undefined;
    const cleanup = await executeAcp(
      engineOptions("close-capable-error", {
        connect: (options) => {
          cleanupConnection = createAcpConnection(options);
          return cleanupConnection;
        }
      })
    );
    expect(cleanup.terminal).toMatchObject({ state: "failed", reason: "cleanup_failed" });
    expect(cleanup.cleanup).toEqual({ attempted: true, completed: false });
    expect(cleanupConnection).toBeDefined();
    if (!cleanupConnection) throw new Error("ACP cleanup test did not create a connection.");
    await expect(cleanupConnection.closed).resolves.toBeUndefined();
  });

  it("classifies event byte-limit failures and still completes cleanup", async () => {
    const result = await executeAcp(engineOptions("success", { limits: { eventMaxBytes: 16 } }));
    expect(result.terminal).toMatchObject({ state: "failed", reason: "limit_exceeded" });
    expect(result.cleanup).toEqual({ attempted: true, completed: true });
  });

  it("rejects an oversized immutable prompt before launching a process", async () => {
    await expect(
      executeAcp(
        engineOptions("success", {
          prompt: "éé",
          limits: { promptMaxBytes: 3 }
        })
      )
    ).rejects.toThrow("prompt exceeded the 3-byte limit");
  });

  it("fails when normalized assistant output crosses its byte budget", async () => {
    const result = await executeAcp(engineOptions("success", { limits: { outputMaxBytes: 5 } }));
    expect(result.terminal).toMatchObject({ state: "failed", reason: "limit_exceeded" });
  });

  it.each([
    "refusal",
    "max_tokens",
    "max_turn_requests"
  ])("treats the %s stop reason as an incomplete response", async (scenario) => {
    const result = await executeAcp(engineOptions(scenario));

    expect(result.terminal).toEqual({
      state: "failed",
      reason: "incomplete_response",
      message: "ACP execution ended without a complete response."
    });
  });

  it("keeps raw text output separate from redacted and non-text event content", async () => {
    const events: AcpEngineEvent[] = [];
    const result = await executeAcp(
      engineOptions("nontext-output", { eventSink: (event) => events.push(event) })
    );

    expect(result.output).toBe("TOKEN=super-secret");
    expect(JSON.stringify(events)).not.toContain("super-secret");
    expect(JSON.stringify(events)).toContain("[REDACTED:CREDENTIAL]");
    expect(result.output).not.toContain("image/png");
    expect(result.output).not.toContain("AAAA");
  });

  it("bounds subprocess stderr by UTF-8 bytes and reports a limit failure", async () => {
    const result = await executeAcp(
      engineOptions("stderr-flood", { limits: { stderrMaxBytes: 31 } })
    );

    expect(result.terminal).toMatchObject({ state: "failed", reason: "limit_exceeded" });
    expect(Buffer.byteLength(result.stderr.join(""), "utf8")).toBeLessThanOrEqual(31);
  });

  it("applies one total deadline to hanging connection cleanup", async () => {
    vi.useFakeTimers();
    let notifyDisposeStarted: (() => void) | undefined;
    const disposeStarted = new Promise<void>((resolve) => {
      notifyDisposeStarted = resolve;
    });
    const connection = {
      processId: 1,
      pendingOperationCount: 0,
      pendingOperations: new Map(),
      stderr: [],
      closed: Promise.resolve(),
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        agentInfo: { name: "hanging-cleanup", version: "1" }
      })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "cleanup-session" })),
      loadSession: vi.fn(async () => ({})),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
      cancel: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => ({})),
      setSessionMode: vi.fn(async () => ({})),
      setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
      dispose: vi.fn((options) => {
        notifyDisposeStarted?.();
        return new Promise<void>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("controlled disposal reached its supplied deadline")),
            options?.timeoutMs
          );
        });
      })
    } satisfies AcpConnection;

    try {
      const execution = executeAcp(
        engineOptions("success", {
          connect: () => connection,
          shutdown: { eofDrainMs: 10, terminateGraceMs: 10, cleanupDeadlineMs: 270 }
        })
      );
      await disposeStarted;
      await vi.advanceTimersByTimeAsync(271);

      await expect(execution).resolves.toMatchObject({
        terminal: { state: "failed", reason: "cleanup_failed" },
        cleanup: { attempted: true, completed: false }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  AcpConversationTurnCoordinator,
  type AcpConversationTurnConnection,
  type AcpConversationTurnConnectionOptions
} from "../autoRun/acpConversationTurn.js";
import { acpConversationTurnIdentitySchema } from "../autoRun/acpConversationTurnContract.js";
import type { NormalizedRunnerEvent } from "../autoRun/normalizedEventContract.js";
import type { AcpOperationOptions } from "../autoRun/acpConnection.js";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

function sessionUpdate(text: string): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text }
    }
  };
}

function createHarness(
  options: {
    loadSession?: boolean;
    promptError?: Error;
    loadError?: Error;
    authenticateError?: Error;
    authMethods?: Array<{ id: string; name: string }>;
    rejectUnauthenticatedLoad?: boolean;
    holdPrompt?: boolean;
    holdAt?: "initialize" | "authenticate" | "loadSession" | "prompt";
    holdCancel?: boolean;
    holdDispose?: boolean;
  } = {}
) {
  const appended: NormalizedRunnerEvent["body"][] = [];
  const operationOrder: string[] = [];
  let authenticated = false;
  let releasePrompt: (() => void) | null = null;
  let releaseDispose: (() => void) | null = null;
  let connectionOptions: AcpConversationTurnConnectionOptions | null = null;
  const operationSignals: AbortSignal[] = [];
  let cleanupSignal: AbortSignal | undefined;
  let held = false;
  const hold = async (
    phase: NonNullable<typeof options.holdAt>,
    operation?: AcpOperationOptions
  ) => {
    if (operation?.signal) operationSignals.push(operation.signal);
    if (options.holdAt !== phase || held) return;
    held = true;
    await new Promise<never>((_resolve, reject) => {
      const signal = operation?.signal;
      if (!signal) throw new Error(`Expected operation signal for ${phase}.`);
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const connection: AcpConversationTurnConnection = {
    initialize: vi.fn(async (operation) => {
      operationOrder.push("initialize");
      await hold("initialize", operation);
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: options.loadSession ?? true },
        authMethods: options.authMethods ?? []
      };
    }),
    authenticate: vi.fn(async (_request, operation) => {
      operationOrder.push("authenticate");
      await hold("authenticate", operation);
      if (options.authenticateError) throw options.authenticateError;
      authenticated = true;
      return {};
    }),
    loadSession: vi.fn(async (_request, operation) => {
      operationOrder.push("loadSession");
      await hold("loadSession", operation);
      if (options.rejectUnauthenticatedLoad && !authenticated) {
        throw new Error("load rejected before authentication");
      }
      if (options.loadError) throw options.loadError;
      await connectionOptions?.onSessionUpdate?.(sessionUpdate("replayed"));
      return {};
    }),
    prompt: vi.fn(async (_request, operation) => {
      operationOrder.push("prompt");
      await hold("prompt", operation);
      await connectionOptions?.onSessionUpdate?.(sessionUpdate("fresh"));
      if (options.holdPrompt) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      if (options.promptError) throw options.promptError;
      return { stopReason: "end_turn" };
    }),
    cancel: vi.fn(async () => {
      operationOrder.push("cancel");
      if (options.holdCancel) await new Promise(() => undefined);
    }),
    dispose: vi.fn(async (operation) => {
      operationOrder.push("dispose");
      cleanupSignal = operation?.signal;
      if (options.holdDispose) {
        await new Promise<void>((resolve) => {
          releaseDispose = resolve;
        });
      }
    })
  };
  const connect = vi.fn((input: NonNullable<typeof connectionOptions>) => {
    connectionOptions = input;
    return connection;
  });
  const coordinator = new AcpConversationTurnCoordinator(connect);
  const input = {
    key: "/run/RUN-001",
    identity: acpConversationTurnIdentitySchema.parse({
      version: "planweave.agent-prompt-turn/v1",
      ref: { projectRoot: "/workspace", canvasId: "default" },
      recordId: "T-001#B-001::RUN-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1",
      turnId: "11111111-1111-4111-8111-111111111111"
    }),
    cwd: "/workspace",
    profile: {
      profileId: "codex-acp",
      agentId: "codex",
      displayName: "Codex",
      host: { kind: "native" as const },
      launch: { command: "codex-acp", args: [] as const },
      environment: [],
      shutdown: { eofDrainMs: 100, terminateGraceMs: 100, cleanupDeadlineMs: 1_000 },
      capabilities: { required: [], optional: [] },
      connection: { mode: "dedicated" as const },
      source: "builtin" as const,
      fingerprint: "a".repeat(64)
    },
    environment: { env: { PATH: "/usr/bin" }, availableNames: ["PATH"] },
    text: "continue",
    timeoutMs: 45 * 60 * 1_000,
    eventStore: {
      append: vi.fn(async (body: NormalizedRunnerEvent["body"]) => {
        appended.push(body);
      }),
      appendProtocol: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined)
    }
  };
  return {
    appended,
    operationOrder,
    operationSignals,
    connection,
    connect,
    coordinator,
    input,
    releasePrompt: () => releasePrompt?.(),
    releaseDispose: () => releaseDispose?.(),
    cleanupSignal: () => cleanupSignal
  };
}

describe("ACP conversation turn", () => {
  it("provides WSL host cleanup to a custom connection factory", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void
      ) => {
        callback(
          null,
          Buffer.from(
            "__PLANWEAVE_PATH_BEGIN__/home/dev/.local/bin:/usr/bin__PLANWEAVE_PATH_END__\n"
          ),
          Buffer.alloc(0)
        );
      }
    );
    const harness = createHarness();

    try {
      await harness.coordinator.send({
        ...harness.input,
        profile: {
          ...harness.input.profile,
          host: { kind: "wsl", distribution: "Ubuntu" }
        }
      });
    } finally {
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
      execFileMock.mockReset();
    }

    const connectionOptions = harness.connect.mock.calls[0]?.[0];
    expect(connectionOptions?.cleanupExitedProcessTree).toEqual(expect.any(Function));
  });

  it("does not provide host cleanup to a native custom connection factory", async () => {
    const harness = createHarness();

    await harness.coordinator.send(harness.input);

    const connectionOptions = harness.connect.mock.calls[0]?.[0];
    expect(connectionOptions?.cleanupExitedProcessTree).toBeUndefined();
  });

  it("loads the existing session and appends only the new turn", async () => {
    const harness = createHarness();

    await harness.coordinator.send(harness.input);

    expect(harness.connection.loadSession).toHaveBeenCalledWith(
      { sessionId: "session-1", cwd: "/workspace", mcpServers: [] },
      { signal: expect.any(AbortSignal) }
    );
    expect(harness.connect).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTimeoutMs: 45 * 60 * 1_000 })
    );
    expect(harness.appended).toEqual([
      expect.objectContaining({ kind: "message", role: "user", content: "continue" }),
      expect.objectContaining({ kind: "message", role: "assistant", content: "fresh" })
    ]);
    expect(harness.connection.dispose).toHaveBeenCalledOnce();
    expect(harness.operationOrder).toEqual(["initialize", "loadSession", "prompt", "dispose"]);
  });

  it("authenticates each new transport before loading the existing session", async () => {
    const harness = createHarness({
      authMethods: [{ id: "cached-login", name: "Cached login" }],
      rejectUnauthenticatedLoad: true
    });

    await harness.coordinator.send({
      ...harness.input,
      authenticationHints: {
        preferredMethodIds: ["cached-login"],
        headlessSafeMethodIds: ["cached-login"]
      }
    });

    expect(harness.operationOrder).toEqual([
      "initialize",
      "authenticate",
      "loadSession",
      "prompt",
      "dispose"
    ]);
    expect(harness.connection.authenticate).toHaveBeenCalledWith(
      { methodId: "cached-login" },
      { signal: expect.any(AbortSignal) }
    );
  });

  it("probes loadSession for interactive auth and fails closed when load still requires login", async () => {
    const harness = createHarness({
      authMethods: [{ id: "interactive-login", name: "Interactive login" }],
      rejectUnauthenticatedLoad: true
    });

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow(
      "headless-safe authentication method"
    );

    expect(harness.operationOrder).toEqual(["initialize", "loadSession", "dispose"]);
    expect(harness.connection.loadSession).toHaveBeenCalledOnce();
    expect(harness.connection.prompt).not.toHaveBeenCalled();
    expect(harness.connection.dispose).toHaveBeenCalledOnce();
  });

  it("preserves authentication failures without loading or prompting", async () => {
    const harness = createHarness({
      authMethods: [{ id: "cached-login", name: "Cached login" }],
      authenticateError: new Error("authentication protocol failure"),
      rejectUnauthenticatedLoad: true
    });

    await expect(
      harness.coordinator.send({
        ...harness.input,
        authenticationHints: {
          preferredMethodIds: ["cached-login"],
          headlessSafeMethodIds: ["cached-login"]
        }
      })
    ).rejects.toThrow("authentication protocol failure");

    expect(harness.operationOrder).toEqual(["initialize", "authenticate", "dispose"]);
    expect(harness.connection.loadSession).not.toHaveBeenCalled();
    expect(harness.connection.prompt).not.toHaveBeenCalled();
  });

  it("does not fall back to a new session when session/load fails", async () => {
    const harness = createHarness({ loadError: new Error("load failed") });

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow("load failed");

    expect(harness.operationOrder).toEqual(["initialize", "loadSession", "dispose"]);
    expect(harness.connection.prompt).not.toHaveBeenCalled();
  });

  it("rejects providers that do not advertise session/load", async () => {
    const harness = createHarness({ loadSession: false });

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow(
      "does not support loading an existing session"
    );
    expect(harness.connection.loadSession).not.toHaveBeenCalled();
    expect(harness.connection.prompt).not.toHaveBeenCalled();
    expect(harness.operationOrder).toEqual(["initialize", "dispose"]);
  });

  it("fails closed when the same record receives concurrent prompts", async () => {
    const harness = createHarness({ holdPrompt: true });
    const first = harness.coordinator.send(harness.input);
    await vi.waitFor(() => expect(harness.connection.prompt).toHaveBeenCalledOnce());

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow("already in progress");
    harness.releasePrompt();
    await first;
  });

  for (const phase of ["initialize", "authenticate", "loadSession", "prompt"] as const) {
    it(`cancels a completed-run continuation while ${phase} is blocked`, async () => {
      const harness = createHarness({
        holdAt: phase,
        ...(phase === "authenticate"
          ? { authMethods: [{ id: "cached-login", name: "Cached login" }] }
          : {})
      });
      const input =
        phase === "authenticate"
          ? {
              ...harness.input,
              authenticationHints: {
                preferredMethodIds: ["cached-login"],
                headlessSafeMethodIds: ["cached-login"]
              }
            }
          : harness.input;
      const sending = harness.coordinator.send(input);
      await vi.waitFor(() => {
        const state = harness.coordinator.query(input.key, input.identity);
        expect(state.found && state.state.phase).toBe(
          phase === "initialize"
            ? "initializing"
            : phase === "authenticate"
              ? "authenticating"
              : phase === "loadSession"
                ? "loading"
                : "prompting"
        );
      });

      const cancelled = await harness.coordinator.cancel(input.key, input.identity);

      expect(cancelled.outcome).toBe("cancel_requested");
      await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });
      expect(harness.connection.cancel).toHaveBeenCalledTimes(phase === "prompt" ? 1 : 0);
      expect(harness.connection.dispose).toHaveBeenCalledOnce();
      expect(harness.cleanupSignal()).toBeInstanceOf(AbortSignal);
      expect(harness.cleanupSignal()).not.toBe(harness.operationSignals[0]);
      expect(harness.cleanupSignal()?.aborted).toBe(false);
      expect(new Set(harness.operationSignals).size).toBe(1);
    });
  }

  it("cancels before connection creation while the turn is starting", async () => {
    const harness = createHarness();
    const never = new Promise<never>(() => undefined);
    const input = { ...harness.input, eventStore: async () => never };
    const sending = harness.coordinator.send(input);
    await vi.waitFor(() =>
      expect(harness.coordinator.query(input.key, input.identity)).toMatchObject({
        found: true,
        state: { phase: "starting" }
      })
    );

    await expect(harness.coordinator.cancel(input.key, input.identity)).resolves.toMatchObject({
      outcome: "cancel_requested"
    });
    await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.connection.cancel).not.toHaveBeenCalled();
  });

  it("dispatches session cancel before aborting prompt and uses an independent cleanup signal", async () => {
    const harness = createHarness({ holdAt: "prompt" });
    const sending = harness.coordinator.send(harness.input);
    await vi.waitFor(() => expect(harness.connection.prompt).toHaveBeenCalledOnce());
    const operationSignal = harness.operationSignals.at(-1);
    if (!operationSignal) throw new Error("Expected prompt operation signal.");
    let abortedWhenCancelDispatched: boolean | null = null;
    vi.mocked(harness.connection.cancel).mockImplementationOnce(async () => {
      abortedWhenCancelDispatched = operationSignal.aborted;
      harness.operationOrder.push("cancel-dispatched");
    });

    await harness.coordinator.cancel(harness.input.key, harness.input.identity);
    await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });

    expect(abortedWhenCancelDispatched).toBe(false);
    expect(operationSignal.aborted).toBe(true);
    expect(harness.operationOrder.indexOf("cancel-dispatched")).toBeLessThan(
      harness.operationOrder.indexOf("dispose")
    );
    expect(harness.cleanupSignal()).not.toBe(operationSignal);
    expect(harness.cleanupSignal()?.aborted).toBe(false);
  });

  it("rejects cancellation atomically after prompting completed and cleanup started", async () => {
    const harness = createHarness({ holdDispose: true });
    const sending = harness.coordinator.send(harness.input);
    await vi.waitFor(() => expect(harness.connection.dispose).toHaveBeenCalledOnce());

    await expect(
      harness.coordinator.cancel(harness.input.key, harness.input.identity)
    ).resolves.toMatchObject({
      outcome: "not_cancellable",
      state: {
        phase: "cleaning",
        terminal: null,
        cancellationRequested: false,
        cancellable: false
      }
    });
    expect(harness.connection.cancel).not.toHaveBeenCalled();
    harness.releaseDispose();
    await expect(sending).resolves.toMatchObject({
      terminal: "succeeded",
      cancellationRequested: false
    });
  });

  it("fails closed for the wrong turn identity and makes terminal cancellation idempotent", async () => {
    const harness = createHarness({ holdAt: "prompt" });
    const sending = harness.coordinator.send(harness.input);
    await vi.waitFor(() => expect(harness.connection.prompt).toHaveBeenCalledOnce());
    const wrongIdentity = {
      ...harness.input.identity,
      turnId: "22222222-2222-4222-8222-222222222222"
    };

    await expect(
      harness.coordinator.cancel(harness.input.key, wrongIdentity)
    ).resolves.toMatchObject({
      outcome: "identity_mismatch"
    });
    expect(harness.operationSignals.at(-1)?.aborted).toBe(false);
    await harness.coordinator.cancel(harness.input.key, harness.input.identity);
    await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });
    await expect(
      harness.coordinator.cancel(harness.input.key, harness.input.identity)
    ).resolves.toMatchObject({ outcome: "already_terminal" });
    await expect(
      harness.coordinator.cancel(harness.input.key, wrongIdentity)
    ).resolves.toMatchObject({
      outcome: "not_found"
    });
  });

  it("recovers the active turn from its stable persisted run identity", async () => {
    const harness = createHarness({ holdAt: "prompt" });
    const sending = harness.coordinator.send(harness.input);
    await vi.waitFor(() => expect(harness.connection.prompt).toHaveBeenCalledOnce());

    expect(harness.coordinator.current(harness.input.key, harness.input.identity)).toMatchObject({
      found: true,
      state: { identity: harness.input.identity, phase: "prompting" }
    });
    expect(
      harness.coordinator.current(harness.input.key, {
        ...harness.input.identity,
        sessionId: "wrong-session"
      })
    ).toMatchObject({ found: false, reason: "identity_mismatch" });

    await harness.coordinator.cancel(harness.input.key, harness.input.identity);
    await expect(sending).resolves.toMatchObject({ terminal: "cancelled" });
  });

  it("bounds retained terminal turns across many run records", async () => {
    const harness = createHarness();
    const coordinator = new AcpConversationTurnCoordinator(harness.connect, {
      terminalLimit: 3,
      terminalTtlMs: 60_000
    });
    const identities = [];
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(12, "0");
      const identity = acpConversationTurnIdentitySchema.parse({
        ...harness.input.identity,
        recordId: `T-001#B-001::RUN-${index}`,
        executorRunId: `RUN-${index}`,
        turnId: `00000000-0000-4000-8000-${suffix}`
      });
      identities.push(identity);
      await coordinator.send({ ...harness.input, key: `/run/RUN-${index}`, identity });
    }

    expect(coordinator.terminalCount()).toBe(3);
    expect(coordinator.query("/run/RUN-1", identities[0]!)).toMatchObject({ found: false });
    expect(coordinator.query("/run/RUN-5", identities[4]!)).toMatchObject({ found: true });
  });

  it("allows a new turn after cancellation without retaining active state", async () => {
    const harness = createHarness({ holdAt: "prompt" });
    const first = harness.coordinator.send(harness.input);
    await vi.waitFor(() => expect(harness.connection.prompt).toHaveBeenCalledOnce());
    await harness.coordinator.cancel(harness.input.key, harness.input.identity);
    await expect(first).resolves.toMatchObject({ terminal: "cancelled" });
    const retryIdentity = {
      ...harness.input.identity,
      turnId: "33333333-3333-4333-8333-333333333333"
    };

    await expect(
      harness.coordinator.send({ ...harness.input, identity: retryIdentity })
    ).resolves.toMatchObject({ terminal: "succeeded" });
    expect(harness.coordinator.isInFlight(harness.input.key)).toBe(false);
    expect(harness.connection.prompt).toHaveBeenCalledTimes(2);
  });

  it("records a prompt error without changing the original terminal outcome", async () => {
    const harness = createHarness({ promptError: new Error("provider failed") });

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow("provider failed");
    expect(harness.appended).toContainEqual(
      expect.objectContaining({
        kind: "diagnostic",
        code: "protocol_error",
        message: expect.stringContaining("provider failed")
      })
    );
    expect(harness.appended.some((body) => body.kind === "terminal")).toBe(false);
  });

  it("keeps permission and elicitation requests on the existing default-deny policy", async () => {
    const harness = createHarness();
    await harness.coordinator.send(harness.input);
    const options = harness.connect.mock.calls[0]?.[0];
    if (!options?.onPermissionRequest || !options.onElicitationRequest) {
      throw new Error("Expected ACP safety callbacks.");
    }

    await expect(
      options.onPermissionRequest({
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "write", status: "pending" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
      })
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(
      options.onElicitationRequest({
        mode: "form",
        sessionId: "session-1",
        message: "secret",
        requestedSchema: { type: "object", properties: {} }
      })
    ).resolves.toEqual({ action: "cancel" });
  });
});

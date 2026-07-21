import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  AcpConversationTurnCoordinator,
  type AcpConversationTurnConnection
} from "../autoRun/acpConversationTurn.js";
import type { NormalizedRunnerEvent } from "../autoRun/normalizedEventContract.js";

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
  } = {}
) {
  const appended: NormalizedRunnerEvent["body"][] = [];
  const operationOrder: string[] = [];
  let authenticated = false;
  let releasePrompt: (() => void) | null = null;
  let connectionOptions:
    | Parameters<ConstructorParameters<typeof AcpConversationTurnCoordinator>[0]>[0]
    | null = null;
  const connection: AcpConversationTurnConnection = {
    initialize: vi.fn(async () => {
      operationOrder.push("initialize");
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: options.loadSession ?? true },
        authMethods: options.authMethods ?? []
      };
    }),
    authenticate: vi.fn(async () => {
      operationOrder.push("authenticate");
      if (options.authenticateError) throw options.authenticateError;
      authenticated = true;
      return {};
    }),
    loadSession: vi.fn(async () => {
      operationOrder.push("loadSession");
      if (options.rejectUnauthenticatedLoad && !authenticated) {
        throw new Error("load rejected before authentication");
      }
      if (options.loadError) throw options.loadError;
      await connectionOptions?.onSessionUpdate?.(sessionUpdate("replayed"));
      return {};
    }),
    prompt: vi.fn(async () => {
      operationOrder.push("prompt");
      await connectionOptions?.onSessionUpdate?.(sessionUpdate("fresh"));
      if (options.holdPrompt) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      if (options.promptError) throw options.promptError;
      return { stopReason: "end_turn" };
    }),
    dispose: vi.fn(async () => undefined)
  };
  const connect = vi.fn((input: NonNullable<typeof connectionOptions>) => {
    connectionOptions = input;
    return connection;
  });
  const coordinator = new AcpConversationTurnCoordinator(connect);
  const input = {
    key: "/run/RUN-001",
    cwd: "/workspace",
    sessionId: "session-1",
    agentId: "codex" as const,
    launch: { command: "codex-acp", args: [] as const },
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
    connection,
    connect,
    coordinator,
    input,
    releasePrompt: () => releasePrompt?.()
  };
}

describe("ACP conversation turn", () => {
  it("loads the existing session and appends only the new turn", async () => {
    const harness = createHarness();

    await harness.coordinator.send(harness.input);

    expect(harness.connection.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/workspace",
      mcpServers: []
    });
    expect(harness.connect).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTimeoutMs: 45 * 60 * 1_000 })
    );
    expect(harness.appended).toEqual([
      expect.objectContaining({ kind: "message", role: "user", content: "continue" }),
      expect.objectContaining({ kind: "message", role: "assistant", content: "fresh" })
    ]);
    expect(harness.connection.dispose).toHaveBeenCalledOnce();
    expect(harness.operationOrder).toEqual(["initialize", "loadSession", "prompt"]);
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

    expect(harness.operationOrder).toEqual(["initialize", "authenticate", "loadSession", "prompt"]);
    expect(harness.connection.authenticate).toHaveBeenCalledWith(
      { methodId: "cached-login" },
      undefined
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

    expect(harness.operationOrder).toEqual(["initialize", "loadSession"]);
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

    expect(harness.operationOrder).toEqual(["initialize", "authenticate"]);
    expect(harness.connection.loadSession).not.toHaveBeenCalled();
    expect(harness.connection.prompt).not.toHaveBeenCalled();
  });

  it("does not fall back to a new session when session/load fails", async () => {
    const harness = createHarness({ loadError: new Error("load failed") });

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow("load failed");

    expect(harness.operationOrder).toEqual(["initialize", "loadSession"]);
    expect(harness.connection.prompt).not.toHaveBeenCalled();
  });

  it("rejects providers that do not advertise session/load", async () => {
    const harness = createHarness({ loadSession: false });

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow(
      "does not support loading an existing session"
    );
    expect(harness.connection.loadSession).not.toHaveBeenCalled();
    expect(harness.connection.prompt).not.toHaveBeenCalled();
    expect(harness.operationOrder).toEqual(["initialize"]);
  });

  it("fails closed when the same record receives concurrent prompts", async () => {
    const harness = createHarness({ holdPrompt: true });
    const first = harness.coordinator.send(harness.input);
    await vi.waitFor(() => expect(harness.connection.prompt).toHaveBeenCalledOnce());

    await expect(harness.coordinator.send(harness.input)).rejects.toThrow("already in progress");
    harness.releasePrompt();
    await first;
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

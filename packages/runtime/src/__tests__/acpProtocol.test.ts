import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_SDK_AUTHORITY,
  createAcpConnection,
  type AcpConnection,
  type AcpProtocolObservation
} from "../autoRun/acpConnection.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);
const connections: AcpConnection[] = [];

function connect(
  scenario: string,
  options: {
    observations?: AcpProtocolObservation[];
    timeoutMs?: number;
    onUpdate?: (text: string) => void;
    allowPermission?: boolean;
    shutdownGraceMs?: number;
  } = {}
): AcpConnection {
  const connection = createAcpConnection({
    launch: { trusted: true, command: process.execPath, args: [fixture, scenario] },
    cwd: process.cwd(),
    env: environment,
    clientInfo: { name: "planweave-test-client", version: "1.0.0" },
    defaultTimeoutMs: options.timeoutMs ?? 500,
    shutdownGraceMs: options.shutdownGraceMs,
    onSessionUpdate(notification) {
      options.onUpdate?.(JSON.stringify(notification));
    },
    onPermissionRequest: options.allowPermission
      ? (request) => ({
          outcome: { outcome: "selected", optionId: request.options[0]?.optionId ?? "allow" }
        })
      : undefined,
    observer: options.observations
      ? {
          redact(payload) {
            return typeof payload === "string"
              ? payload.replaceAll("diagnostic", "[redacted]")
              : { redacted: true };
          },
          observe(observation) {
            options.observations?.push(observation);
          }
        }
      : undefined
  });
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map((connection) => connection.dispose()));
});

describe("ACP official SDK subprocess connection", () => {
  it("records the pinned SDK/schema authority and negotiates protocol version 1", async () => {
    expect(ACP_SDK_AUTHORITY).toEqual({
      packageName: "@agentclientprotocol/sdk",
      packageVersion: "1.2.1",
      schemaArtifact: "schema/schema.json",
      protocolVersion: 1
    });
    await expect(connect("success").initialize()).resolves.toMatchObject({ protocolVersion: 1 });
  });

  it("creates a session, streams updates, prompts, cancels, and rejects unsupported close", async () => {
    const updates: string[] = [];
    const connection = connect("streaming", { onUpdate: (update) => updates.push(update) });
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    const prompt = connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }]
    });
    await connection.cancel({ sessionId: session.sessionId });
    const response = await prompt;
    expect(["cancelled", "end_turn"]).toContain(response.stopReason);
    expect(updates.join("\n")).toContain("agent_message_chunk");
    await expect(connection.closeSession(session.sessionId)).rejects.toThrow(
      "does not advertise session/close"
    );
  });

  it("negotiates session/close and performs close over the official SDK wire path", async () => {
    const connection = connect("close-capable");
    const initialized = await connection.initialize();
    expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({});
    const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    await expect(connection.closeSession(session.sessionId)).resolves.toEqual({});
    await expect(
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "closed" }]
      })
    ).rejects.toThrow();
  });

  it("fails closed on auth errors and JSON-RPC errors", async () => {
    const auth = connect("auth-required");
    await auth.initialize();
    await expect(auth.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();

    const protocol = connect("protocol-error");
    await protocol.initialize();
    const session = await protocol.newSession({ cwd: process.cwd(), mcpServers: [] });
    await expect(
      protocol.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "fail" }] })
    ).rejects.toThrow();
  });

  it("handles bidirectional permission requests through the explicit client callback", async () => {
    const connection = connect("permission", { allowPermission: true });
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    await expect(
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "permission" }]
      })
    ).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it.each(["malformed", "duplicate-response", "unknown-id"])(
    "terminates on %s transport input",
    async (scenario) => {
      const connection = connect(scenario);
      await connection.initialize();
      await new Promise((resolve) => setTimeout(resolve, 35));
      await expect(connection.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
    }
  );

  it("fails closed on a valid JSON non-object and settles an in-flight request", async () => {
    const connection = connect("invalid-envelope-pending");
    await connection.initialize();
    const pending = connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    await expect(pending).rejects.toThrow("invalid JSON-RPC envelope");
    await expect(connection.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow(
      "invalid JSON-RPC envelope"
    );
  });

  it("fails closed on an object-shaped mixed envelope and settles an in-flight request", async () => {
    const connection = connect("invalid-object-envelope-pending");
    await connection.initialize();
    const pending = connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    await expect(pending).rejects.toThrow("invalid JSON-RPC envelope");
    await expect(connection.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow(
      "invalid JSON-RPC envelope"
    );
  });

  it("terminates on timeout and AbortSignal while settling pending operations", async () => {
    const timedOut = connect("delayed", { timeoutMs: 5 });
    await expect(timedOut.initialize()).rejects.toThrow("timed out");

    const aborted = connect("delayed");
    await aborted.initialize();
    const session = await aborted.newSession({ cwd: process.cwd(), mcpServers: [] });
    const controller = new AbortController();
    const prompt = aborted.prompt(
      { sessionId: session.sessionId, prompt: [{ type: "text", text: "wait" }] },
      { signal: controller.signal }
    );
    controller.abort(new Error("caller aborted"));
    await expect(prompt).rejects.toThrow("caller aborted");
  });

  it("settles initialize on early exit and a pending prompt during disposal", async () => {
    await expect(connect("early-exit").initialize()).rejects.toThrow();

    const connection = connect("delayed");
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    const prompt = connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "dispose" }]
    });
    const settledPrompt = expect(prompt).rejects.toThrow();
    await connection.dispose();
    await settledPrompt;
  });

  it("escalates a SIGTERM-resistant production connection to SIGKILL and settles pending work", async () => {
    const connection = connect("stubborn-pending", { timeoutMs: 5_000, shutdownGraceMs: 25 });
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    const pending = connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "stay pending" }]
    });
    for (let attempt = 0; attempt < 100 && connection.pendingOperationCount === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(connection.pendingOperationCount).toBe(1);
    const pid = connection.processId;
    expect(pid).not.toBeNull();
    const pendingRejection = expect(pending).rejects.toThrow("ACP connection closed");
    const firstDispose = connection.dispose();
    const secondDispose = connection.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;
    await pendingRejection;
    expect(connection.stderr.join("")).toContain("SIGTERM observed");
    expect(connection.pendingOperationCount).toBe(0);
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("captures stderr only through a caller-supplied redacting observer", async () => {
    const observations: AcpProtocolObservation[] = [];
    const connection = connect("stderr", { observations });
    await connection.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connection.stderr.join("")).toContain("mock ACP diagnostic");
    expect(observations).toContainEqual({
      direction: "agent_stderr",
      payload: "mock ACP [redacted]\n"
    });
    expect(observations.filter((item) => item.direction !== "agent_stderr")).toSatisfy(
      (items: AcpProtocolObservation[]) => items.every((item) => JSON.stringify(item.payload) === '{"redacted":true}')
    );
  });

  it("rejects invalid process boundaries before spawn", () => {
    expect(() =>
      createAcpConnection({
        launch: { trusted: true, command: "", args: [] },
        cwd: process.cwd(),
        env: environment,
        clientInfo: { name: "test", version: "1" }
      })
    ).toThrow("missing or invalid");
    expect(() =>
      createAcpConnection({
        launch: { trusted: true, command: process.execPath, args: [] },
        cwd: "relative",
        env: environment,
        clientInfo: { name: "test", version: "1" }
      })
    ).toThrow("absolute path");
  });
});

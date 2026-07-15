import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_SDK_AUTHORITY,
  createAcpConnection,
  type AcpConnection,
  type AcpProtocolObservation
} from "../autoRun/acpConnection.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);
const connections: AcpConnection[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connect(
  scenario: string,
  options: {
    observations?: AcpProtocolObservation[];
    redactorInputs?: unknown[];
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
    defaultTimeoutMs: options.timeoutMs ?? ACP_MOCK_OPERATION_TIMEOUT_MS,
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
            options.redactorInputs?.push(payload);
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

  it("loads an existing session through the official SDK wire path", async () => {
    const connection = connect("load-capable");
    const initialized = await connection.initialize();
    expect(initialized.agentCapabilities?.loadSession).toBe(true);
    const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });

    await expect(
      connection.loadSession({
        sessionId: session.sessionId,
        cwd: process.cwd(),
        mcpServers: []
      })
    ).resolves.toEqual({});
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

  it("authenticates through the official SDK request path without exposing the method to observers", async () => {
    const observations: AcpProtocolObservation[] = [];
    const redactorInputs: unknown[] = [];
    const connection = connect("authenticated-with-auth-methods", {
      observations,
      redactorInputs
    });
    const initialized = await connection.initialize();
    expect(initialized.authMethods).toEqual([
      expect.objectContaining({ id: "mock-login", name: "Mock login" })
    ]);

    const observationStart = observations.length;
    const redactorInputStart = redactorInputs.length;
    await expect(connection.authenticate({ methodId: "mock-login" })).resolves.toEqual({});

    const authenticateEnvelope = redactorInputs
      .slice(redactorInputStart)
      .find(
        (payload): payload is Record<string, unknown> =>
          isRecord(payload) && payload.method === "authenticate"
      );
    expect(authenticateEnvelope).toBeDefined();
    expect(authenticateEnvelope).toMatchObject({
      jsonrpc: "2.0",
      method: "authenticate",
      params: { methodId: "mock-login" }
    });
    expect(Object.keys(authenticateEnvelope ?? {}).sort()).toEqual([
      "id",
      "jsonrpc",
      "method",
      "params"
    ]);
    const authenticateParams = authenticateEnvelope?.params;
    expect(isRecord(authenticateParams)).toBe(true);
    if (!isRecord(authenticateParams)) {
      throw new Error("ACP authenticate request params were not an object.");
    }
    expect(Object.keys(authenticateParams)).toEqual(["methodId"]);
    expect(JSON.stringify(authenticateEnvelope)).not.toContain("opaque-auth-secret");
    expect(JSON.stringify(authenticateEnvelope)).not.toContain("_meta");

    const authObservations = observations.slice(observationStart);
    expect(authObservations).not.toHaveLength(0);
    expect(authObservations).toSatisfy((items: AcpProtocolObservation[]) =>
      items.every((item) => JSON.stringify(item.payload) === '{"redacted":true}')
    );
    expect(JSON.stringify(authObservations)).not.toContain("mock-login");
    expect(JSON.stringify(authObservations)).not.toContain("opaque-auth-secret");
  });

  it("rejects authenticate before initialize", async () => {
    await expect(
      connect("authenticated-with-auth-methods").authenticate({ methodId: "mock-login" })
    ).rejects.toThrow("must be initialized before authenticate");
  });

  it("applies timeout and AbortSignal boundaries to authenticate", async () => {
    const timedOut = connect("authenticate-delayed");
    await timedOut.initialize();
    await expect(
      timedOut.authenticate({ methodId: "mock-login" }, { timeoutMs: 10 })
    ).rejects.toThrow("ACP authenticate timed out");

    const aborted = connect("authenticate-delayed");
    await aborted.initialize();
    const controller = new AbortController();
    const authentication = aborted.authenticate(
      { methodId: "mock-login" },
      { signal: controller.signal }
    );
    controller.abort(new Error("authentication cancelled"));
    await expect(authentication).rejects.toThrow("authentication cancelled");
  });

  it("registers authenticate as pending work and settles it during disposal", async () => {
    const connection = connect("authenticate-delayed");
    await connection.initialize();
    const authentication = connection.authenticate({ methodId: "mock-login" });
    for (let attempt = 0; attempt < 100 && connection.pendingOperationCount === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(connection.pendingOperationCount).toBe(1);
    expect([...connection.pendingOperations.values()]).toEqual([
      expect.objectContaining({ operation: "authenticate" })
    ]);

    const settledAuthentication = expect(authentication).rejects.toThrow();
    await connection.dispose();
    await settledAuthentication;
    expect(connection.pendingOperationCount).toBe(0);
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

  it.each([
    "malformed",
    "duplicate-response",
    "unknown-id"
  ])("terminates on %s transport input", async (scenario) => {
    const connection = connect(scenario);
    await connection.initialize();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await expect(connection.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
  });

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
      (items: AcpProtocolObservation[]) =>
        items.every((item) => JSON.stringify(item.payload) === '{"redacted":true}')
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
    expect(() =>
      createAcpConnection({
        launch: { trusted: true, command: process.execPath, args: [] },
        cwd: process.cwd(),
        env: environment,
        clientInfo: { name: "test", version: "1" },
        clientCapabilities: { auth: { terminal: true } }
      })
    ).toThrow("does not implement terminal authentication");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { ACP_PROTOCOL_AUTHORITY, AcpMockHarness } from "./support/acpMockHarness.js";

const harnesses: AcpMockHarness[] = [];
const spawnHarness = (scenario: ConstructorParameters<typeof AcpMockHarness>[0]) => {
  const harness = new AcpMockHarness(scenario);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("ACP mock subprocess harness", () => {
  it("pins the official SDK as the protocol authority and labels preview behavior", () => {
    expect(ACP_PROTOCOL_AUTHORITY).toEqual(
      expect.objectContaining({
        packageName: "@agentclientprotocol/sdk",
        version: "1.2.1",
        experimental: ["elicitation/create"]
      })
    );
    expect(ACP_PROTOCOL_AUTHORITY.stable).not.toContain("elicitation/create");
  });

  it("uses stdio for initialize, concurrent sessions, streaming, and usage updates", async () => {
    const harness = spawnHarness("streaming");
    const initialized = await harness.initialize();
    expect(initialized.result).toEqual(expect.objectContaining({ protocolVersion: 1 }));
    expect(harness.sent[0]).toEqual(
      expect.objectContaining({ method: "initialize", params: expect.objectContaining({ clientCapabilities: {} }) })
    );

    const [first, second] = await Promise.all([harness.newSession(), harness.newSession()]);
    const responses = await Promise.all([harness.prompt(first), harness.prompt(second)]);
    expect(responses.map((response) => response.result)).toEqual([
      { stopReason: "end_turn" },
      { stopReason: "end_turn" }
    ]);
    expect(harness.traffic.filter((message) => message.method === "session/update")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ params: expect.objectContaining({ sessionId: first }) }),
        expect.objectContaining({ params: expect.objectContaining({ sessionId: second }) })
      ])
    );
    expect(JSON.stringify(harness.traffic)).toContain("usage_update");
    expect(JSON.stringify(harness.traffic)).toContain("tool_call");
  });

  it("supports permission and optional preview elicitation requests", async () => {
    for (const scenario of ["permission", "elicitation"] as const) {
      const harness = spawnHarness(scenario);
      await harness.initialize();
      const initialize = harness.sent.find((message) => message.method === "initialize");
      expect(initialize?.params).toEqual(
        expect.objectContaining({
          clientCapabilities:
            scenario === "elicitation" ? { elicitation: { form: {} } } : {}
        })
      );
      const sessionId = await harness.newSession();
      await expect(harness.prompt(sessionId)).resolves.toEqual(
        expect.objectContaining({ result: { stopReason: "end_turn" } })
      );
      expect(harness.traffic.some((message) => message.method === (scenario === "permission" ? "session/request_permission" : "elicitation/create"))).toBe(true);
    }
  });

  it("supports authentication errors, cancellation races, and late updates", async () => {
    const auth = spawnHarness("auth-required");
    await auth.initialize();
    await expect(auth.request("session/new", { cwd: process.cwd(), mcpServers: [] })).resolves.toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: -32000 }) })
    );

    const late = spawnHarness("late-update");
    await late.initialize();
    const sessionId = await late.newSession();
    const prompt = late.prompt(sessionId);
    late.notify("session/cancel", { sessionId });
    await expect(prompt).resolves.toEqual(expect.objectContaining({ result: { stopReason: "cancelled" } }));
    expect(JSON.stringify(late.traffic)).toContain("late");
  });

  it("exposes protocol errors plus duplicate and unknown response ids to consumers", async () => {
    const protocolError = spawnHarness("protocol-error");
    await protocolError.initialize();
    const sessionId = await protocolError.newSession();
    await expect(protocolError.prompt(sessionId)).resolves.toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: -32602 }) })
    );

    for (const scenario of ["duplicate-response", "unknown-id"] as const) {
      const harness = spawnHarness(scenario);
      await harness.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const unsolicited = harness.traffic.filter(
        (message) => message.result && (message.result as { duplicate?: boolean }).duplicate
      );
      expect(unsolicited).toHaveLength(1);
      expect(unsolicited[0]?.id).toBe(scenario === "unknown-id" ? "unknown-request-id" : 1);
    }
  });

  it("surfaces delayed responses, malformed stdout, stderr, and early process exit", async () => {
    const delayed = spawnHarness("delayed");
    await expect(delayed.initialize()).resolves.toEqual(expect.objectContaining({ result: expect.any(Object) }));

    const malformed = spawnHarness("malformed");
    await malformed.initialize();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(malformed.malformed).toEqual(["{not-json}"]);

    const stderr = spawnHarness("stderr");
    await stderr.initialize();
    expect(stderr.stderr).toContain("mock ACP diagnostic");

    const exited = spawnHarness("early-exit");
    await expect(exited.initialize()).rejects.toThrow("Mock ACP process exited");
    expect(await exited.waitForExit()).toEqual({ code: 23, signal: null });
    expect(exited.stderr).toContain("mock ACP exited before initialization");
  });

  it("forcibly reaps a process with a pending request that ignores graceful shutdown", async () => {
    const harness = spawnHarness("stubborn-pending");
    await harness.initialize();
    const sessionId = await harness.newSession();
    const prompt = harness.prompt(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.traffic.some((message) => message.method === "mock/pending")).toBe(true);

    await expect(harness.dispose(30)).resolves.toBeUndefined();
    await expect(prompt).rejects.toThrow("Mock ACP process exited");
    expect(harness.process.signalCode).toBe("SIGKILL");
    harnesses.splice(harnesses.indexOf(harness), 1);
  });
});

import { execFile } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_MOCK_OPERATION_TIMEOUT_MS,
  ACP_PROTOCOL_AUTHORITY,
  AcpMockHarness
} from "./support/acpMockHarness.js";

const harnesses: AcpMockHarness[] = [];
const execFileAsync = promisify(execFile);
const spawnHarness = (scenario: ConstructorParameters<typeof AcpMockHarness>[0]) => {
  const harness = new AcpMockHarness(scenario);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("ACP mock subprocess harness", () => {
  it("keeps the connection-reuse gate hermetic and frozen at the F0 thresholds", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/acp-connection-reuse-gate.mjs", "--mock-only"],
      { cwd: process.cwd(), timeout: 30_000, maxBuffer: 2_000_000 }
    );
    const result = JSON.parse(stdout);

    expect(result.decision).toBe("NO-GO");
    expect(result.safety).toEqual({
      realPromptRequestsSent: 0,
      realAuthenticationRequestsSent: 0,
      credentialEnvironmentForwarded: false,
      capturedOutputContentEmitted: false,
      credentialShapedOutputDetected: false,
      realProbeOperations: ["initialize", "session/new", "session/cancel", "session/close"]
    });
    expect(result.thresholds).toEqual({
      workloadConcurrency: 4,
      minimumRounds: 3,
      processReductionPercent: 50,
      startupInitializeOrPeakRssReductionPercent: 20,
      maximumOtherMetricRegressionPercent: 15,
      mockStressIterations: 100,
      realMinimumSessionsPerConnection: 2
    });
    expect(result.mock.conformance).toEqual(
      expect.objectContaining({
        passed: true,
        stress: expect.objectContaining({
          iterations: 100,
          crossSessionFailures: 0,
          cancelledPrompts: 100,
          survivingPrompts: 100,
          failureRounds: 10,
          automaticReplayCount: 0,
          pendingPromises: 0,
          passed: true
        }),
        connectionFailure: expect.objectContaining({
          affectedOwners: 2,
          rejectedPrompts: 2,
          automaticReplay: false,
          passed: true
        })
      })
    );
    expect(result.mock.benchmark).toEqual(
      expect.objectContaining({
        passed: true,
        rounds: 3,
        cleanupConfirmed: true,
        outputSafe: true,
        metrics: expect.objectContaining({
          peakProcessTreeCount: expect.any(Object),
          workloadStartupInitializeWallMs: expect.any(Object),
          startupInitializeP95Ms: expect.any(Object),
          peakAggregateRssKiB: expect.any(Object)
        }),
        reductionsPercent: expect.objectContaining({ peakProcessTreeCount: 75 })
      })
    );
    expect(result.reasons).toContain(
      "Real-profile evidence was not measured; mock evidence cannot satisfy the gate."
    );
  }, 35_000);

  it("creates raw evidence only in a tool-owned private temporary directory", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/acp-connection-reuse-gate.mjs", "--mock-only", "--output"],
      { cwd: process.cwd(), timeout: 30_000, maxBuffer: 2_000_000 }
    );
    const result = JSON.parse(stdout);
    const rawOutputPath = result.rawOutputPath as string;
    const fromTemporaryRoot = relative(tmpdir(), rawOutputPath);
    expect(fromTemporaryRoot.startsWith("..")).toBe(false);
    expect(isAbsolute(fromTemporaryRoot)).toBe(false);
    expect(rawOutputPath.endsWith("/result.json")).toBe(true);
    expect(statSync(dirname(rawOutputPath)).mode & 0o777).toBe(0o700);
    expect(statSync(rawOutputPath).mode & 0o777).toBe(0o600);
    rmSync(dirname(rawOutputPath), { recursive: true, force: true });
  }, 35_000);

  it("fails closed for partial observers, unsafe eligibility, and output symlinks", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/acp-connection-reuse-gate/regression-cases.mjs"],
      { cwd: process.cwd(), timeout: 5_000 }
    );
    expect(JSON.parse(stdout)).toEqual({
      partialObserverFailureRejected: true,
      deadlineAndCleanupFailuresRejected: true,
      benchmarkCredentialOutputRejected: true,
      outputSymlinksRejected: true
    });
  });

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
      expect.objectContaining({
        method: "initialize",
        params: expect.objectContaining({ clientCapabilities: {} })
      })
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
          clientCapabilities: scenario === "elicitation" ? { elicitation: { form: {} } } : {}
        })
      );
      const sessionId = await harness.newSession();
      await expect(harness.prompt(sessionId)).resolves.toEqual(
        expect.objectContaining({ result: { stopReason: "end_turn" } })
      );
      expect(
        harness.traffic.some(
          (message) =>
            message.method ===
            (scenario === "permission" ? "session/request_permission" : "elicitation/create")
        )
      ).toBe(true);
    }
  });

  it("supports authentication errors, cancellation races, and late updates", async () => {
    const auth = spawnHarness("auth-required");
    await auth.initialize();
    await expect(
      auth.request("session/new", { cwd: process.cwd(), mcpServers: [] })
    ).resolves.toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: -32000 }) })
    );

    const late = spawnHarness("late-update");
    await late.initialize();
    const sessionId = await late.newSession();
    const prompt = late.prompt(sessionId);
    late.notify("session/cancel", { sessionId });
    await expect(prompt).resolves.toEqual(
      expect.objectContaining({ result: { stopReason: "cancelled" } })
    );
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
    await expect(delayed.initialize()).resolves.toEqual(
      expect.objectContaining({ result: expect.any(Object) })
    );

    const malformed = spawnHarness("malformed");
    await malformed.initialize();
    await expect
      .poll(() => malformed.malformed, {
        interval: 10,
        timeout: ACP_MOCK_OPERATION_TIMEOUT_MS,
        message: "Expected the mock ACP stdout parser to surface its delayed malformed line"
      })
      .toContain("{not-json}");
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

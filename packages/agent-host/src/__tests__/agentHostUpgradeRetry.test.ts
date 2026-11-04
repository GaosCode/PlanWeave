import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxDeliverySchema
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { attachHostEventPayloadBudget } from "./support/hostTransportSocketHarness.js";
import type { AgentHostExecutor } from "../execution/agentHostExecutor.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
});

async function setup(
  responses: Array<{ status: number; retryAfter?: string } | "welcome">,
  reconnect = { initialDelayMs: 100, maxDelayMs: 1_000 },
  options: { executor?: AgentHostExecutor; onWelcome?: (socket: WebSocket) => void } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "host-upgrade-retry-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  cleanup.push(async () => state.close());
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const sockets = new WebSocketServer({ noServer: true });
  attachHostEventPayloadBudget(sockets);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets.clients) socket.terminate();
        sockets.close(() => resolve());
      })
  );
  const clock = new FakeHostTransportClock();
  let upgrades = 0;
  let welcomes = 0;
  server.on("upgrade", (request, socket, head) => {
    const response = responses[upgrades++] ?? "welcome";
    if (response !== "welcome") {
      socket.end(
        `HTTP/1.1 ${response.status} Upgrade Rejected\r\n` +
          (response.retryAfter ? `Retry-After: ${response.retryAfter}\r\n` : "") +
          "Content-Length: 0\r\nConnection: close\r\n\r\n"
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit("connection", webSocket, request);
    });
  });
  sockets.on("connection", (socket) => {
    socket.once("message", () => {
      welcomes++;
      socket.send(
        JSON.stringify({
          type: "host.welcome",
          protocolVersion: agentHostProtocolVersion,
          exactPermissionOptionsVersion: 1,
          serverTime: clock.now().toISOString(),
          heartbeatIntervalMs: 60_000,
          leaseDurationMs: 60_000
        })
      );
      options.onWelcome?.(socket);
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_loopback_port");
  const client = new AgentHostClient({
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    serverUrl: `http://127.0.0.1:${address.port}`,
    hostId: "host-upgrade-retry",
    token: "test-token",
    capabilities: ["test"],
    capacity: 1,
    state,
    executor: options.executor ?? { execute: vi.fn() },
    clock,
    reconnect,
    random: () => 0,
    request: remoteRunnerEventV2Request,
    allowInsecureTransport: true
  });
  cleanup.push(() => client.stop());
  client.start();
  return { client, clock, state, upgrades: () => upgrades, welcomes: () => welcomes };
}

describe("Agent Host WebSocket upgrade recovery", () => {
  it.each([
    408, 429, 500, 502, 503, 504
  ])("retries HTTP %i once and reaches ready after a real loopback welcome", async (status) => {
    const run = await setup([{ status }, "welcome"]);
    await vi.waitFor(() =>
      expect(run.client.status()).toMatchObject({
        state: "backing-off",
        attempt: 1,
        delayMs: 50,
        reason: `upgrade_http_${status}`
      })
    );
    expect(run.clock.pendingTimerCount()).toBe(1);
    expect(run.upgrades()).toBe(1);
    run.clock.advanceBy(50);
    await vi.waitFor(() => expect(run.client.status().state).toBe("connected"));
    expect(run.upgrades()).toBe(2);
    expect(run.welcomes()).toBe(1);
    await run.client.stop();
    expect(run.clock.pendingTimerCount()).toBe(0);
  });

  it.each([
    [429, "2", 2_000],
    [503, "Thu, 23 Jul 2026 08:00:03 GMT", 3_000],
    [503, "999999999999999999999999", 30_000],
    [429, "Thu, 23 Jul 2026 07:59:00 GMT", 50],
    [503, "invalid", 50],
    [500, "2", 50]
  ])("bounds Retry-After on HTTP %i with %s", async (status, retryAfter, delayMs) => {
    const run = await setup([{ status, retryAfter }, "welcome"]);
    await vi.waitFor(() => expect(run.client.status().state).toBe("backing-off"));
    expect(run.clock.nextDelay()).toBe(delayMs);
    run.clock.advanceBy(delayMs);
    await vi.waitFor(() => expect(run.client.status().state).toBe("connected"));
    expect(run.upgrades()).toBe(2);
  });

  it.each([
    401, 403, 400, 404, 405, 409, 422, 501, 505
  ])("keeps HTTP %i terminal", async (status) => {
    const run = await setup([{ status }]);
    await vi.waitFor(() =>
      expect(run.client.status().state).toBe(
        status === 401 || status === 403 ? "auth-failed" : "degraded"
      )
    );
    expect(run.clock.pendingTimerCount()).toBe(0);
    run.clock.advanceBy(120_000);
    expect(run.upgrades()).toBe(1);
  });

  it("cancels the sole retry timer when stopped during an upgrade backoff", async () => {
    const run = await setup([{ status: 503 }, "welcome"]);
    await vi.waitFor(() => expect(run.client.status().state).toBe("backing-off"));
    expect(run.clock.pendingTimerCount()).toBe(1);
    await run.client.stop();
    expect(run.clock.pendingTimerCount()).toBe(0);
    run.clock.advanceBy(120_000);
    expect(run.upgrades()).toBe(1);
    expect(run.client.status()).toEqual({ state: "stopped" });
  });

  it("recovers after watchdog disconnect followed by a 503 upgrade", async () => {
    const run = await setup(["welcome", { status: 503 }, "welcome"]);
    await vi.waitFor(() => expect(run.client.status().state).toBe("connected"));
    expect(run.clock.pendingTimerCount()).toBe(2);
    run.clock.advanceBy(180_001);
    await vi.waitFor(() => expect(run.client.status().state).toBe("backing-off"));
    expect(run.clock.pendingTimerCount()).toBe(1);
    run.clock.advanceBy(50);
    await vi.waitFor(() => expect(run.upgrades()).toBe(2));
    await vi.waitFor(() =>
      expect(run.client.status()).toMatchObject({ reason: "upgrade_http_503" })
    );
    expect(run.clock.pendingTimerCount()).toBe(1);
    run.clock.advanceBy(100);
    await vi.waitFor(() => expect(run.client.status().state).toBe("connected"));
    expect(run.upgrades()).toBe(3);
    expect(run.welcomes()).toBe(2);
  });

  it("does not execute a delivered command twice across an upgrade failure", async () => {
    const envelope = executionEnvelopeSchema.parse({
      ...exampleExecutionEnvelopeInput,
      execution: { dispatchId: "dispatch-retry", attemptId: "attempt-retry" },
      projectId: "project-retry",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      workspaceId: "workspace-retry",
      agentId: "test-agent",
      agentProfileId: "acp.test",
      session: {},
      requiredCapabilities: ["test"]
    });
    const delivery = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      sequence: 1,
      previousSequence: 0,
      messageId: "mailbox-retry",
      command: {
        type: "execute_block",
        protocolVersion: agentHostProtocolVersion,
        dispatchId: envelope.execution.dispatchId,
        leaseId: "lease-retry",
        executionAttemptId: envelope.execution.attemptId,
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        envelopeDigest: hashExecutionEnvelope(envelope),
        envelope
      }
    });
    const execute = vi.fn(async () => ({
      summary: "completed once",
      reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
      artifactRefs: []
    }));
    const run = await setup(["welcome", { status: 503 }, "welcome"], undefined, {
      executor: { execute },
      onWelcome(socket) {
        socket.send(JSON.stringify(delivery));
      }
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(run.state.pendingExecutions(1)).toHaveLength(0));
    run.clock.advanceBy(180_001);
    await vi.waitFor(() => expect(run.client.status().state).toBe("backing-off"));
    run.clock.advanceBy(50);
    await vi.waitFor(() => expect(run.upgrades()).toBe(2));
    await vi.waitFor(() =>
      expect(run.client.status()).toMatchObject({ reason: "upgrade_http_503" })
    );
    run.clock.advanceBy(100);
    await vi.waitFor(() => expect(run.client.status().state).toBe("connected"));
    await vi.waitFor(() => expect(run.welcomes()).toBe(2));
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

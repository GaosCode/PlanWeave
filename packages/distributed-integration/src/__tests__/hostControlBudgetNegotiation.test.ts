import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import {
  exampleExecutionEnvelopeInput,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  hostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type HostEvent,
  type HostHello,
  type HostReadinessObservation
} from "@planweave-ai/agent-host-protocol";
import { parseAgentHostConfig } from "../../../agent-host/src/config/schema.js";
import { resolveAgentHostCapabilities } from "../../../agent-host/src/config/resolvers.js";
import type { AgentHostExecutor } from "../../../agent-host/src/execution/agentHostExecutor.js";
import { AgentHostClient } from "../../../agent-host/src/transport/agentHostClient.js";
import { serializeAgentHostHello } from "../../../agent-host/src/protocol.js";
import { openAgentHostState } from "../../../agent-host/src/state/agentHostState.js";
import { FakeHostTransportClock } from "../../../agent-host/src/__tests__/support/hostTransportTestClock.js";
import { remoteRunnerEventV2Request } from "../../../agent-host/src/__tests__/support/remoteRunnerEventCapabilityTestValues.js";
import { createRemoteAcpEventV2Fixture } from "../../../server/src/__tests__/support/remoteAcpEventV2Fixture.js";
import { createRemoteBlockCoordination } from "../../../server/src/distributedCoordination.js";
import { attachAgentHostWebSocketServer } from "../../../server/src/wsServer.js";
import { loopbackHttpTransportAdmission } from "../../../server/src/__tests__/support/transportAdmission.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(localBudget: number, serverBudget: number, projects = 212) {
  const f = await createRemoteAcpEventV2Fixture(() => new Date());
  cleanups.push(() => rm(f.directory, { recursive: true, force: true }));
  cleanups.push(() => f.server.close());
  const coordination = createRemoteBlockCoordination(
    f.server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 120_000,
      runtimeLeases: { acquire: vi.fn(), acquireForHost: vi.fn() },
      inputArtifacts: { materialize: vi.fn() },
      artifactContent: { readReport: vi.fn() }
    },
    { serverInstanceOwnerToken: f.server.serverInstanceOwnerToken }
  );
  const http = createServer();
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const transport = attachAgentHostWebSocketServer({
    server: http,
    ...coordination,
    heartbeatIntervalMs: 60_000,
    leaseDurationMs: 60_000,
    maxPayloadBytes: serverBudget,
    transportAdmission: loopbackHttpTransportAdmission
  });
  cleanups.push(() => transport.close());
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("expected_port");
  const config = parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: { url: `http://127.0.0.1:${address.port}`, allowInsecureDevelopment: true },
    dataDirectory: f.directory,
    workspaceRoot: f.directory,
    host: { displayName: "Budget Host", capacity: 1, capabilities: [] },
    workspaces: [],
    agentProfiles: []
  });
  const capabilities = resolveAgentHostCapabilities(config);
  const readiness: HostReadinessObservation = {
    workspaceMappings: [],
    acpProfiles: [],
    runtimeProjects: Array.from({ length: projects }, (_, index) => ({
      workspaceId: `w${index}`.padEnd(128, "w"),
      projectId: `p${index}`.padEnd(128, "p"),
      status: "ready"
    }))
  };
  const hello = () =>
    serializeAgentHostHello({
      type: "host.hello",
      protocolVersion: agentHostProtocolVersion,
      supportedExecutionEnvelopeVersions: [1, 2],
      lastAcknowledgedSequence: Number.MAX_SAFE_INTEGER,
      lastAcknowledgementRecoverySequence: Number.MAX_SAFE_INTEGER,
      capabilities,
      capacity: 1,
      readiness
    });
  if (projects === 212) {
    readiness.workspaceMappings.push({ workspaceId: "w", status: "ready" });
    const spare = 64 * 1024 - Buffer.byteLength(hello()) - 4;
    if (spare < 0) throw new Error("expected_hello_headroom");
    readiness.workspaceMappings[0]!.workspaceId += "w".repeat(spare);
  }
  const state = await openAgentHostState(join(f.directory, "control-host.sqlite"));
  cleanups.push(() => state.close());
  const clock = new FakeHostTransportClock(new Date());
  const execute = vi.fn<AgentHostExecutor["execute"]>(async (_command, context) => {
    await new Promise<void>((resolve) =>
      context.signal.addEventListener("abort", () => resolve(), { once: true })
    );
    throw new Error("fixture_execution_cancelled");
  });
  const options = {
    serverUrl: config.coordinator.url,
    hostId: f.host.id,
    token: f.token,
    capabilities,
    capacity: 1,
    readiness,
    state,
    executor: { execute },
    conversations: {
      handle: vi.fn(),
      recover: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isSessionActive: () => false
    },
    canvasRuntime: {
      enabled: () => true,
      start: vi.fn(),
      recover: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      disconnect: vi.fn(),
      handle: vi.fn(),
      synchronizeServerTime: vi.fn(),
      updateCredentialToken: vi.fn()
    },
    allowInsecureTransport: true,
    request: remoteRunnerEventV2Request,
    clock,
    limits: { maxPayloadBytes: localBudget },
    reconnect: { initialDelayMs: 10000, maxDelayMs: 10000 }
  };
  const sends = vi.spyOn(WebSocket.prototype, "send");
  const hostFrames = () =>
    sends.mock.calls.flatMap<HostEvent | HostHello>(([data]) => {
      const value = JSON.parse(String(data));
      const parsed = hostEventSchema.safeParse(value);
      if (parsed.success) return [parsed.data];
      const hello = hostHelloSchema.safeParse(value);
      return hello.success ? [hello.data] : [];
    });
  const serverFrames = () =>
    sends.mock.calls.flatMap(([data]) => {
      const parsed = serverEventSchema.safeParse(JSON.parse(String(data)));
      return parsed.success ? [parsed.data] : [];
    });
  const construct = () => {
    const client = new AgentHostClient(options);
    cleanups.push(() => client.stop());
    return client;
  };
  return {
    ...f,
    ...coordination,
    state,
    clock,
    execute,
    options,
    readiness,
    capabilities,
    construct,
    hostFrames,
    serverFrames,
    hello
  };
}

it.each([
  [64, 64],
  [64, 256],
  [256, 64]
])("negotiates local %iKiB and Server %iKiB for complete readiness and renewable lease frames", async (local, remote) => {
  const f = await setup(local * 1024, remote * 1024);
  expect(f.capabilities).toHaveLength(4);
  expect(Buffer.byteLength(f.hello())).toBeLessThanOrEqual(64 * 1024);
  const client = f.construct();
  const expires = new Date(Date.now() + 20_000).toISOString();
  const identity = {
    dispatchId: f.operation.dispatchId,
    leaseId: f.reservation.leaseId,
    executionAttemptId: f.operation.executionAttemptId
  };
  f.server.database
    .prepare("UPDATE dispatches SET lease_expires_at=? WHERE id=?")
    .run(expires, identity.dispatchId);
  f.server.database
    .prepare("UPDATE host_capacity_reservations SET lease_expires_at=? WHERE lease_id=?")
    .run(expires, identity.leaseId);
  f.server.database
    .prepare("UPDATE remote_execution_attempts SET lease_expires_at=? WHERE execution_attempt_id=?")
    .run(expires, identity.executionAttemptId);
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    execution: { dispatchId: identity.dispatchId, attemptId: identity.executionAttemptId },
    requiredCapabilities: []
  });
  f.mailbox.enqueue(
    f.host.id,
    executeBlockCommandSchema.parse({
      type: "execute_block",
      protocolVersion: agentHostProtocolVersion,
      ...identity,
      leaseExpiresAt: expires,
      envelope,
      envelopeDigest: hashExecutionEnvelope(envelope)
    })
  );
  client.start();
  await vi.waitFor(() =>
    expect(client.status(), JSON.stringify(client.status())).toMatchObject({ state: "connected" })
  );
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
  f.clock.advanceBy(0);
  await vi.waitFor(() => {
    const heartbeats = f.hostFrames().filter((event) => event.type === "host.heartbeat");
    expect(heartbeats.flatMap((event) => event.activeLeases)).toEqual([identity]);
    expect(heartbeats.filter((event) => event.readiness).map((event) => event.readiness)).toEqual([
      f.readiness
    ]);
  });
  await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
  const heartbeats = f.hostFrames().filter((event) => event.type === "host.heartbeat");
  expect(heartbeats.flatMap((event) => event.activeLeases)).toEqual([identity]);
  expect(heartbeats.filter((event) => event.readiness).map((event) => event.readiness)).toEqual([
    f.readiness
  ]);
  expect(f.hosts.getRequired(f.host.id).readinessObservation).toEqual(f.readiness);
  expect(
    f
      .hostFrames()
      .every((event) => Buffer.byteLength(JSON.stringify(event)) <= Math.min(local, remote) * 1024)
  ).toBe(true);
  await vi.waitFor(() =>
    expect(f.serverFrames()).toContainEqual(
      expect.objectContaining({ type: "lease.renewed", ...identity })
    )
  );
  await vi.waitFor(() =>
    expect(new Date(f.state.nextLeaseExpiresAt()!).getTime()).toBeGreaterThan(
      new Date(expires).getTime()
    )
  );
  expect(new Date(f.dispatches.get(identity.dispatchId)!.leaseExpiresAt).getTime()).toBeGreaterThan(
    new Date(expires).getTime()
  );
  for (const event of heartbeats)
    expect(f.serverFrames()).toContainEqual(
      expect.objectContaining({ type: "host.event_ack", messageId: event.messageId })
    );
});

it("rejects an unsendable hello at local construction before accepting work", async () => {
  const f = await setup(64 * 1024, 256 * 1024, 213);
  expect(() => f.construct()).toThrow("agent_host_control_payload_budget_too_small");
  expect(f.state.pendingEvents()).toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.hostFrames()).toEqual([]);
});

it("rejects a lower Server budget during Header negotiation before hello or work", async () => {
  const f = await setup(256 * 1024, 64 * 1024, 213);
  const client = f.construct();
  client.start();
  await vi.waitFor(() =>
    expect(client.status()).toMatchObject({
      state: "degraded",
      reason: "agent_host_control_payload_budget_too_small"
    })
  );
  expect(f.hostFrames()).toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.state.pendingEvents()).toEqual([]);
});

it("keeps the minimum mandatory control frame admission before accepting work", async () => {
  const f = await setup(256 * 1024, 64 * 1024, 0);
  f.options.capabilities = [];
  f.options.limits.maxPayloadBytes = 512;
  expect(() => f.construct()).toThrow("agent_host_control_payload_budget_too_small");
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.hostFrames()).toEqual([]);
  expect(f.state.pendingEvents()).toEqual([]);
});

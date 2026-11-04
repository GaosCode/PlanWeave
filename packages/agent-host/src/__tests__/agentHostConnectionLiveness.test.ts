import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { attachHostEventPayloadBudget } from "./support/hostTransportSocketHarness.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
});

async function setup(welcome = true) {
  const directory = await mkdtemp(join(tmpdir(), "host-liveness-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  cleanup.push(async () => state.close());
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const sockets = new WebSocketServer({ server });
  attachHostEventPayloadBudget(sockets);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets.clients) socket.terminate();
        sockets.close(() => resolve());
      })
  );
  const clock = new FakeHostTransportClock();
  let connections = 0;
  sockets.on("connection", (socket) => {
    connections++;
    socket.once("message", () => {
      if (welcome)
        socket.send(
          JSON.stringify({
            type: "host.welcome",
            protocolVersion: agentHostProtocolVersion,
            lastAcknowledgedSequence: 0,
            exactPermissionOptionsVersion: 1,
            serverTime: clock.now().toISOString(),
            heartbeatIntervalMs: 10_000,
            leaseDurationMs: 60_000
          })
        );
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const client = new AgentHostClient({
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    serverUrl: `http://127.0.0.1:${address.port}`,
    hostId: "host-liveness",
    token: "test-token",
    capabilities: [],
    capacity: 1,
    state,
    executor: { execute: vi.fn() },
    clock,
    request: remoteRunnerEventV2Request,
    allowInsecureTransport: true
  });
  cleanup.push(() => client.stop());
  await client.start();
  await vi.waitFor(() => expect(connections).toBe(1));
  if (welcome) await vi.waitFor(() => expect(client.status().state).toBe("connected"));
  return { client, clock, sockets, state, connections: () => connections };
}

it("reconnects an open but unresponsive connection and stops all watchdog timers on shutdown", async () => {
  const { client, clock, connections } = await setup();
  clock.advanceBy(30_001);
  await vi.waitFor(() => expect(client.status().state).toBe("backing-off"));
  clock.advanceBy(10_000);
  await vi.waitFor(() => expect(connections()).toBe(2));
  await vi.waitFor(() => expect(client.status().state).toBe("connected"));
  await client.stop();
  expect(clock.pendingTimerCount()).toBe(0);
  clock.advanceBy(120_000);
  expect(connections()).toBe(2);
});

it("bounds an upgraded connection that never sends welcome", async () => {
  const { client, clock } = await setup(false);
  clock.advanceBy(30_001);
  await vi.waitFor(() => expect(client.status().state).toBe("backing-off"));
});

it("keeps a responsive idle connection alive across many deadlines", async () => {
  const { client, clock, sockets, state, connections } = await setup();
  for (const socket of sockets.clients) {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.messageId)
        socket.send(
          JSON.stringify({
            type: "host.event_ack",
            protocolVersion: agentHostProtocolVersion,
            messageId: event.messageId
          })
        );
    });
  }
  for (let index = 0; index < 10; index++) {
    clock.advanceBy(10_000);
    await vi.waitFor(() => expect(state.pendingEvents()).toHaveLength(0));
    expect(client.status().state).toBe("connected");
  }
  expect(connections()).toBe(1);
});

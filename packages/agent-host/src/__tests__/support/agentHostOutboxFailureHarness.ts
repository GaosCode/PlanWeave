import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acpConversationPromptCommandSchema,
  exampleExecutionEnvelopeInput,
  hostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type HostEvent
} from "@planweave-ai/agent-host-protocol";
import { expect, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { openAgentHostState } from "../../state/agentHostState.js";
import { openAgentHostDatabase } from "../../state/sqliteDatabase.js";
import { AgentHostClient } from "../../transport/agentHostClient.js";
import { FakeHostTransportClock } from "./hostTransportTestClock.js";
import { remoteRunnerEventV2Request } from "./remoteRunnerEventCapabilityTestValues.js";

export async function outboxFailureHarness(cleanups: Array<() => void | Promise<void>>) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-outbox-failure-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "host.sqlite");
  const state = await openAgentHostState(path);
  cleanups.push(() => state.close());
  const database = await openAgentHostDatabase(path, 5_000);
  cleanups.push(() => database.close());
  const command = acpConversationPromptCommandSchema.parse({
    type: "acp_conversation.prompt",
    protocolVersion: 1,
    operationId: "failure-op",
    turnId: "failure-turn",
    executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
    sessionId: "failure-session",
    text: "Continue",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
  });
  state.conversations.accept(command);
  state.conversations.start(command.turnId);
  const subscribed = state.subscribeOutboxReady.bind(state);
  let attached = 0;
  let notifications = 0;
  vi.spyOn(state, "subscribeOutboxReady").mockImplementation((listener) => {
    attached += 1;
    const unsubscribe = subscribed(() => {
      notifications += 1;
      listener();
    });
    return () => {
      attached -= 1;
      unsubscribe();
    };
  });
  const http = createServer();
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const server = new WebSocketServer({ server: http });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const received: HostEvent[] = [];
  let connections = 0;
  let peer: WebSocket | undefined;
  let autoAck = true;
  server.on("connection", (socket) => {
    connections += 1;
    peer = socket;
    socket.on("message", (data) => {
      const raw = JSON.parse(data.toString());
      if (raw.type === "host.hello") {
        hostHelloSchema.parse(raw);
        socket.send(
          JSON.stringify(
            serverEventSchema.parse({
              type: "host.welcome",
              protocolVersion: 1,
              exactPermissionOptionsVersion: 1,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 60_000,
              leaseDurationMs: 60_000
            })
          )
        );
        return;
      }
      const event = hostEventSchema.parse(raw);
      received.push(event);
      if (autoAck)
        socket.send(
          JSON.stringify({
            type: "host.event_ack",
            protocolVersion: 1,
            messageId: event.messageId
          })
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("expected_http_port");
  const clock = new FakeHostTransportClock();
  const client = new AgentHostClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    hostId: "host-outbox-failure",
    token: "host-token",
    capabilities: ["test"],
    capacity: 1,
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    state,
    executor: {
      execute: async () => {
        throw new Error("unexpected_execution");
      }
    },
    request: remoteRunnerEventV2Request,
    allowInsecureTransport: true,
    clock,
    random: () => 0,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1_000 }
  });
  cleanups.push(() => client.stop());
  client.start();
  await vi.waitFor(() => expect(state.pendingEventCount()).toBe(0));
  clock.advanceBy(0);
  await vi.waitFor(() => {
    expect(received.some((event) => event.type === "host.heartbeat")).toBe(true);
    expect(state.pendingEventCount()).toBe(0);
  });
  received.length = 0;
  return {
    state,
    database,
    client,
    clock,
    received,
    connections: () => connections,
    attached: () => attached,
    notifications: () => notifications,
    setAutoAck: (value: boolean) => {
      autoAck = value;
    },
    peer: () => {
      if (!peer) throw new Error("peer_not_connected");
      return peer;
    },
    append: (size = 10) =>
      state.conversations.append(command.turnId, {
        kind: "interaction",
        request: {
          kind: "elicitation",
          requestId: `elicitation-${size}`,
          message: "Input",
          deadline: new Date(Date.now() + 60_000).toISOString(),
          requestedSchema: { type: "object", description: "x".repeat(size) }
        }
      })
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  hostHelloSchema,
  mailboxDeliverySchema,
  serverEventSchema,
  type ServerEvent
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AgentHostExecutor } from "../execution/agentHostExecutor.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const clients: AgentHostClient[] = [];
const httpServers: HttpServer[] = [];
const webSocketServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    webSocketServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
  await Promise.all(
    httpServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function openState(): Promise<AgentHostState> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-load-"));
  directories.push(directory);
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  states.push(state);
  return state;
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_http_port");
  return address.port;
}

function welcome(): ServerEvent {
  return serverEventSchema.parse({
    type: "host.welcome",
    protocolVersion: 1,
    serverTime: new Date().toISOString(),
    heartbeatIntervalMs: 60_000,
    leaseDurationMs: 60_000
  });
}

function delivery(sequence: number): ServerEvent {
  const suffix = String(sequence).padStart(3, "0");
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    execution: {
      dispatchId: `dispatch-load-${suffix}`,
      attemptId: `attempt-load-${suffix}`
    },
    projectId: "project-load",
    taskId: "T-001",
    blockRef: "T-001#B-001",
    sourceRevision: "source-load-001",
    renderedPrompt: "Exercise bounded transport shutdown under load.",
    acceptance: ["Do not lose durable execution state."],
    dependencySummaries: [],
    inputArtifacts: [],
    workspaceId: "workspace-load",
    agentId: "test-agent",
    agentProfileId: "acp.test",
    session: {},
    requiredCapabilities: ["test"],
    output: { reportRequired: true, maxArtifactBytes: 4096, maxArtifactCount: 1 },
    trace: { correlationId: `correlation-load-${suffix}` }
  });
  return mailboxDeliverySchema.parse({
    type: "mailbox.message",
    protocolVersion: 1,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-load-${suffix}`,
    command: {
      type: "execute_block",
      protocolVersion: 1,
      dispatchId: envelope.execution.dispatchId,
      leaseId: `lease-load-${suffix}`,
      executionAttemptId: envelope.execution.attemptId,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      envelopeDigest: hashExecutionEnvelope(envelope),
      envelope
    }
  });
}

function createClient(
  port: number,
  state: AgentHostState,
  executor: AgentHostExecutor,
  options: Partial<ConstructorParameters<typeof AgentHostClient>[0]> = {}
): AgentHostClient {
  const client = new AgentHostClient({
    serverUrl: `http://127.0.0.1:${port}`,
    hostId: "host-load-001",
    workspaceId: "workspace-load",
    token: "host-token",
    capabilities: ["test"],
    capacity: 1,
    state,
    executor,
    request: remoteRunnerEventV2Request,
    allowInsecureTransport: true,
    ...options
  });
  clients.push(client);
  return client;
}

describe("Agent Host transport load and recovery boundaries", () => {
  it("bounds a reconnect storm and preserves monotonically increasing attempts", async () => {
    const stable = deferred<void>();
    const protocolFailure = deferred<unknown>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    let connectionCount = 0;
    webSocketServer.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        try {
          hostHelloSchema.parse(JSON.parse(data.toString()));
          if (connectionCount <= 8) socket.close(1012, "bounded restart storm");
          else {
            socket.send(JSON.stringify(welcome()));
            stable.resolve();
          }
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const attempts: number[] = [];
    const delays: number[] = [];
    const client = createClient(
      port,
      state,
      { execute: vi.fn() },
      {
        reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
        random: () => 0
      }
    );
    client.subscribe((status) => {
      if (status.state === "backing-off") {
        attempts.push(status.attempt);
        delays.push(status.delayMs);
      }
    });
    client.start();

    await Promise.race([stable.promise, protocolFailure.promise]);
    expect(connectionCount).toBe(9);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(delays).toEqual(Array(8).fill(1));
  });

  it("rejects only the over-budget delivery when an inbound burst exceeds the queue", async () => {
    const degraded = deferred<void>();
    const executed = deferred<void>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as { type?: string };
        if (event.type === "host.hello") {
          socket.send(JSON.stringify(welcome()));
          return;
        }
        if (event.type === "host.heartbeat") {
          const transport = Reflect.get(socket, "_socket");
          if (!(transport instanceof Socket)) throw new Error("expected_websocket_transport");
          transport.cork();
          socket.send(JSON.stringify(delivery(1)));
          socket.send(JSON.stringify(delivery(2)));
          transport.uncork();
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const execute = vi.fn(async () => executed.resolve());
    const client = createClient(port, state, { execute }, { limits: { maxQueuedMessages: 1 } });
    client.subscribe((status) => {
      if (status.state === "degraded" && status.reason === "inbound_backpressure") {
        degraded.resolve();
      }
    });
    client.start();

    await degraded.promise;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await executed.promise;
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ dispatchId: "dispatch-load-001" });
  });

  it("drains a durable outbound backlog without overflowing amplified server responses", async () => {
    const allSeededEventsReceived = deferred<void>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    const state = await openState();
    for (let sequence = 1; sequence <= 80; sequence += 1) {
      state.receive(delivery(sequence));
    }
    const seededMessageIds = new Set(state.pendingEvents().map((event) => event.messageId));
    const receivedSeededMessageIds = new Set<string>();
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as { type?: string; messageId?: string };
        if (event.type === "host.hello") {
          socket.send(JSON.stringify(welcome()));
          return;
        }
        if (!event.messageId) return;
        if (seededMessageIds.has(event.messageId)) {
          receivedSeededMessageIds.add(event.messageId);
          if (receivedSeededMessageIds.size === seededMessageIds.size) {
            allSeededEventsReceived.resolve();
          }
        }
        socket.send(
          JSON.stringify(
            serverEventSchema.parse({
              type: "host.event_ack",
              protocolVersion: 1,
              messageId: event.messageId
            })
          )
        );
        socket.send(
          JSON.stringify(
            serverEventSchema.parse({
              type: "lease.renewed",
              protocolVersion: 1,
              dispatchId: "dispatch-load-001",
              leaseId: "lease-load-001",
              executionAttemptId: "attempt-load-001",
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
            })
          )
        );
      });
    });
    const port = await listen(httpServer);
    const degraded: string[] = [];
    const client = createClient(
      port,
      state,
      {
        execute: vi.fn(
          async (_command, context) =>
            new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), { once: true })
            )
        )
      },
      { limits: { maxQueuedMessages: 128, maxOutboundBatch: 128 } }
    );
    client.subscribe((status) => {
      if (status.state === "degraded") degraded.push(status.reason);
    });
    client.start();

    await allSeededEventsReceived.promise;
    await vi.waitFor(() => expect(state.pendingEventCount()).toBe(0), { timeout: 5_000 });
    expect(degraded).toEqual([]);
  });

  it("rejects a frame above maxPayloadBytes without invoking the executor", async () => {
    const backingOff = deferred<void>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", () => socket.send("x".repeat(2_048)));
    });
    const port = await listen(httpServer);
    const state = await openState();
    const execute = vi.fn();
    const client = createClient(
      port,
      state,
      { execute },
      {
        limits: { maxPayloadBytes: 1_024, maxBufferedBytes: 2_048 },
        reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000 }
      }
    );
    client.subscribe((status) => {
      if (status.state === "backing-off") backingOff.resolve();
    });
    client.start();

    await backingOff.promise;
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts and preserves eight durable executions during shutdown load", async () => {
    const allStarted = deferred<void>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString());
        if (event.type !== "host.hello") return;
        socket.send(JSON.stringify(welcome()));
        for (let sequence = 1; sequence <= 8; sequence += 1) {
          socket.send(JSON.stringify(delivery(sequence)));
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    let started = 0;
    const client = createClient(
      port,
      state,
      {
        execute: vi.fn(async (_command, context) => {
          started += 1;
          if (started === 8) allStarted.resolve();
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true })
          );
          return {
            summary: "Execution stopped at the shutdown boundary.",
            reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
            artifactRefs: []
          };
        })
      },
      { capacity: 8, limits: { shutdownTimeoutMs: 1_000 } }
    );
    client.start();

    await allStarted.promise;
    await expect(client.stop()).resolves.toBeUndefined();
    expect(started).toBe(8);
    expect(state.recoverableExecutionCount()).toBe(8);
  });
});

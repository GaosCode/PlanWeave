import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  hostEventSchema,
  hostHelloSchema,
  mailboxDeliverySchema,
  serverEventSchema,
  type HostEvent,
  type ServerEvent
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { AgentHostExecutionError, type AgentHostExecutor } from "../execution/agentHostExecutor.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const clients: AgentHostClient[] = [];
const httpServers: HttpServer[] = [];
const webSocketServers: WebSocketServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const state of states.splice(0)) state.close();
  await Promise.all(webSocketServers.splice(0).map((server) => closeWebSocketServer(server)));
  await Promise.all(httpServers.splice(0).map((server) => closeHttpServer(server)));
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

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function openState(): Promise<AgentHostState> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-client-"));
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

function executeDelivery(sequence = 1): Extract<ServerEvent, { type: "mailbox.message" }> {
  const suffix = String(sequence).padStart(3, "0");
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    execution: {
      dispatchId: `dispatch-client-${suffix}`,
      attemptId: `attempt-client-${suffix}`
    },
    projectId: "project-client",
    taskId: "T-001",
    blockRef: "T-001#B-001",
    sourceRevision: "source-client-001",
    renderedPrompt: "Execute the assigned Agent Host boundary test.",
    acceptance: ["Return a verified report artifact."],
    dependencySummaries: [],
    inputArtifacts: [],
    workspaceId: "workspace-client",
    agentId: "test-agent",
    agentProfileId: "acp.test",
    session: {},
    requiredCapabilities: ["test"],
    output: {
      reportRequired: true,
      maxArtifactBytes: 4096,
      maxArtifactCount: 1
    },
    trace: {
      correlationId: "correlation-client-001"
    }
  });
  return mailboxDeliverySchema.parse({
    type: "mailbox.message",
    protocolVersion: 1,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-client-${sequence}`,
    command: {
      type: "execute_block",
      protocolVersion: 1,
      dispatchId: envelope.execution.dispatchId,
      leaseId: `lease-client-${suffix}`,
      executionAttemptId: envelope.execution.attemptId,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      envelopeDigest: hashExecutionEnvelope(envelope),
      envelope
    }
  });
}

function cancelDelivery(execute: Extract<ServerEvent, { type: "mailbox.message" }>): ServerEvent {
  if (execute.command.type !== "execute_block") throw new Error("execute_command_required");
  return serverEventSchema.parse({
    type: "mailbox.message",
    protocolVersion: 1,
    sequence: execute.sequence + 1,
    previousSequence: execute.sequence,
    messageId: `mailbox-client-${execute.sequence + 1}`,
    command: {
      type: "cancel_execution",
      protocolVersion: 1,
      dispatchId: execute.command.dispatchId,
      leaseId: execute.command.leaseId,
      executionAttemptId: execute.command.executionAttemptId,
      reason: "Cancel the boundary test."
    }
  });
}

function sendEvent(socket: import("ws").WebSocket, event: ServerEvent): void {
  socket.send(JSON.stringify(event));
}

function acknowledge(socket: import("ws").WebSocket, event: HostEvent): void {
  if (!("messageId" in event)) return;
  sendEvent(
    socket,
    serverEventSchema.parse({
      type: "host.event_ack",
      protocolVersion: 1,
      messageId: event.messageId
    })
  );
}

describe("Agent Host outbound transport", () => {
  it("requires secure transport unless loopback development is explicit", async () => {
    const state = await openState();
    const executor: AgentHostExecutor = {
      execute: vi.fn()
    };

    expect(
      () =>
        new AgentHostClient({
          serverUrl: "http://127.0.0.1:3000",
          hostId: "host-client-001",
          workspaceId: "workspace-client",
          token: "host-token",
          capabilities: ["test"],
          capacity: 1,
          state,
          executor
        })
    ).toThrow("agent_host_secure_transport_required");
  });

  it("rejects an execution envelope outside the local credential Workspace before execution", async () => {
    const failed = deferred<Extract<HostEvent, { type: "dispatch.failed" }>>();
    const executor: AgentHostExecutor = { execute: vi.fn() };
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const raw = JSON.parse(data.toString());
        if (raw.type === "host.hello") {
          hostHelloSchema.parse(raw);
          sendEvent(socket, welcome());
          sendEvent(socket, executeDelivery());
          return;
        }
        const event = hostEventSchema.parse(raw);
        acknowledge(socket, event);
        if (event.type === "dispatch.failed") failed.resolve(event);
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-other",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      allowInsecureTransport: true
    });
    clients.push(client);
    client.start();

    await expect(failed.promise).resolves.toMatchObject({
      failure: {
        code: "host_workspace_mismatch",
        retryable: false
      }
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("executes a dispatch and retries a dispatch-scoped artifact upload", async () => {
    const completed = deferred<Extract<HostEvent, { type: "dispatch.completed" }>>();
    const protocolFailure = deferred<unknown>();
    const uploads: Array<{
      authorization: string | undefined;
      body: Buffer;
      contentType: string | undefined;
      operationId: string | undefined;
      path: string | undefined;
      purpose: string | undefined;
    }> = [];
    const report = Buffer.from("# Remote result\n\nExecution completed.\n");
    const digest = createHash("sha256").update(report).digest("hex");
    const delivery = executeDelivery();
    const httpServer = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        uploads.push({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks),
          contentType: request.headers["content-type"],
          operationId: request.headers["x-planweave-artifact-operation-id"] as string | undefined,
          path: request.url,
          purpose: request.headers["x-planweave-artifact-purpose"] as string | undefined
        });
        if (uploads.length === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ref: `artifact:sha256:${digest}` }));
      } catch (error) {
        protocolFailure.reject(error);
      }
    });
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket, request) => {
      expect(request.url).toBe("/agent-hosts/host-client-001/connect?workspaceId=workspace-client");
      expect(request.headers.authorization).toBe("Bearer host-token");
      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          if (raw.type === "host.hello") {
            expect(hostHelloSchema.parse(raw)).toMatchObject({
              capabilities: ["test"],
              capacity: 1
            });
            sendEvent(socket, welcome());
            sendEvent(socket, delivery);
            return;
          }
          const event = hostEventSchema.parse(raw);
          acknowledge(socket, event);
          if (event.type === "dispatch.completed") completed.resolve(event);
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const executor: AgentHostExecutor = {
      async execute(command, context) {
        expect(command.dispatchId).toBe("dispatch-client-001");
        expect(context.executionKey).toBe(
          "dispatch-client-001:lease-client-001:attempt-client-001"
        );
        const reportArtifactRef = await context.artifacts.upload({
          bytes: report,
          mediaType: "Text/Markdown ; Charset=utf-8",
          purpose: "report",
          operationKey: "primary-report"
        });
        return {
          summary: "Remote execution completed.",
          reportArtifactRef,
          artifactRefs: []
        };
      }
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      allowInsecureTransport: true
    });
    clients.push(client);
    client.start();

    const event = await Promise.race([completed.promise, protocolFailure.promise]);
    expect(event).toMatchObject({
      result: {
        summary: "Remote execution completed.",
        reportArtifactRef: `artifact:sha256:${digest}`
      }
    });
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toEqual(uploads[1]);
    expect(uploads[1]).toMatchObject({
      authorization: "Bearer host-token",
      body: report,
      contentType: "text/markdown; charset=utf-8",
      path:
        "/agent-hosts/host-client-001/dispatches/dispatch-client-001/leases/lease-client-001/attempts/attempt-client-001/artifacts/" +
        `${digest}?workspaceId=workspace-client`,
      purpose: "report"
    });
    expect(uploads[1]?.operationId).toMatch(/^artifact-upload:[a-f0-9]{64}$/);
    expect(state.pendingExecutions(1)).toEqual([]);
  });

  it("preserves a bounded typed executor failure on the durable dispatch event", async () => {
    const failed = deferred<Extract<HostEvent, { type: "dispatch.failed" }>>();
    const protocolFailure = deferred<unknown>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          if (raw.type === "host.hello") {
            hostHelloSchema.parse(raw);
            sendEvent(socket, welcome());
            sendEvent(socket, executeDelivery());
            return;
          }
          const event = hostEventSchema.parse(raw);
          acknowledge(socket, event);
          if (event.type === "dispatch.failed") failed.resolve(event);
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const executor: AgentHostExecutor = {
      execute: async () => {
        throw new AgentHostExecutionError({
          code: "acp_capability_missing",
          message: "The resolved ACP agent lacks a required capability.",
          retryable: false
        });
      }
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      allowInsecureTransport: true
    });
    clients.push(client);
    client.start();

    await expect(Promise.race([failed.promise, protocolFailure.promise])).resolves.toMatchObject({
      failure: {
        code: "acp_capability_missing",
        message: "The resolved ACP agent lacks a required capability.",
        retryable: false
      }
    });
  });

  it("aborts the exact active execution when cancellation arrives", async () => {
    const failed = deferred<Extract<HostEvent, { type: "dispatch.failed" }>>();
    const protocolFailure = deferred<unknown>();
    const delivery = executeDelivery();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          if (raw.type === "host.hello") {
            hostHelloSchema.parse(raw);
            sendEvent(socket, welcome());
            sendEvent(socket, delivery);
            return;
          }
          const event = hostEventSchema.parse(raw);
          acknowledge(socket, event);
          if (event.type === "dispatch.accepted") {
            sendEvent(socket, cancelDelivery(delivery));
          }
          if (event.type === "dispatch.failed") failed.resolve(event);
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const executor: AgentHostExecutor = {
      execute: (_command, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        })
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      allowInsecureTransport: true
    });
    clients.push(client);
    client.start();

    const event = await Promise.race([failed.promise, protocolFailure.promise]);
    expect(event).toMatchObject({
      failure: {
        code: "execution_cancelled",
        retryable: false
      }
    });
    expect(state.activeLeases()).toEqual([]);
  });

  it("does not use advertised collaboration capacity to serialize delivered executions", async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStored = deferred<void>();
    const bothCompleted = deferred<void>();
    const protocolFailure = deferred<unknown>();
    const deliveries = [executeDelivery(1), executeDelivery(2)];
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    let completedCount = 0;
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          if (raw.type === "host.hello") {
            hostHelloSchema.parse(raw);
            sendEvent(socket, welcome());
            for (const delivery of deliveries) sendEvent(socket, delivery);
            return;
          }
          const event = hostEventSchema.parse(raw);
          acknowledge(socket, event);
          if (event.type === "mailbox.ack" && event.sequence === 2) secondStored.resolve();
          if (event.type === "dispatch.completed") {
            completedCount += 1;
            if (completedCount === 2) bothCompleted.resolve();
          }
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    let activeCount = 0;
    let executeCount = 0;
    let maxActiveCount = 0;
    const executor: AgentHostExecutor = {
      async execute() {
        executeCount += 1;
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        try {
          if (executeCount === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          } else {
            secondStarted.resolve();
          }
          return {
            summary: "Capacity boundary execution completed.",
            reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
            artifactRefs: []
          };
        } finally {
          activeCount -= 1;
        }
      }
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      allowInsecureTransport: true
    });
    clients.push(client);
    client.start();

    await Promise.race([
      Promise.all([firstStarted.promise, secondStarted.promise, secondStored.promise]),
      protocolFailure.promise
    ]);
    expect(executeCount).toBe(2);
    expect(maxActiveCount).toBe(2);
    releaseFirst.resolve();
    await Promise.race([bothCompleted.promise, protocolFailure.promise]);
    expect(executeCount).toBe(2);
    expect(maxActiveCount).toBe(2);
  });

  it("reconnects with the durable acknowledgement cursor", async () => {
    const reconnected = deferred<void>();
    const backingOff = deferred<void>();
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
          const hello = hostHelloSchema.parse(JSON.parse(data.toString()));
          expect(hello.lastAcknowledgedSequence).toBe(0);
          if (connectionCount === 1) {
            socket.close(1012, "restart transport");
          } else {
            reconnected.resolve();
          }
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const clock = new FakeHostTransportClock();
    const executor: AgentHostExecutor = { execute: vi.fn() };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      allowInsecureTransport: true,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1_000 },
      clock,
      random: () => 0
    });
    client.subscribe((status) => {
      if (status.state === "backing-off") {
        expect(status).toMatchObject({ attempt: 1, delayMs: 50 });
        backingOff.resolve();
      }
    });
    clients.push(client);
    client.start();

    await Promise.race([backingOff.promise, protocolFailure.promise]);
    expect(clock.nextDelay()).toBe(50);
    clock.advanceBy(50);
    await Promise.race([reconnected.promise, protocolFailure.promise]);
    expect(connectionCount).toBe(2);
  });

  it("treats a superseded Host connection as terminal instead of reconnecting", async () => {
    const terminal = deferred<void>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    let connectionCount = 0;
    webSocketServer.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", () => socket.close(4001, "superseded"));
    });
    const port = await listen(httpServer);
    const state = await openState();
    const clock = new FakeHostTransportClock();
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor: { execute: vi.fn() },
      allowInsecureTransport: true,
      clock
    });
    client.subscribe((status) => {
      if (status.state === "degraded" && status.reason === "duplicate_host_connection") {
        terminal.resolve();
      }
    });
    clients.push(client);
    client.start();

    await terminal.promise;
    clock.advanceBy(60_000);
    await Promise.resolve();
    expect(connectionCount).toBe(1);
    expect(client.status()).toEqual({
      state: "degraded",
      reason: "duplicate_host_connection"
    });
  });

  it("surfaces replay beyond the compact receipt horizon as reconciliation-required", async () => {
    const terminal = deferred<void>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    let connectionCount = 0;
    webSocketServer.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === "host.hello") {
          sendEvent(socket, welcome());
          sendEvent(socket, executeDelivery());
        }
      });
    });
    const port = await listen(httpServer);
    const durableState = await openState();
    const state = new Proxy(durableState, {
      get(target, property, receiver) {
        if (property === "receive") {
          return () => {
            throw new Error("mailbox_message_retention_horizon_exceeded");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const clock = new FakeHostTransportClock();
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor: { execute: vi.fn() },
      allowInsecureTransport: true,
      clock
    });
    client.subscribe((status) => {
      if (status.state === "reconciliation-required") terminal.resolve();
    });
    clients.push(client);
    client.start();

    await terminal.promise;
    clock.advanceBy(60_000);
    await Promise.resolve();
    expect(connectionCount).toBe(1);
    expect(client.status()).toEqual({
      state: "reconciliation-required",
      reason: "mailbox_message_retention_horizon_exceeded"
    });
    await client.stop();
    expect(client.status()).toEqual({
      state: "reconciliation-required",
      reason: "mailbox_message_retention_horizon_exceeded"
    });
  });

  it("fails bounded shutdown without closing durable state while an active run ignores abort", async () => {
    const executionStarted = deferred<void>();
    const releaseExecution = deferred<void>();
    const protocolFailure = deferred<unknown>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === "host.hello") {
            sendEvent(socket, welcome());
            sendEvent(socket, executeDelivery());
          }
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const clock = new FakeHostTransportClock();
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor: {
        async execute() {
          executionStarted.resolve();
          await releaseExecution.promise;
          return {
            summary: "Execution eventually returned after shutdown.",
            reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
            artifactRefs: []
          };
        }
      },
      allowInsecureTransport: true,
      clock,
      limits: { shutdownTimeoutMs: 100 }
    });
    clients.push(client);
    client.start();

    await Promise.race([executionStarted.promise, protocolFailure.promise]);
    const stopping = client.stop();
    await vi.waitFor(() => expect(clock.nextDelay()).toBe(100));
    clock.advanceBy(100);
    await expect(stopping).rejects.toThrow("agent_host_transport_shutdown_timeout");
    expect(state.recoverableExecutionCount()).toBe(1);

    releaseExecution.resolve();
    await vi.waitFor(async () => {
      await expect(client.stop()).resolves.toBeUndefined();
    });
  });

  it("propagates renewed credentials to the Canvas Runtime transfer service", async () => {
    const rotated = deferred<string>();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServers.push(webSocketServer);
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === "host.hello") sendEvent(socket, welcome());
      });
    });
    const port = await listen(httpServer);
    const state = await openState();
    const nextToken = `pw_host_${"b".repeat(43)}`;
    const canvasRuntime = {
      enabled: () => true,
      recover: vi.fn(),
      disconnect: vi.fn(),
      handle: vi.fn(async () => {}),
      synchronizeServerTime: vi.fn(),
      updateCredentialToken: vi.fn((token: string) => rotated.resolve(token))
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${port}`,
      hostId: "host-client-001",
      token: "host-token",
      credentialRenewal: {
        poll: vi.fn(async () => ({
          hostId: "host-client-001",
          credentialToken: nextToken,
          issuedAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-07-01T00:00:00.000Z"
        }))
      },
      capabilities: ["test"],
      capacity: 1,
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      state,
      executor: { execute: vi.fn() },
      canvasRuntime,
      allowInsecureTransport: true
    });
    clients.push(client);
    client.start();

    await expect(rotated.promise).resolves.toBe(nextToken);
    expect(canvasRuntime.updateCredentialToken).toHaveBeenCalledOnce();
  });
});

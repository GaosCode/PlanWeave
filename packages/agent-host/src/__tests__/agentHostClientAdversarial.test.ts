import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acpConversationPromptCommandSchema,
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  hostEventSchema,
  hostHelloSchema,
  mailboxDeliverySchema,
  serverEventSchema,
  type AcpConversationEvent,
  type HostEvent
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { attachHostEventPayloadBudget } from "./support/hostTransportSocketHarness.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";
import type { AgentHostExecutor } from "../execution/agentHostExecutor.js";
import { AgentHostState, openAgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
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

describe("Agent Host adversarial executor failure", () => {
  it("maps a 20KB private error to a durable safe terminal event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-adversarial-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const state = await openAgentHostState(join(directory, "host.sqlite"));
    cleanups.push(() => state.close());
    const failed = deferred<Extract<HostEvent, { type: "dispatch.failed" }>>();
    const protocolFailure = deferred<unknown>();
    const secret = "token=host-secret-value";
    const privatePath = "/Users/private/worktree/plan.md";
    const envelope = executionEnvelopeSchema.parse({
      ...exampleExecutionEnvelopeInput,
      execution: { dispatchId: "dispatch-adversarial", attemptId: "attempt-adversarial" },
      projectId: "project-adversarial",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      workspaceId: "workspace-client"
    });
    const delivery = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      sequence: 1,
      previousSequence: 0,
      messageId: "mailbox-adversarial",
      command: {
        type: "execute_block",
        protocolVersion: agentHostProtocolVersion,
        dispatchId: envelope.execution.dispatchId,
        leaseId: "lease-adversarial",
        executionAttemptId: envelope.execution.attemptId,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        envelopeDigest: hashExecutionEnvelope(envelope),
        envelope
      }
    });
    const httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const webSocketServer = new WebSocketServer({ server: httpServer });
    attachHostEventPayloadBudget(webSocketServer);
    cleanups.push(() => new Promise<void>((resolve) => webSocketServer.close(() => resolve())));
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          if (raw.type === "host.hello") {
            hostHelloSchema.parse(raw);
            socket.send(
              JSON.stringify(
                serverEventSchema.parse({
                  type: "host.welcome",
                  exactPermissionOptionsVersion: 1,
                  protocolVersion: agentHostProtocolVersion,
                  lastAcknowledgedSequence: 0,
                  serverTime: new Date().toISOString(),
                  heartbeatIntervalMs: 60_000,
                  leaseDurationMs: 60_000
                })
              )
            );
            socket.send(JSON.stringify(delivery));
            return;
          }
          const event = hostEventSchema.parse(raw);
          if (event.type === "dispatch.failed") failed.resolve(event);
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("expected_http_port");
    const executor: AgentHostExecutor = {
      execute: async () => {
        throw new Error(`${privatePath} ${secret} ${"x".repeat(20_000)}`);
      }
    };
    const client = new AgentHostClient({
      readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: "host-adversarial",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      request: remoteRunnerEventV2Request,
      allowInsecureTransport: true
    });
    cleanups.push(() => client.stop());
    client.start();

    const wireEvent = await Promise.race([failed.promise, protocolFailure.promise]);
    expect(wireEvent).toMatchObject({
      failure: {
        code: "executor_failed",
        message: "The Agent Host executor failed.",
        retryable: false
      }
    });
    expect(JSON.stringify(wireEvent)).not.toContain(secret);
    expect(JSON.stringify(wireEvent)).not.toContain(privatePath);
    expect(state.pendingEvents().find((event) => event.type === "dispatch.failed")).toEqual(
      wireEvent
    );
    expect(state.pendingExecutions(1)).toEqual([]);
  });
});

async function outboxClientFixture(maxOutboundBatch = 128) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-outbox-delivery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  cleanups.push(() => state.close());
  const command = acpConversationPromptCommandSchema.parse({
    type: "acp_conversation.prompt",
    protocolVersion: agentHostProtocolVersion,
    operationId: "outbox-op",
    turnId: "outbox-turn",
    executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
    sessionId: "outbox-session",
    text: "Continue",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
  });
  state.receive({
    type: "mailbox.message",
    protocolVersion: agentHostProtocolVersion,
    sequence: 1,
    previousSequence: 0,
    messageId: "outbox-mailbox",
    command
  });
  state.conversations.start(command.turnId);
  const httpServer = createServer();
  cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  const server = new WebSocketServer({ server: httpServer });
  attachHostEventPayloadBudget(server);
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const received: HostEvent[] = [];
  let autoAck = true;
  let socket: WebSocket | undefined;
  let connections = 0;
  server.on("connection", (connection) => {
    socket = connection;
    connections += 1;
    connection.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "host.hello") {
        connection.send(
          JSON.stringify(
            serverEventSchema.parse({
              type: "host.welcome",
              protocolVersion: agentHostProtocolVersion,
              lastAcknowledgedSequence: event.lastAcknowledgedSequence,
              exactPermissionOptionsVersion: 1,
              historicalPermissionReplayVersion: 1,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 60_000,
              leaseDurationMs: 60_000
            })
          )
        );
      } else {
        const parsed = hostEventSchema.parse(event);
        received.push(parsed);
        if (autoAck)
          connection.send(
            JSON.stringify({
              type: "host.event_ack",
              protocolVersion: agentHostProtocolVersion,
              messageId: parsed.messageId
            })
          );
      }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected_http_port");
  const clock = new FakeHostTransportClock();
  const client = new AgentHostClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    hostId: "host-outbox",
    token: "host-token",
    capabilities: ["test"],
    capacity: 1,
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    state,
    executor: { execute: vi.fn() },
    request: remoteRunnerEventV2Request,
    allowInsecureTransport: true,
    clock,
    limits: { maxOutboundBatch },
    random: () => 0,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1_000 }
  });
  cleanups.push(() => client.stop());
  client.start();
  await vi.waitFor(() => {
    expect(received.length).toBeGreaterThan(0);
    expect(state.pendingEventCount()).toBe(0);
  });
  clock.advanceBy(0);
  await vi.waitFor(() => {
    expect(received.some((event) => event.type === "host.heartbeat")).toBe(true);
    expect(state.pendingEventCount()).toBe(0);
  });
  received.length = 0;
  const append = (
    payload: AcpConversationEvent["payload"] = {
      kind: "runner",
      fragment: {
        kind: "runner_body",
        body: {
          kind: "output",
          stream: "stdout",
          content: "live output",
          redaction: { classes: [], replaced: 0 }
        }
      }
    }
  ) => state.conversations.append(command.turnId, payload);
  return {
    directory,
    command,
    state,
    client,
    clock,
    received,
    append,
    connections: () => connections,
    setAutoAck(value: boolean) {
      autoAck = value;
    },
    socket: () => {
      if (!socket) throw new Error("socket_not_connected");
      return socket;
    },
    acknowledge(messageId: string) {
      socket?.send(
        JSON.stringify({
          type: "host.event_ack",
          protocolVersion: agentHostProtocolVersion,
          messageId
        })
      );
    }
  };
}

describe("Agent Host durable outbox wakeups", () => {
  it.each([
    { failure: "invalid JSON", status: "degraded", reason: "invalid_server_event" },
    {
      failure: "expired mailbox receipt",
      status: "reconciliation-required",
      reason: "mailbox_message_retention_horizon_exceeded"
    }
  ] as const)("detaches before publishing automatic termination for $failure", async ({
    failure,
    status,
    reason
  }) => {
    const notify = vi.fn();
    const detach = vi.fn();
    const subscribe = AgentHostState.prototype.subscribeOutboxReady;
    const subscriptions = vi
      .spyOn(AgentHostState.prototype, "subscribeOutboxReady")
      .mockImplementation(function (this: AgentHostState, listener) {
        const unsubscribe = subscribe.call(this, () => {
          notify();
          listener();
        });
        return () => {
          detach();
          unsubscribe();
        };
      });
    const f = await outboxClientFixture();
    expect(subscriptions).toHaveBeenCalledOnce();
    const buffered = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(512 * 1024);
    const timersBeforeRetry = f.clock.pendingTimerCount();
    f.append();
    await Promise.resolve();
    expect(f.clock.pendingTimerCount()).toBe(timersBeforeRetry + 1);
    expect(f.received).toHaveLength(0);
    const terminalObservations: Array<{ detached: number; timers: number }> = [];
    const unsubscribeStatus = f.client.subscribe((next) => {
      if (next.state === status && "reason" in next && next.reason === reason) {
        terminalObservations.push({
          detached: detach.mock.calls.length,
          timers: f.clock.pendingTimerCount()
        });
      }
    });
    cleanups.push(unsubscribeStatus);
    const closed = new Promise<number>((resolve) => f.socket().once("close", resolve));
    if (failure === "invalid JSON") {
      f.socket().send("{");
    } else {
      // The replay's receipt was pruned, while its durable high-water checkpoint remains.
      const database = await openAgentHostDatabase(join(f.directory, "host.sqlite"), 5_000);
      try {
        database.exec(`UPDATE agent_host_mailbox_checkpoint
          SET received_high_water_sequence=2,acknowledged_high_water_sequence=2 WHERE singleton=1`);
      } finally {
        database.close();
      }
      f.socket().send(
        JSON.stringify(
          mailboxDeliverySchema.parse({
            type: "mailbox.message",
            protocolVersion: agentHostProtocolVersion,
            sequence: 2,
            previousSequence: 1,
            messageId: "expired-mailbox-replay",
            command: f.command
          })
        )
      );
    }
    expect(await closed).toBe(4003);
    expect(f.client.status()).toEqual({ state: status, reason });
    expect(terminalObservations).toEqual([{ detached: 1, timers: timersBeforeRetry }]);
    expect(detach).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.clock.pendingTimerCount()).toBe(0));
    const notificationsBeforeCommit = notify.mock.calls.length;
    const heartbeat = f.state.queueHeartbeat([]);
    expect(f.state.pendingEvents()).toContainEqual(heartbeat);
    expect(notify).toHaveBeenCalledTimes(notificationsBeforeCommit);
    buffered.mockReturnValue(0);
    f.clock.advanceBy(120_000);
    await Promise.resolve();
    expect(f.clock.pendingTimerCount()).toBe(0);
    expect(f.received).toHaveLength(0);
    expect(f.connections()).toBe(1);
    await f.client.stop();
    await f.client.stop();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("coalesces committed output bursts and sends permission/completion without heartbeat or mailbox", async () => {
    const f = await outboxClientFixture();
    f.setAutoAck(false);
    const reads = vi.spyOn(f.state, "pendingEvents");
    for (let index = 0; index < 20; index += 1) f.append();
    f.append({
      kind: "interaction",
      request: {
        kind: "permission",
        requestId: "permit-one",
        summary: "Read file",
        deadline: new Date(Date.now() + 60_000).toISOString(),
        options: [{ optionId: "allow-once", label: "Allow once", decision: "approve" }]
      }
    });
    f.append({ kind: "status", status: "completed", error: null });
    expect(f.received).toHaveLength(0);
    await vi.waitFor(() => expect(f.received).toHaveLength(22));
    expect(reads).toHaveBeenCalledTimes(1);
    expect(f.received).toEqual(f.state.pendingEvents());
    expect(f.received.at(-2)).toMatchObject({
      payload: { kind: "interaction", request: { kind: "permission" } }
    });
    expect(f.received.at(-1)).toMatchObject({ payload: { kind: "status", status: "completed" } });
    expect(f.clock.now()).toEqual(new Date("2026-07-23T08:00:00.000Z"));
  });

  it("respects the ACK window and retains exact message identities for reconnect replay", async () => {
    const f = await outboxClientFixture(2);
    f.setAutoAck(false);
    for (let index = 0; index < 5; index += 1) f.append();
    const pending = f.state.pendingEvents();
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    f.acknowledge(pending[0]!.messageId);
    await vi.waitFor(() => expect(f.received).toHaveLength(3));
    expect(f.received).toEqual(pending.slice(0, 3));
    f.socket().close(1012, "reconnect replay");
    await vi.waitFor(() => expect(f.client.status().state).toBe("backing-off"));
    f.clock.advanceBy(50);
    await vi.waitFor(() => expect(f.connections()).toBe(2));
    await vi.waitFor(() => expect(f.received).toHaveLength(5));
    expect(f.received.slice(3)).toEqual(pending.slice(1, 3));
    expect(f.state.pendingEvents()).toEqual(pending.slice(1));
  });

  it("retries buffer pressure with one bounded timer and cancels queued work on stop", async () => {
    const f = await outboxClientFixture();
    f.setAutoAck(false);
    const buffered = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(512 * 1024);
    const timersBefore = f.clock.pendingTimerCount();
    for (let index = 0; index < 10; index += 1) f.append();
    await Promise.resolve();
    expect(f.received).toHaveLength(0);
    expect(f.clock.pendingTimerCount()).toBe(timersBefore + 1);
    const timersWithRetry = f.clock.pendingTimerCount();
    f.clock.advanceBy(25);
    await Promise.resolve();
    expect(f.clock.pendingTimerCount()).toBe(timersWithRetry);
    expect(f.received).toHaveLength(0);
    buffered.mockReturnValue(0);
    f.clock.advanceBy(50);
    await vi.waitFor(() => expect(f.received.length).toBeGreaterThanOrEqual(10));
    const sent = f.received.length;
    f.append();
    await f.client.stop();
    expect(f.received).toHaveLength(sent);
    const reads = vi.spyOn(f.state, "pendingEvents");
    f.append();
    f.clock.advanceBy(60_000);
    await Promise.resolve();
    expect(reads).not.toHaveBeenCalled();
    expect(f.received).toHaveLength(sent);
    expect(f.state.pendingEventCount()).toBeGreaterThan(sent);
    f.client.start();
    await vi.waitFor(() => expect(f.received.slice(sent)).toEqual(f.state.pendingEvents()));
  });
});

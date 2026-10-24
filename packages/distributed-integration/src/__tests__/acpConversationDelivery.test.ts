import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ACP_CONVERSATION_CAPABILITY,
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  executeBlockCommandSchema,
  hashExecutionEnvelope,
  hostEventSchema,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RemoteAcpConversationService } from "../../../agent-host/src/execution/remoteAcpConversationService.js";
import type { RemoteAcpExecutor } from "../../../agent-host/src/execution/remoteAcpExecutor.js";
import { openAgentHostState } from "../../../agent-host/src/state/agentHostState.js";
import { AgentHostClient } from "../../../agent-host/src/transport/agentHostClient.js";
import { FakeHostTransportClock } from "../../../agent-host/src/__tests__/support/hostTransportTestClock.js";
import { remoteRunnerEventV2Request } from "../../../agent-host/src/__tests__/support/remoteRunnerEventCapabilityTestValues.js";
import { AcpConversationService } from "../../../server/src/acpConversationService.js";
import { createRemoteBlockCoordination } from "../../../server/src/distributedCoordination.js";
import { RemoteOperationRepository } from "../../../server/src/remoteOperations.js";
import { attachAgentHostWebSocketServer } from "../../../server/src/wsServer.js";
import { createRemoteAcpEventV2Fixture } from "../../../server/src/__tests__/support/remoteAcpEventV2Fixture.js";
import { loopbackHttpTransportAdmission } from "../../../server/src/__tests__/support/transportAdmission.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("persists independently woken conversation events and deduplicates unacknowledged reconnect replay", async () => {
  const serverNow = new Date();
  const f = await createRemoteAcpEventV2Fixture(() => new Date(serverNow));
  cleanups.push(() => rm(f.directory, { recursive: true, force: true }));
  cleanups.push(() => f.server.close());
  const db = f.server.database;
  const coordination = createRemoteBlockCoordination(
    db,
    {
      clock: f.clock,
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: {
        acquire() {
          throw new Error("runtime_not_used");
        },
        acquireForHost() {
          throw new Error("runtime_not_used");
        }
      },
      inputArtifacts: { async materialize() {} },
      artifactContent: {
        async readReport() {
          return new Uint8Array();
        }
      }
    },
    { serverInstanceOwnerToken: f.server.serverInstanceOwnerToken }
  );
  const { hosts, mailbox } = coordination;
  const service = new AcpConversationService(db, {
    hosts,
    mailbox,
    clock: f.clock,
    hostOfflineAfterMs: 60_000,
    authorize() {}
  });
  const envelope = executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    execution: { dispatchId: f.operation.dispatchId, attemptId: f.operation.executionAttemptId }
  });
  const sourceCommand = executeBlockCommandSchema.parse({
    type: "execute_block",
    protocolVersion: 1,
    dispatchId: f.operation.dispatchId,
    executionAttemptId: f.operation.executionAttemptId,
    leaseId: f.reservation.leaseId,
    leaseExpiresAt: f.reservation.leaseExpiresAt,
    envelope,
    envelopeDigest: hashExecutionEnvelope(envelope)
  });
  const source = mailbox.enqueue(f.host.id, sourceCommand);
  db.prepare(`INSERT INTO remote_acp_event_streams(execution_attempt_id,operation_id,dispatch_id,lease_id,host_id,acp_session_id,updated_at)
    VALUES(?,?,?,?,?,'delivery-session',?)`).run(
    f.operation.executionAttemptId,
    f.operation.id,
    f.operation.dispatchId,
    f.reservation.leaseId,
    f.host.id,
    f.clock().toISOString()
  );
  db.prepare("UPDATE remote_operations SET state='completed',terminal_at=? WHERE id=?").run(
    f.clock().toISOString(),
    f.operation.id
  );
  const operation = new RemoteOperationRepository(db, f.clock).getRequired(f.operation.id);

  // A completed source execution is the precondition for a continuation turn.
  const state = await openAgentHostState(join(f.directory, "host.sqlite"));
  cleanups.push(() => state.close());
  const received = state.receive(
    {
      type: "mailbox.message",
      protocolVersion: 1,
      sequence: source.sequence,
      previousSequence: source.previousSequence,
      messageId: source.messageId,
      command: sourceCommand
    },
    f.clock()
  );
  state.startExecution(source.sequence, f.clock());
  state.completeExecution(
    source.sequence,
    sourceCommand,
    {
      summary: "Previous execution completed",
      reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
      artifactRefs: []
    },
    f.clock()
  );
  mailbox.acknowledge(f.host.id, received.acknowledgement.messageId, source.sequence);
  for (const event of state.pendingEvents()) state.acknowledgeEvent(event.messageId);

  const output = gate();
  const permission = gate();
  const finish = gate();
  const selected = vi.fn();
  const converse = vi.fn<RemoteAcpExecutor["converse"]>(async (command, broker, sink, signal) => {
    const abort = () => {
      output.release();
      permission.release();
      finish.release();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await output.promise;
      if (signal.aborted) throw new Error("fixture_aborted");
      await sink({
        kind: "session_update",
        sequence: 1,
        timestamp: f.clock().toISOString(),
        sessionId: command.sessionId,
        body: {
          kind: "output",
          stream: "stdout",
          content: "fixture output",
          redaction: { classes: [], replaced: 0 }
        }
      });
      await permission.promise;
      if (signal.aborted) throw new Error("fixture_aborted");
      selected(
        await broker.requestPermission(
          {
            requestId: "delivery-permission",
            sessionId: command.sessionId,
            toolCallId: "fixture-tool",
            summary: "Allow fixture tool",
            options: [{ optionId: "allow-once", label: "Allow", kind: "allow_once" }]
          },
          { signal, deadline: new Date(command.expiresAt) }
        )
      );
      await finish.promise;
      return {
        terminal: { state: "succeeded", stopReason: "end_turn" },
        cleanup: { attempted: true, completed: true }
      };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  });
  const clock = new FakeHostTransportClock(f.clock());
  const conversations = new RemoteAcpConversationService(state.conversations, { converse }, clock);
  const http = createServer();
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const transport = attachAgentHostWebSocketServer({
    server: http,
    ...coordination,
    conversations: service,
    heartbeatIntervalMs: 60_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  cleanups.push(() => transport.close());
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("test_http_address_missing");
  const sends = vi.spyOn(WebSocket.prototype, "send");
  const client = new AgentHostClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    hostId: f.host.id,
    token: f.token,
    capabilities: ["linux", "acp.codex", ACP_CONVERSATION_CAPABILITY],
    capacity: 1,
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    state,
    conversations,
    clock,
    request: remoteRunnerEventV2Request,
    executor: { execute: vi.fn() },
    allowInsecureTransport: true,
    random: () => 0,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1_000 }
  });
  cleanups.push(() => client.stop());
  const hostWire = () =>
    sends.mock.calls.flatMap(([data]) => {
      const parsed = hostEventSchema.safeParse(JSON.parse(String(data)));
      return parsed.success ? [parsed.data] : [];
    });
  const serverWire = () =>
    sends.mock.calls.flatMap(([data]) => {
      const parsed = serverEventSchema.safeParse(JSON.parse(String(data)));
      return parsed.success ? [parsed.data] : [];
    });
  const page = () => service.page(operation, "fixture-actor");
  const drained = async () => {
    await vi.waitFor(() => expect(state.pendingEventCount()).toBe(0));
  };
  const serverSocket = () => {
    const socket = sends.mock.calls
      .map(([data], index) => ({
        type: JSON.parse(String(data)).type,
        context: sends.mock.contexts[index]
      }))
      .reverse()
      .find(({ type }) => type === "host.welcome")?.context;
    if (!(socket instanceof WebSocket)) throw new Error("test_server_socket_missing");
    return socket;
  };
  client.start();
  await vi.waitFor(() => expect(client.status().state).toBe("connected"));
  clock.advanceBy(0);
  await vi.waitFor(() =>
    expect(hostWire().filter((event) => event.type === "host.heartbeat")).toHaveLength(1)
  );
  await drained();
  const action = {
    turnId: "delivery-turn",
    executionAttemptId: operation.executionAttemptId,
    sessionId: "delivery-session"
  };
  service.act(operation, "fixture-actor", { ...action, kind: "prompt", text: "Continue" });
  await vi.waitFor(() => expect(page().events).toHaveLength(1));
  await drained();
  expect(converse).toHaveBeenCalledOnce();

  const firstSocket = serverSocket();
  const send = firstSocket.send.bind(firstSocket);
  let heldAck: string | undefined;
  Object.defineProperty(firstSocket, "send", {
    configurable: true,
    value: (...args: Parameters<WebSocket["send"]>) => {
      const event = serverEventSchema.parse(JSON.parse(String(args[0])));
      if (event.type === "host.event_ack") {
        heldAck = String(args[0]);
        return;
      }
      send(...args);
    }
  });
  const beforeOutput = serverWire().length;
  const now = clock.now();
  output.release();
  await vi.waitFor(() =>
    expect(state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        type: "acp_conversation.event",
        sequence: 2,
        payload: expect.objectContaining({ kind: "runner" })
      })
    )
  );
  await vi.waitFor(() => expect(page().events).toHaveLength(2));
  const outputEvent = page().events[1]!;
  expect(outputEvent.payload).toMatchObject({
    kind: "runner",
    fragment: { kind: "runner_body", body: { kind: "output", content: "fixture output" } }
  });
  expect(serverWire()).toHaveLength(beforeOutput);
  expect(clock.now()).toEqual(now);
  expect(state.pendingEvents().map((event) => event.messageId)).toEqual([outputEvent.messageId]);
  expect(heldAck).toBeDefined();

  firstSocket.close(1012, "fixture network loss");
  await vi.waitFor(() => expect(client.status().state).toBe("backing-off"));
  expect(state.pendingEvents().map((event) => event.messageId)).toEqual([outputEvent.messageId]);
  clock.advanceBy(50);
  await vi.waitFor(() =>
    expect(serverWire().filter((event) => event.type === "host.welcome")).toHaveLength(2)
  );
  await drained();
  expect(hostWire().filter((event) => event.messageId === outputEvent.messageId)).toHaveLength(2);
  expect(page().events).toHaveLength(2);
  clock.advanceBy(0);
  await drained();

  const acknowledge = vi.spyOn(state, "acknowledgeEvent");
  if (!heldAck) throw new Error("test_ack_missing");
  serverSocket().send(heldAck);
  serverSocket().send(heldAck);
  await vi.waitFor(() =>
    expect(acknowledge.mock.calls.filter(([id]) => id === outputEvent.messageId)).toHaveLength(2)
  );
  expect(page().events).toHaveLength(2);

  const beforePermission = serverWire().length;
  const heartbeatCount = hostWire().filter((event) => event.type === "host.heartbeat").length;
  permission.release();
  await vi.waitFor(() => expect(page().events).toHaveLength(3));
  await drained();
  expect(page().events[2]!.payload).toMatchObject({
    kind: "interaction",
    request: { kind: "permission", requestId: "delivery-permission" }
  });
  expect(
    serverWire()
      .slice(beforePermission)
      .map((event) => event.type)
  ).toEqual(["host.event_ack"]);
  expect(hostWire().filter((event) => event.type === "host.heartbeat")).toHaveLength(
    heartbeatCount
  );

  service.act(operation, "fixture-actor", {
    ...action,
    kind: "respond",
    requestId: "delivery-permission",
    decision: { kind: "permission", optionId: "allow-once" }
  });
  await vi.waitFor(() =>
    expect(selected).toHaveBeenCalledWith({ kind: "select", optionId: "allow-once" })
  );
  await drained();
  expect(page().events).toHaveLength(4);
  const beforeFinish = serverWire().length;
  finish.release();
  await vi.waitFor(() => expect(page().turns[0]!.status).toBe("completed"));
  await drained();
  expect(
    serverWire()
      .slice(beforeFinish)
      .map((event) => event.type)
  ).toEqual(["host.event_ack"]);
  expect(hostWire().filter((event) => event.type === "host.heartbeat")).toHaveLength(
    heartbeatCount
  );
  expect(page().events.map((event) => [event.sequence, event.payload.kind])).toEqual([
    [1, "status"],
    [2, "runner"],
    [3, "interaction"],
    [4, "interaction_settled"],
    [5, "status"]
  ]);
  expect(page().events[4]!.payload).toEqual({ kind: "status", status: "completed", error: null });
  expect(
    db
      .prepare("SELECT COUNT(*) AS count FROM acp_conversation_events WHERE turn_id=?")
      .get(action.turnId)?.count
  ).toBe(5);
});

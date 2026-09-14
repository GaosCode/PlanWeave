import { createServer } from "node:http";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  canonicalizeJson,
  EXACT_PERMISSION_OPTIONS_VERSION_HEADER,
  serverEventSchema,
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  exactPermissionRequestSchema,
  exactPermissionSettlementSchema,
  interactionSettlementSchema,
  mailboxDeliverySchema
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAcpInteractionRelay } from "../../../agent-host/src/execution/durableAcpRelay.js";
import {
  openAgentHostState,
  type AgentHostState
} from "../../../agent-host/src/state/agentHostState.js";
import { acpCapabilitySnapshotTestValue } from "../../../agent-host/src/__tests__/support/acpCapabilitySnapshotTestValues.js";
import { attachAgentHostWebSocketServer } from "../../../server/src/wsServer.js";
import { createTestDispatchCoordination } from "../../../server/src/__tests__/support/testDispatchCoordination.js";
import { loopbackHttpTransportAdmission } from "../../../server/src/__tests__/support/transportAdmission.js";
import { RemoteAcpEventRepository } from "../../../server/src/remoteAcpEvents.js";
import { DurableMailbox } from "../../../server/src/mailbox.js";
import { RemoteInteractionService } from "../../../server/src/remoteInteractions.js";
import { RemoteExecutionActionRepository } from "../../../server/src/remoteExecutionActions.js";
import {
  setupRemoteObservationsFixture as setup,
  cleanupRemoteObservationsFixture
} from "../../../server/src/__tests__/support/remoteObservationsFixture.js";

const exampleExecutionCommand = executeBlockCommandSchema.parse(
  mailboxDeliverySchema.parse(exampleExecuteDelivery).command
);

const states: AgentHostState[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await cleanupRemoteObservationsFixture();
});
const options = [
  { optionId: "always", label: "Always allow", kind: "allow_always" as const },
  { optionId: "once", label: "Allow once", kind: "allow_once" as const },
  { optionId: "other-once", label: "Allow with audit", kind: "allow_once" as const },
  { optionId: "reject-always", label: "Always reject", kind: "reject_always" as const }
];
function requestFor(fixture: Awaited<ReturnType<typeof setup>>) {
  return exactPermissionRequestSchema.parse({
    type: "interaction.permission_requested",
    dispatchId: fixture.operation.dispatchId,
    leaseId: fixture.reservation.leaseId,
    executionAttemptId: fixture.operation.executionAttemptId,
    actionId: "permission-exact",
    acpSessionId: "session-exact",
    expiresAt: "2030-01-01T00:00:30.000Z",
    title: "Tool permission",
    description: "Execute tool",
    options
  });
}
function serviceFor(fixture: Awaited<ReturnType<typeof setup>>) {
  return new RemoteInteractionService(fixture.server.database, {
    clock: fixture.clock,
    authorization: { canRespond: ({ responderId }) => responderId === "member" }
  });
}
function responseFor(request: ReturnType<typeof requestFor>, optionId: string) {
  return exactPermissionSettlementSchema.options[0].parse({
    type: "interaction.permission_response",
    dispatchId: request.dispatchId,
    leaseId: request.leaseId,
    executionAttemptId: request.executionAttemptId,
    actionId: request.actionId,
    acpSessionId: request.acpSessionId,
    decision: "select_option",
    optionId
  });
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalizeJson(value)).digest("hex");

describe("exact permission durable Server and Host relay", () => {
  it.each([
    undefined,
    "1"
  ])("negotiates only the declared exact permission version %s on the real Server", async (version) => {
    const fixture = await setup();
    const coordination = createTestDispatchCoordination(fixture.server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: {
        complete: async () => {
          throw new Error("unexpected writeback");
        },
        fail: async () => {
          throw new Error("unexpected writeback");
        }
      }
    });
    const registration = coordination.hosts.register("Handshake Host");
    const http = createServer();
    const transport = attachAgentHostWebSocketServer({
      server: http,
      hosts: coordination.hosts,
      mailbox: coordination.mailbox,
      dispatches: coordination.dispatches,
      interactions: serviceFor(fixture),
      actions: new RemoteExecutionActionRepository(fixture.server.database),
      acpEvents: new RemoteAcpEventRepository(fixture.server.database),
      heartbeatIntervalMs: 60_000,
      leaseDurationMs: 60_000,
      transportAdmission: loopbackHttpTransportAdmission
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("test port missing");
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/connect`,
      {
        headers: {
          Authorization: `Bearer ${registration.token}`,
          ...(version ? { [EXACT_PERMISSION_OPTIONS_VERSION_HEADER]: version } : {})
        }
      }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const welcome = new Promise<unknown>((resolve) =>
        socket.once("message", (data) =>
          resolve(serverEventSchema.parse(JSON.parse(data.toString())))
        )
      );
      socket.send(
        JSON.stringify({
          type: "host.hello",
          protocolVersion: 1,
          supportedExecutionEnvelopeVersions: [1, 2],
          lastAcknowledgedSequence: 0,
          capabilities: [],
          capacity: 1
        })
      );
      const expected = await welcome;
      expect(expected).toMatchObject({ type: "host.welcome" });
      if (version === "1") expect(expected).toHaveProperty("exactPermissionOptionsVersion", 1);
      else expect(expected).not.toHaveProperty("exactPermissionOptionsVersion");
      const reply = new Promise<unknown>((resolve) =>
        socket.once("message", (data) =>
          resolve(serverEventSchema.parse(JSON.parse(data.toString())))
        )
      );
      const { options: _options, ...legacyRequest } = requestFor(fixture);
      socket.send(
        JSON.stringify({ ...legacyRequest, protocolVersion: 1, messageId: "legacy-on-live" })
      );
      expect(await reply).toMatchObject(
        version === "1"
          ? { type: "protocol.error", code: "schema_invalid" }
          : { type: "host.event_ack", messageId: "legacy-on-live" }
      );
    } finally {
      socket.terminate();
      await transport.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it.each([
    "once",
    "other-once",
    "reject-always",
    null
  ])("returns precisely %s through both durable stores", async (optionId) => {
    const fixture = await setup();
    const state = await openAgentHostState(join(fixture.directory, "host.sqlite"));
    states.push(state);
    state.setRemoteRunnerEventProtocolVersion(2);
    const envelope = executionEnvelopeSchema.parse({
      ...exampleExecutionCommand.envelope,
      execution: {
        dispatchId: fixture.operation.dispatchId,
        attemptId: fixture.operation.executionAttemptId
      }
    });
    const mailbox = new DurableMailbox(fixture.server.database);
    const execute = mailbox.enqueue(
      fixture.host.id,
      executeBlockCommandSchema.parse({
        ...exampleExecutionCommand,
        dispatchId: fixture.operation.dispatchId,
        executionAttemptId: fixture.operation.executionAttemptId,
        leaseId: fixture.reservation.leaseId,
        leaseExpiresAt: fixture.reservation.leaseExpiresAt,
        envelope,
        envelopeDigest: hashExecutionEnvelope(envelope)
      })
    );
    const deliver = (message: typeof execute) =>
      mailboxDeliverySchema.parse({
        type: "mailbox.message",
        protocolVersion: 1,
        sequence: message.sequence,
        previousSequence: message.previousSequence,
        messageId: message.messageId,
        command: message.command
      });
    state.receive(deliver(execute));
    state.startExecution(execute.sequence);
    const wire = requestFor(fixture);
    const identity = {
      dispatchId: wire.dispatchId,
      leaseId: wire.leaseId,
      executionAttemptId: wire.executionAttemptId
    };
    state.append({
      kind: "engine_event",
      identity,
      event: {
        sequence: 1,
        timestamp: fixture.clock().toISOString(),
        kind: "capability_snapshot",
        snapshot: acpCapabilitySnapshotTestValue()
      }
    });
    state.append({
      kind: "engine_event",
      identity,
      event: {
        sequence: 2,
        timestamp: fixture.clock().toISOString(),
        kind: "session_started",
        sessionId: wire.acpSessionId,
        loaded: false
      }
    });
    const request = {
      requestId: wire.actionId,
      sessionId: wire.acpSessionId,
      toolCallId: "tool",
      summary: "Execute tool",
      options
    };
    state.append({ kind: "permission_request", identity, request, deadline: wire.expiresAt });
    const event = state
      .pendingEvents()
      .find((candidate) => candidate.type === "interaction.permission_requested");
    if (!event || event.type !== "interaction.permission_requested")
      throw new Error("missing permission event");
    const { protocolVersion: _version, messageId, ...payload } = event;
    const service = serviceFor(fixture);
    const recorded = service.recordRequest(fixture.host.id, messageId, payload);
    expect(recorded?.request).toMatchObject({ options });
    const relay = new DurableAcpInteractionRelay(state);
    const pending = relay.requestPermission(identity, request, {
      signal: new AbortController().signal,
      deadline: new Date(wire.expiresAt)
    });
    const { optionId: _optionId, ...responseIdentity } = responseFor(wire, "once");
    const selection =
      optionId === null
        ? interactionSettlementSchema.parse({ ...responseIdentity, decision: "deny" })
        : responseFor(wire, optionId);
    const settled = service.settle({
      hostId: fixture.host.id,
      responderId: "member",
      settlement: selection
    });
    expect(
      service.settle({ hostId: fixture.host.id, responderId: "member", settlement: selection })
        .mailboxMessageId
    ).toBe(settled.mailboxMessageId);
    const answer = mailbox.listAfter(fixture.host.id, execute.sequence);
    expect(answer).toHaveLength(1);
    const delivery = deliver(answer[0]);
    state.receive(delivery);
    relay.accept(delivery.command);
    await expect(pending).resolves.toEqual(
      optionId === null ? { kind: "cancel" } : { kind: "select", optionId }
    );
    const row = fixture.server.database
      .prepare(
        "SELECT request_json,request_fingerprint,settlement_json,settlement_fingerprint FROM remote_interactions"
      )
      .get();
    expect(row?.request_fingerprint).toBe(digest(JSON.parse(String(row?.request_json))));
    expect(row?.settlement_fingerprint).toBe(digest(selection));
    expect(service.recordRequest(fixture.host.id, messageId, payload)).toMatchObject({
      status: "settled"
    });
    expect(() =>
      service.settle({
        hostId: fixture.host.id,
        responderId: "member",
        settlement: responseFor(wire, "always")
      })
    ).toThrow("remote_interaction_settlement_conflict");
  });

  it("rejects forged choices, stale identities, unauthorized users and expired responses", async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    const request = requestFor(fixture);
    service.recordRequest(fixture.host.id, "request", request);
    const valid = responseFor(request, "once");
    const settle = (settlement: unknown, responderId = "member") =>
      service.settle({ hostId: fixture.host.id, responderId, settlement });
    expect(() => settle(valid, "foreign")).toThrow("remote_interaction_responder_unauthorized");
    expect(() => settle(responseFor(request, "forged"))).toThrow(
      "interaction_permission_option_unknown"
    );
    for (const field of [
      "dispatchId",
      "leaseId",
      "executionAttemptId",
      "acpSessionId",
      "actionId"
    ]) {
      expect(() => settle({ ...valid, [field]: "wrong" })).toThrow();
    }
    expect(() => settle({ ...valid, decision: "allow_once" })).toThrow();
    expect(
      fixture.server.database.prepare("SELECT COUNT(*) AS count FROM mailbox_messages").get()?.count
    ).toBe(0);
    fixture.setNow("2030-01-01T00:00:31.000Z");
    expect(() => settle(valid)).toThrow("remote_interaction_expired");
  });

  it("keeps historical SQLite fingerprints readable and expires legacy requests through execution cancellation", async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    const request = requestFor(fixture);
    if (request.type !== "interaction.permission_requested") throw new Error("permission required");
    const { options: _options, ...legacy } = request;
    expect(() => service.recordRequest(fixture.host.id, "legacy", legacy)).toThrow();
    service.recordLegacyRequest(fixture.host.id, "legacy", legacy);
    const database = fixture.server.database;
    const before = database
      .prepare("SELECT request_json,request_fingerprint FROM remote_interactions")
      .get();
    expect(before?.request_fingerprint).toBe(digest(legacy));
    const { optionId: _id, ...oldIdentity } = responseFor(request, "once");
    const historicalSettlement = { ...oldIdentity, decision: "allow_once" };
    database
      .prepare(
        "UPDATE remote_interactions SET status='settled',settlement_json=?,settlement_fingerprint=?,settled_by='old-member',settled_at='2029-12-31T00:00:00.000Z',mailbox_message_id='old-mailbox'"
      )
      .run(canonicalizeJson(historicalSettlement), digest(historicalSettlement));
    const identity = {
      hostId: fixture.host.id,
      dispatchId: legacy.dispatchId,
      executionAttemptId: legacy.executionAttemptId,
      acpSessionId: legacy.acpSessionId,
      actionId: legacy.actionId
    };
    expect(serviceFor(fixture).getRequired(identity).settlement).toEqual(historicalSettlement);
    database
      .prepare(
        "UPDATE remote_interactions SET status='pending',settlement_json=NULL,settlement_fingerprint=NULL,settled_by=NULL,settled_at=NULL,mailbox_message_id=NULL"
      )
      .run();
    expect(() =>
      service.settle({
        hostId: fixture.host.id,
        responderId: "member",
        settlement: { ...historicalSettlement, decision: "deny" }
      })
    ).toThrow("legacy_permission_request_requires_execution_cancel");
    fixture.setNow("2030-01-01T00:00:31.000Z");
    const expired = serviceFor(fixture).expireDue();
    expect(expired).toHaveLength(1);
    const messages = new DurableMailbox(database).listAfter(fixture.host.id, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].command.type).toBe("cancel_execution");
    expect(
      new RemoteExecutionActionRepository(database).getRequired(messages[0].messageId)
    ).toMatchObject({ state: "delivered", request: { kind: "cancel", leaseId: legacy.leaseId } });
    expect(database.prepare("SELECT status FROM dispatches").get()?.status).toBe("cancelling");
    expect(serviceFor(fixture).expireDue()).toEqual([]);
    expect(
      database.prepare("SELECT request_json,request_fingerprint FROM remote_interactions").get()
    ).toEqual(before);
  });
});

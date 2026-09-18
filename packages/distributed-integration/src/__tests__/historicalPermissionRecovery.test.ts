import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXACT_PERMISSION_OPTIONS_VERSION_HEADER,
  HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import {
  setup,
  cleanupHistoricalPermissionReplay,
  connectRaw,
  captureWrites,
  insertOutbox,
  insertMailbox,
  nextCancellation,
  hostRow,
  digest,
  queueExecution,
  updateHost,
  seedHistoricalInbox
} from "./support/historicalPermissionReplayFixture.js";

import {
  AgentHostExecutionError,
  type AgentHostExecutor
} from "../../../agent-host/src/execution/agentHostExecutor.js";

import { SqliteRemoteDispatchPersistence } from "../../../server/src/remoteCoordinatorPersistence.js";

afterEach(cleanupHistoricalPermissionReplay);
const headers = {
  [EXACT_PERMISSION_OPTIONS_VERSION_HEADER]: "1",
  [HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER]: "1"
};

describe("historical permission recovery over SQLite and WebSocket", () => {
  it("cancels a waiting execution even when the Server already has the historical request receipt", async () => {
    const fixture = await setup();
    const { protocolVersion: _version, messageId: _id, ...request } = fixture.request;
    fixture.interactions.recordLegacyRequest(fixture.host.id, fixture.request.messageId, request);
    const receipt = fixture.server.database
      .prepare("SELECT request_fingerprint FROM host_event_receipts WHERE message_id=?")
      .get(fixture.request.messageId);
    expect(receipt?.request_fingerprint).toEqual(expect.any(String));
    const { socket, frames } = await connectRaw(fixture, headers);
    const replay = JSON.stringify({
      type: "host.permission_history",
      protocolVersion: 1,
      eventJson: JSON.stringify(fixture.request, null, 2)
    });
    socket.send(replay);
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "host.event_ack", messageId: fixture.request.messageId })
      )
    );
    await vi.waitFor(
      () =>
        expect(
          fixture.mailbox.listAfter(fixture.host.id, 0).map((message) => message.command)
        ).toContainEqual(
          expect.objectContaining({
            type: "cancel_execution",
            dispatchId: fixture.request.dispatchId,
            leaseId: fixture.request.leaseId,
            executionAttemptId: fixture.request.executionAttemptId
          })
        ),
      { timeout: 1_000 }
    );
    socket.send(replay);
    await vi.waitFor(() =>
      expect(
        frames.filter(
          (frame) =>
            frame.type === "host.event_ack" && frame.messageId === fixture.request.messageId
        )
      ).toHaveLength(2)
    );
    expect(
      fixture.mailbox
        .listAfter(fixture.host.id, 0)
        .filter((message) => message.command.type === "cancel_execution")
    ).toHaveLength(1);
    expect(
      fixture.server.database
        .prepare("SELECT request_fingerprint FROM host_event_receipts WHERE message_id=?")
        .get(fixture.request.messageId)
    ).toEqual(receipt);
  });
  it.each([
    false,
    true
  ])("reopens a persisted inbox with processed=%s and cancels without granting or rewriting it", async (processed) => {
    const fixture = await setup();
    const { execution, historical } = await seedHistoricalInbox(fixture, processed);
    const original = await hostRow(
      fixture,
      "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
      historical.sequence
    );
    expect(original).toEqual({
      command_json: historical.commandJson,
      command_digest: digest(fixture.response)
    });
    const frames = captureWrites((frame) => frame.type === "dispatch.failed");
    const execute = vi.fn<AgentHostExecutor["execute"]>();
    const running = await fixture.start(execute);
    await vi.waitFor(() =>
      expect(running.state.lastAcknowledgedSequence()).toBe(historical.sequence)
    );
    await vi.waitFor(async () =>
      expect(
        await hostRow(
          fixture,
          "SELECT status FROM agent_host_executions WHERE inbox_sequence=?",
          execution.sequence
        )
      ).toEqual({ status: "cancelled" })
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "mailbox.permission_history",
        commandJson: historical.commandJson
      })
    );
    expect(
      await hostRow(
        fixture,
        "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
        historical.sequence
      )
    ).toEqual(original);
    expect(running.relay.accept).not.toHaveBeenCalledWith(fixture.response);
    expect(execute).not.toHaveBeenCalled();
    await running.stop();
    const second = await fixture.start(execute);
    const next = nextCancellation(fixture);
    fixture.mailbox.publish(next);
    await vi.waitFor(() => expect(second.state.lastAcknowledgedSequence()).toBe(next.sequence));
    expect(execute).not.toHaveBeenCalled();
    expect(
      await hostRow(
        fixture,
        "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
        historical.sequence
      )
    ).toEqual(original);
  });

  it("ACKs a compacted historical receipt after reopen and rejects a mutated replay without resurrection", async () => {
    const fixture = await setup();
    const { execution, historical } = await seedHistoricalInbox(fixture, false);
    let tamper = false;
    const frames = captureWrites((frame, socket) => {
      if (tamper && frame.type === "mailbox.permission_history") {
        tamper = false;
        socket.send(
          JSON.stringify({
            ...frame,
            commandJson: JSON.stringify({
              ...fixture.response,
              actionId: "tampered-compacted-action"
            })
          })
        );
        return true;
      }
      return false;
    });
    const execute = vi.fn<AgentHostExecutor["execute"]>();
    const first = await fixture.start(execute);
    await vi.waitFor(async () =>
      expect(
        await hostRow(
          fixture,
          "SELECT command_digest FROM agent_host_compacted_mailbox_receipts WHERE sequence=?",
          historical.sequence
        )
      ).toEqual({ command_digest: digest(fixture.response) })
    );
    await first.stop();
    const second = await fixture.start(execute);
    await vi.waitFor(() => expect(second.client.status().state).toBe("connected"));
    const message = fixture.mailbox.listAfter(fixture.host.id, execution.sequence)[0];
    if (!message) throw new Error("history_required");
    fixture.mailbox.publish(message);
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.type === "mailbox.permission_history")).toHaveLength(2)
    );
    await vi.waitFor(() =>
      expect(
        frames.filter(
          (frame) => frame.type === "mailbox.ack" && frame.sequence === historical.sequence
        ).length
      ).toBeGreaterThanOrEqual(2)
    );
    expect(second.client.status().state).toBe("connected");
    const before = await hostRow(
      fixture,
      "SELECT * FROM agent_host_compacted_mailbox_receipts WHERE sequence=?",
      historical.sequence
    );
    tamper = true;
    fixture.mailbox.publish(message);
    await vi.waitFor(() =>
      expect(second.client.status()).toEqual({ state: "degraded", reason: "invalid_server_event" })
    );
    expect(
      await hostRow(
        fixture,
        "SELECT * FROM agent_host_compacted_mailbox_receipts WHERE sequence=?",
        historical.sequence
      )
    ).toEqual(before);
    expect(
      await hostRow(
        fixture,
        "SELECT COUNT(*) AS count FROM agent_host_executions WHERE inbox_sequence=?",
        execution.sequence
      )
    ).toEqual({ count: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(second.relay.accept).not.toHaveBeenCalled();
  });

  it("drains simultaneous historical queues after both ACKs are lost and the Host reopens", async () => {
    const fixture = await setup();
    const eventJson = await insertOutbox(fixture);
    const historical = insertMailbox(fixture);
    const mailboxAcks = new Set<unknown>();
    let lostHost = false;
    let lostMailbox = false;
    let dropping = true;
    const frames = captureWrites((frame) => {
      if (frame.type === "mailbox.ack") mailboxAcks.add(frame.messageId);
      if (
        dropping &&
        frame.type === "host.event_ack" &&
        frame.messageId === fixture.request.messageId
      ) {
        lostHost = true;
        return true;
      }
      if (dropping && frame.type === "host.event_ack" && mailboxAcks.has(frame.messageId)) {
        lostMailbox = true;
        return true;
      }
      return false;
    });
    const first = await fixture.start();
    await vi.waitFor(() => expect([lostHost, lostMailbox]).toEqual([true, true]));
    expect(first.state.pendingEvents()).toContainEqual(fixture.request);
    expect(first.state.lastAcknowledgedSequence()).toBe(0);
    await first.stop();
    dropping = false;
    const next = nextCancellation(fixture);
    const second = await fixture.start();
    await vi.waitFor(() => expect(second.state.lastAcknowledgedSequence()).toBe(next.sequence));
    await vi.waitFor(() =>
      expect(second.state.pendingEvents()).not.toContainEqual(fixture.request)
    );
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(next.sequence);
    expect(
      frames
        .filter((frame) => frame.type === "host.permission_history")
        .map((frame) => frame.eventJson)
    ).toEqual([eventJson, eventJson]);
    expect(
      frames
        .filter((frame) => frame.type === "mailbox.permission_history")
        .map((frame) => frame.commandJson)
    ).toEqual([historical.commandJson, historical.commandJson]);
    expect(
      await hostRow(
        fixture,
        "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
        historical.sequence
      )
    ).toEqual({ command_json: historical.commandJson, command_digest: digest(fixture.response) });
    expect(second.relay.accept).not.toHaveBeenCalledWith(fixture.response);
  });

  it.each([
    "fresh",
    "existing",
    "stale-lease",
    "stale-attempt"
  ])("safely handles %s Server history with only an old outbox request", async (kind) => {
    const fixture = await setup();
    const delivery = queueExecution(fixture);
    captureWrites((frame) => frame.type === "dispatch.failed");
    let aborted = 0;
    const execute = vi.fn<AgentHostExecutor["execute"]>(
      async (_command, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted += 1;
              reject(new Error("cancelled"));
            },
            { once: true }
          );
        })
    );
    const running = await fixture.start(execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(running.state.lastAcknowledgedSequence()).toBe(delivery.sequence)
    );
    await updateHost(
      fixture,
      "UPDATE agent_host_executions SET status='interaction_wait' WHERE inbox_sequence=?",
      delivery.sequence
    );
    expect(
      await hostRow(
        fixture,
        "SELECT status FROM agent_host_executions WHERE inbox_sequence=?",
        delivery.sequence
      )
    ).toEqual({ status: "interaction_wait" });
    const request = {
      ...fixture.request,
      ...(kind === "stale-lease" ? { leaseId: "old-lease" } : {}),
      ...(kind === "stale-attempt" ? { executionAttemptId: "old-attempt" } : {})
    };
    if (kind === "existing") {
      const { protocolVersion: _version, messageId: _id, ...payload } = request;
      fixture.interactions.recordLegacyRequest(fixture.host.id, request.messageId, payload);
    }
    const eventJson = await insertOutbox(fixture, request);
    // Replaying an already accepted delivery triggers the real transport pump.
    fixture.mailbox.publish(delivery);
    await vi.waitFor(() => expect(running.state.pendingEvents()).not.toContainEqual(request));
    if (kind === "fresh" || kind === "existing") await vi.waitFor(() => expect(aborted).toBe(1));
    else {
      expect(aborted).toBe(0);
      expect(fixture.mailbox.listAfter(fixture.host.id, delivery.sequence)).toHaveLength(0);
      fixture.mailbox.publish(nextCancellation(fixture));
      await vi.waitFor(() => expect(aborted).toBe(1));
    }
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE command_json LIKE ?")
        .get("%allow_once%")?.count
    ).toBe(0);
    expect(
      await hostRow(
        fixture,
        "SELECT event_json FROM agent_host_outbox WHERE message_id=?",
        request.messageId
      )
    ).toEqual({ event_json: eventJson });
    expect(execute).toHaveBeenCalledOnce();
    expect(running.relay.accept).not.toHaveBeenCalledWith(fixture.response);
  });

  it("keeps cleanup failure fail-closed after historical receipt ACK and refuses another execution", async () => {
    const fixture = await setup();
    const delivery = queueExecution(fixture);
    const execute = vi.fn<AgentHostExecutor["execute"]>(
      async (_command, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () =>
              reject(
                new AgentHostExecutionError({
                  code: "acp_cleanup_failed",
                  message: "Controlled executor cleanup failed",
                  retryable: false
                })
              ),
            { once: true }
          );
        })
    );
    const frames = captureWrites();
    const running = await fixture.start(execute, "agent_host_execution_cleanup_failed");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(running.state.lastAcknowledgedSequence()).toBe(delivery.sequence)
    );
    const historical = insertMailbox(fixture, delivery.sequence);
    const message = fixture.mailbox.listAfter(fixture.host.id, delivery.sequence)[0];
    if (!message) throw new Error("history_required");
    fixture.mailbox.publish(message);
    await vi.waitFor(() =>
      expect(running.client.status()).toEqual({
        state: "reconciliation-required",
        reason: "execution_cleanup_failed"
      })
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "mailbox.ack", sequence: historical.sequence })
    );
    expect(
      frames.filter((frame) =>
        ["dispatch.completed", "dispatch.failed"].includes(String(frame.type))
      )
    ).toHaveLength(0);
    expect(
      await hostRow(
        fixture,
        "SELECT terminal_kind FROM agent_host_executions WHERE inbox_sequence=?",
        delivery.sequence
      )
    ).toEqual({ terminal_kind: null });
    expect(
      await hostRow(
        fixture,
        "SELECT cancellation_intent_json FROM agent_host_executions WHERE inbox_sequence=?",
        delivery.sequence
      )
    ).toEqual({ cancellation_intent_json: expect.any(String) });
    expect(
      await hostRow(
        fixture,
        "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
        historical.sequence
      )
    ).toEqual({ command_json: historical.commandJson, command_digest: digest(fixture.response) });
    const original = executeBlockCommandSchema.parse(delivery.command);
    const envelope = executionEnvelopeSchema.parse({
      ...original.envelope,
      execution: { dispatchId: "next-dispatch", attemptId: "next-attempt" }
    });
    const next = fixture.mailbox.enqueue(
      fixture.host.id,
      executeBlockCommandSchema.parse({
        ...original,
        dispatchId: "next-dispatch",
        executionAttemptId: "next-attempt",
        leaseId: "next-lease",
        envelope,
        envelopeDigest: hashExecutionEnvelope(envelope)
      })
    );
    fixture.mailbox.publish(next);
    running.client.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(execute).toHaveBeenCalledOnce();
    expect(running.client.status()).toEqual({
      state: "reconciliation-required",
      reason: "execution_cleanup_failed"
    });
    expect(running.relay.accept).not.toHaveBeenCalledWith(fixture.response);
    expect(
      await hostRow(
        fixture,
        "SELECT COUNT(*) AS count FROM agent_host_executions WHERE dispatch_id=?",
        "next-dispatch"
      )
    ).toEqual({ count: 0 });
    expect(fixture.mailbox.listAfter(fixture.host.id, historical.sequence)).toContainEqual(next);
  });
  it.each([
    false,
    true
  ])("rolls back cancellation failure with existing receipt=%s and safely retries the same wire identity", async (existing) => {
    const fixture = await setup();
    if (existing) {
      const { protocolVersion: _version, messageId: _id, ...request } = fixture.request;
      fixture.interactions.recordLegacyRequest(fixture.host.id, fixture.request.messageId, request);
    }
    const receiptSql = "SELECT * FROM host_event_receipts WHERE message_id=?";
    const before = fixture.server.database.prepare(receiptSql).get(fixture.request.messageId);
    const enqueue = vi
      .spyOn(SqliteRemoteDispatchPersistence.prototype, "enqueueCancel")
      .mockImplementationOnce(() => {
        throw new Error("controlled_cancel_persistence_failure");
      });
    const { socket, frames } = await connectRaw(fixture, headers);
    const replay = JSON.stringify({
      type: "host.permission_history",
      protocolVersion: 1,
      eventJson: JSON.stringify(fixture.request, null, 2)
    });
    socket.send(replay);
    await vi.waitFor(() =>
      expect(frames).toContainEqual(expect.objectContaining({ type: "protocol.error" }))
    );
    expect(
      frames.filter(
        (frame) => frame.type === "host.event_ack" && frame.messageId === fixture.request.messageId
      )
    ).toHaveLength(0);
    expect(fixture.server.database.prepare(receiptSql).get(fixture.request.messageId)).toEqual(
      before
    );
    expect(fixture.mailbox.listAfter(fixture.host.id, 0)).toHaveLength(0);
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_execution_actions")
        .get()?.count
    ).toBe(0);
    enqueue.mockRestore();
    socket.send(replay);
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "host.event_ack", messageId: fixture.request.messageId })
      )
    );
    expect(fixture.mailbox.listAfter(fixture.host.id, 0).map((message) => message.command)).toEqual(
      [expect.objectContaining({ type: "cancel_execution" })]
    );
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_execution_actions")
        .get()?.count
    ).toBe(1);
    if (existing)
      expect(fixture.server.database.prepare(receiptSql).get(fixture.request.messageId)).toEqual(
        before
      );
  });
});

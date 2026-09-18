import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXACT_PERMISSION_OPTIONS_VERSION_HEADER,
  HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER,
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxDeliverySchema
} from "@planweave-ai/agent-host-protocol";
import type { AgentHostExecutor } from "../../../agent-host/src/execution/agentHostExecutor.js";
import {
  setup,
  cleanupHistoricalPermissionReplay,
  captureWrites,
  insertOutbox,
  insertMailbox,
  nextCancellation,
  hostRow,
  digest,
  frameFrom,
  connectRaw
} from "./support/historicalPermissionReplayFixture.js";

afterEach(cleanupHistoricalPermissionReplay);

describe("persisted permission history over the real Host transport", () => {
  it("acknowledges an old SQLite outbox request through the exact permission Client", async () => {
    const fixture = await setup();
    const eventJson = await insertOutbox(fixture);
    const frames = captureWrites();
    const { state, client } = await fixture.start();
    await vi.waitFor(() =>
      expect(frames).toContainEqual(expect.objectContaining({ type: "host.welcome" }))
    );
    await vi.waitFor(
      () =>
        expect(state.pendingEvents()).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ messageId: fixture.request.messageId })
          ])
        ),
      { timeout: 2_000 }
    );
    expect(client.status().state).toBe("connected");
    expect(
      await hostRow(
        fixture,
        "SELECT event_json FROM agent_host_outbox WHERE message_id=?",
        fixture.request.messageId
      )
    ).toEqual({ event_json: eventJson });
  });

  it("settles an old SQLite mailbox response and advances to the next valid delivery", async () => {
    const fixture = await setup();
    insertMailbox(fixture);
    const next = nextCancellation(fixture);
    const frames = captureWrites();
    const { state, client, relay } = await fixture.start();
    await vi.waitFor(() =>
      expect(frames).toContainEqual(expect.objectContaining({ type: "host.welcome" }))
    );
    await vi.waitFor(() => expect(state.lastAcknowledgedSequence()).toBe(next.sequence), {
      timeout: 2_000
    });
    expect(client.status().state).toBe("connected");
    expect(relay.accept).not.toHaveBeenCalledWith(fixture.response);
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(next.sequence);
  });
  it("replays identical outbox bytes after an actually lost ACK and a fresh Host state", async () => {
    const fixture = await setup();
    const eventJson = await insertOutbox(fixture);
    let dropped = false;
    const frames = captureWrites((frame, socket) => {
      if (
        !dropped &&
        frame.type === "host.event_ack" &&
        frame.messageId === fixture.request.messageId
      ) {
        dropped = true;
        socket.terminate();
        return true;
      }
      return false;
    });
    const first = await fixture.start();
    await vi.waitFor(() => expect(dropped).toBe(true), { timeout: 2_000 });
    expect(first.state.pendingEvents()).toContainEqual(fixture.request);
    const receiptBefore = fixture.server.database
      .prepare(
        "SELECT request_fingerprint FROM host_event_receipts WHERE host_id=? AND message_id=?"
      )
      .get(fixture.host.id, fixture.request.messageId);
    expect(receiptBefore?.request_fingerprint).toEqual(expect.any(String));
    await first.stop();
    const second = await fixture.start();
    await vi.waitFor(
      () => expect(second.state.pendingEvents()).not.toContainEqual(fixture.request),
      { timeout: 2_000 }
    );
    expect(second.client.status().state).toBe("connected");
    expect(
      frames
        .filter((frame) => frame.type === "host.permission_history")
        .map((frame) => frame.eventJson)
    ).toEqual([eventJson, eventJson]);
    expect(
      fixture.server.database
        .prepare(
          "SELECT request_fingerprint FROM host_event_receipts WHERE host_id=? AND message_id=?"
        )
        .get(fixture.host.id, fixture.request.messageId)
    ).toEqual(receiptBefore);
    expect(
      await hostRow(
        fixture,
        "SELECT event_json FROM agent_host_outbox WHERE message_id=?",
        fixture.request.messageId
      )
    ).toEqual({ event_json: eventJson });
    await vi.waitFor(() =>
      expect(
        fixture.server.database
          .prepare(
            "SELECT COUNT(*) AS count FROM host_event_receipts WHERE host_id=? AND type='host.heartbeat'"
          )
          .get(fixture.host.id)?.count
      ).toBeGreaterThan(0)
    );
    expect(second.relay.accept).not.toHaveBeenCalledWith(fixture.response);
  });

  it("replays an unconfirmed mailbox receipt after reopen without changing JSON, digest or sequence", async () => {
    const fixture = await setup();
    const original = insertMailbox(fixture);
    let ackMessageId: unknown;
    let dropped = false;
    const frames = captureWrites((frame, socket) => {
      if (frame.type === "mailbox.ack" && frame.sequence === original.sequence)
        ackMessageId = frame.messageId;
      if (
        !dropped &&
        ackMessageId &&
        frame.type === "host.event_ack" &&
        frame.messageId === ackMessageId
      ) {
        dropped = true;
        socket.terminate();
        return true;
      }
      return false;
    });
    const first = await fixture.start();
    await vi.waitFor(() => expect(dropped).toBe(true), { timeout: 2_000 });
    expect(first.state.lastAcknowledgedSequence()).toBe(0);
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(
      original.sequence
    );
    const stored = await hostRow(
      fixture,
      "SELECT command_json,command_digest,message_id,previous_sequence FROM agent_host_inbox WHERE sequence=?",
      original.sequence
    );
    expect(stored).toEqual({
      command_json: original.commandJson,
      command_digest: digest(fixture.response),
      message_id: "historical-mailbox",
      previous_sequence: 0
    });
    await first.stop();
    const next = nextCancellation(fixture);
    const second = await fixture.start();
    await vi.waitFor(() => expect(second.state.lastAcknowledgedSequence()).toBe(next.sequence), {
      timeout: 2_000
    });
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(next.sequence);
    expect(
      await hostRow(
        fixture,
        "SELECT command_json,command_digest,message_id,previous_sequence FROM agent_host_inbox WHERE sequence=?",
        original.sequence
      )
    ).toEqual(stored);
    expect(frames.filter((frame) => frame.type === "mailbox.permission_history")).toEqual([
      {
        type: "mailbox.permission_history",
        protocolVersion: 1,
        sequence: original.sequence,
        previousSequence: 0,
        messageId: "historical-mailbox",
        commandJson: original.commandJson
      },
      {
        type: "mailbox.permission_history",
        protocolVersion: 1,
        sequence: original.sequence,
        previousSequence: 0,
        messageId: "historical-mailbox",
        commandJson: original.commandJson
      }
    ]);
    expect(
      frames
        .filter((frame) => frame.type === "host.hello")
        .map((frame) => frame.lastAcknowledgedSequence)
    ).toEqual([0, 0]);
    expect(second.relay.accept).not.toHaveBeenCalledWith(fixture.response);
    expect(second.client.status().state).toBe("connected");
  });
  it.each([
    "matching",
    "stale-lease",
    "stale-attempt"
  ])("settles %s history without granting permission to a live execution", async (kind) => {
    const fixture = await setup();
    const example = executeBlockCommandSchema.parse(
      mailboxDeliverySchema.parse(exampleExecuteDelivery).command
    );
    const envelope = executionEnvelopeSchema.parse({
      ...example.envelope,
      execution: {
        dispatchId: fixture.request.dispatchId,
        attemptId: fixture.request.executionAttemptId
      }
    });
    const executeMessage = fixture.mailbox.enqueue(
      fixture.host.id,
      executeBlockCommandSchema.parse({
        ...example,
        dispatchId: fixture.request.dispatchId,
        executionAttemptId: fixture.request.executionAttemptId,
        leaseId: fixture.request.leaseId,
        leaseExpiresAt: fixture.reservation.leaseExpiresAt,
        envelope,
        envelopeDigest: hashExecutionEnvelope(envelope)
      })
    );
    let aborted = false;
    const execute = vi.fn<AgentHostExecutor["execute"]>(
      async (_command, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("Execution cancelled"));
            },
            { once: true }
          );
        })
    );
    const running = await fixture.start(execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(running.state.lastAcknowledgedSequence()).toBe(executeMessage.sequence)
    );
    const response = {
      ...fixture.response,
      ...(kind === "stale-lease" ? { leaseId: "obsolete-lease" } : {}),
      ...(kind === "stale-attempt" ? { executionAttemptId: "obsolete-attempt" } : {})
    };
    const original = insertMailbox(fixture, executeMessage.sequence, response);
    const historical = fixture.mailbox.listAfter(fixture.host.id, executeMessage.sequence)[0];
    if (!historical) throw new Error("historical_mailbox_required");
    fixture.mailbox.publish(historical);
    await vi.waitFor(() =>
      expect(running.state.lastAcknowledgedSequence()).toBe(original.sequence)
    );
    expect(running.relay.accept).not.toHaveBeenCalledWith(response);
    if (kind === "matching") await vi.waitFor(() => expect(aborted).toBe(true));
    else {
      expect(aborted).toBe(false);
      expect(
        await hostRow(
          fixture,
          "SELECT status FROM agent_host_executions WHERE inbox_sequence=?",
          executeMessage.sequence
        )
      ).toEqual({ status: "running" });
      const next = nextCancellation(fixture);
      fixture.mailbox.publish(next);
      await vi.waitFor(() => expect(aborted).toBe(true));
      await vi.waitFor(() => expect(running.state.lastAcknowledgedSequence()).toBe(next.sequence));
    }
    if (kind !== "stale-attempt") {
      await vi.waitFor(async () =>
        expect(
          await hostRow(
            fixture,
            "SELECT command_digest FROM agent_host_compacted_mailbox_receipts WHERE sequence=?",
            original.sequence
          )
        ).toEqual({ command_digest: digest(response) })
      );
    } else {
      expect(
        await hostRow(
          fixture,
          "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
          original.sequence
        )
      ).toEqual({ command_json: original.commandJson, command_digest: digest(response) });
    }
    expect(
      fixture.server.database
        .prepare("SELECT command_json FROM mailbox_messages WHERE sequence=?")
        .get(original.sequence)
    ).toEqual({ command_json: original.commandJson });
    expect(
      await hostRow(
        fixture,
        "SELECT COUNT(*) AS count FROM agent_host_execution_actions WHERE response_json LIKE ?",
        "%allow_once%"
      )
    ).toEqual({ count: 0 });
    expect(execute).toHaveBeenCalledOnce();
    expect(running.client.status().state).toBe("connected");
  });

  it("acknowledges an old request for a replaced execution without recreating a live permission", async () => {
    const fixture = await setup();
    const request = {
      ...fixture.request,
      executionAttemptId: "replaced-attempt",
      expiresAt: "2020-01-01T00:00:00.000Z"
    };
    const eventJson = await insertOutbox(fixture, request);
    const { state, client } = await fixture.start();
    await vi.waitFor(() => expect(state.pendingEvents()).not.toContainEqual(request));
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_interactions WHERE action_id=?")
        .get(request.actionId)?.count
    ).toBe(0);
    expect(
      await hostRow(
        fixture,
        "SELECT event_json FROM agent_host_outbox WHERE message_id=?",
        request.messageId
      )
    ).toEqual({ event_json: eventJson });
    const next = nextCancellation(fixture);
    fixture.mailbox.publish(next);
    await vi.waitFor(() => expect(state.lastAcknowledgedSequence()).toBe(next.sequence));
    expect(client.status().state).toBe("connected");
  });
  it("retains Host history when the peer welcome lacks the replay capability", async () => {
    const fixture = await setup();
    const eventJson = await insertOutbox(fixture);
    const frames = captureWrites((frame, socket) => {
      if (frame.type === "host.welcome" && "historicalPermissionReplayVersion" in frame) {
        const { historicalPermissionReplayVersion: _version, ...oldWelcome } = frame;
        socket.send(JSON.stringify(oldWelcome));
        return true;
      }
      return false;
    });
    const running = await fixture.start();
    await vi.waitFor(() =>
      expect(running.client.status()).toEqual({
        state: "degraded",
        reason: "historical_permission_replay_unsupported"
      })
    );
    expect(running.state.pendingEvents()).toContainEqual(fixture.request);
    expect(
      frames.some(
        (frame) =>
          frame.type === "host.permission_history" ||
          frame.type === "interaction.permission_requested"
      )
    ).toBe(false);
    expect(
      await hostRow(
        fixture,
        "SELECT event_json FROM agent_host_outbox WHERE message_id=?",
        fixture.request.messageId
      )
    ).toEqual({ event_json: eventJson });
  });

  it("retains Server mailbox history and rejects replay when the Host did not negotiate it", async () => {
    const fixture = await setup();
    const original = insertMailbox(fixture);
    const { frames, socket } = await connectRaw(fixture, {
      [EXACT_PERMISSION_OPTIONS_VERSION_HEADER]: "1"
    });
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "protocol.error",
          code: "historical_permission_replay_unsupported"
        })
      )
    );
    expect(
      frames.some(
        (frame) => frame.type === "mailbox.message" || frame.type === "mailbox.permission_history"
      )
    ).toBe(false);
    expect(fixture.hosts.getRequired(fixture.host.id).lastAcknowledgedSequence).toBe(0);
    expect(
      fixture.server.database
        .prepare("SELECT command_json,acknowledged_at FROM mailbox_messages WHERE sequence=?")
        .get(original.sequence)
    ).toEqual({ command_json: original.commandJson, acknowledged_at: null });
    socket.send(
      JSON.stringify({
        type: "host.permission_history",
        protocolVersion: 1,
        eventJson: JSON.stringify(fixture.request)
      })
    );
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.type === "protocol.error")).toHaveLength(2)
    );
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM host_event_receipts WHERE message_id=?")
        .get(fixture.request.messageId)?.count
    ).toBe(0);
  });

  it.each([
    "bare-legacy",
    "missing-options-array",
    "malformed-history"
  ])("rejects %s online traffic while subsequent valid events still succeed", async (kind) => {
    const fixture = await setup();
    const { socket, frames } = await connectRaw(fixture, {
      [EXACT_PERMISSION_OPTIONS_VERSION_HEADER]: "1",
      [HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER]: "1"
    });
    const invalid =
      kind === "bare-legacy"
        ? fixture.request
        : {
            type: "host.permission_history",
            protocolVersion: 1,
            eventJson:
              kind === "malformed-history"
                ? "not-json"
                : JSON.stringify({ ...fixture.request, options: [] })
          };
    socket.send(JSON.stringify(invalid));
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "protocol.error", code: "schema_invalid" })
      )
    );
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM host_event_receipts WHERE message_id=?")
        .get(fixture.request.messageId)?.count
    ).toBe(0);
    socket.send(
      JSON.stringify({
        type: "host.heartbeat",
        protocolVersion: 1,
        messageId: "valid-after-rejection",
        activeLeases: []
      })
    );
    await vi.waitFor(() =>
      expect(frames).toContainEqual({
        type: "host.event_ack",
        protocolVersion: 1,
        messageId: "valid-after-rejection"
      })
    );
  });

  it("rejects changed historical event identity without replacing the original receipt", async () => {
    const fixture = await setup();
    const { socket, frames } = await connectRaw(fixture, {
      [EXACT_PERMISSION_OPTIONS_VERSION_HEADER]: "1",
      [HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER]: "1"
    });
    const send = (event: typeof fixture.request) =>
      socket.send(
        JSON.stringify({
          type: "host.permission_history",
          protocolVersion: 1,
          eventJson: JSON.stringify(event, null, 2)
        })
      );
    send(fixture.request);
    await vi.waitFor(() =>
      expect(frames).toContainEqual({
        type: "host.event_ack",
        protocolVersion: 1,
        messageId: fixture.request.messageId
      })
    );
    const receipt = fixture.server.database
      .prepare("SELECT request_fingerprint FROM host_event_receipts WHERE message_id=?")
      .get(fixture.request.messageId);
    send({ ...fixture.request, title: "Changed historical request" });
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "protocol.error", code: "host_event_message_id_reused" })
      )
    );
    expect(
      fixture.server.database
        .prepare("SELECT request_fingerprint FROM host_event_receipts WHERE message_id=?")
        .get(fixture.request.messageId)
    ).toEqual(receipt);
    expect(
      frames.filter(
        (frame) => frame.type === "host.event_ack" && frame.messageId === fixture.request.messageId
      )
    ).toHaveLength(1);
  });
  it("rejects different mailbox content on replay and preserves the first durable receipt", async () => {
    const fixture = await setup();
    const original = insertMailbox(fixture);
    let ackMessageId: unknown;
    let dropped = false;
    let tamper = false;
    captureWrites((frame, socket) => {
      if (frame.type === "mailbox.ack" && frame.sequence === original.sequence)
        ackMessageId = frame.messageId;
      if (
        !dropped &&
        ackMessageId &&
        frame.type === "host.event_ack" &&
        frame.messageId === ackMessageId
      ) {
        dropped = true;
        socket.terminate();
        return true;
      }
      if (tamper && frame.type === "mailbox.permission_history") {
        tamper = false;
        socket.send(
          JSON.stringify({
            ...frame,
            commandJson: JSON.stringify({
              ...frameFrom(original.commandJson),
              actionId: "different-action"
            })
          })
        );
        return true;
      }
      return false;
    });
    const first = await fixture.start();
    await vi.waitFor(() => expect(dropped).toBe(true));
    const before = await hostRow(
      fixture,
      "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
      original.sequence
    );
    await first.stop();
    tamper = true;
    const second = await fixture.start();
    await vi.waitFor(() =>
      expect(second.client.status()).toEqual({ state: "degraded", reason: "invalid_server_event" })
    );
    expect(second.state.lastAcknowledgedSequence()).toBe(0);
    expect(
      await hostRow(
        fixture,
        "SELECT command_json,command_digest FROM agent_host_inbox WHERE sequence=?",
        original.sequence
      )
    ).toEqual(before);
    expect(second.relay.accept).not.toHaveBeenCalledWith(fixture.response);
    expect(
      fixture.server.database
        .prepare("SELECT command_json FROM mailbox_messages WHERE sequence=?")
        .get(original.sequence)
    ).toEqual({ command_json: original.commandJson });
  });
});

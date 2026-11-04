import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import {
  ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES,
  acpConversationPromptCommandSchema,
  hostEventSchema
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outboxFailureHarness } from "./support/agentHostOutboxFailureHarness.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("Agent Host durable outbox failures", () => {
  it("replays unacknowledged text chunks after a real WebSocket disconnect with stable identities", async () => {
    const f = await outboxFailureHarness(cleanups, {
      serverMaxPayloadBytes: 64 * 1024,
      limits: { maxOutboundBatch: 1 }
    });
    f.setAutoAck(false);
    const content = "\u0000😀".repeat(10000);
    f.state.conversations.append(f.command.turnId, {
      kind: "runner",
      fragment: {
        kind: "runner_body",
        body: {
          kind: "terminal_output",
          terminalId: "terminal",
          content,
          redaction: { classes: [], replaced: 0 }
        }
      }
    });
    const original = f.state.pendingEvents();
    expect(original.length).toBeGreaterThan(1);
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    const acknowledged = f.received[0]!;
    f.peer().send(
      JSON.stringify({
        type: "host.event_ack",
        protocolVersion: agentHostProtocolVersion,
        messageId: acknowledged.messageId
      })
    );
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    expect(f.state.pendingEvents().map((event) => event.messageId)).not.toContain(
      acknowledged.messageId
    );
    f.peer().terminate();
    await vi.waitFor(() => expect(f.client.status().state).toBe("backing-off"));
    f.setAutoAck(true);
    f.clock.advanceBy(1000);
    await vi.waitFor(() => expect(f.client.status().state).toBe("connected"));
    await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
    const unique = [...new Map(f.received.map((event) => [event.messageId, event])).values()];
    expect(unique).toEqual(original);
    expect(f.received.filter((event) => event.messageId === acknowledged.messageId)).toHaveLength(
      1
    );
    expect(f.received.length).toBeGreaterThan(unique.length);
    expect(
      unique
        .map((event) =>
          event.type === "acp_conversation.event" &&
          event.payload.kind === "runner" &&
          event.payload.fragment.kind === "runner_body" &&
          "content" in event.payload.fragment.body
            ? event.payload.fragment.body.content
            : ""
        )
        .join("")
    ).toBe(content);
    expect(f.received.every((event) => Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024)).toBe(
      true
    );
  });
  it.each([
    null,
    "invalid",
    "0",
    "9007199254740992"
  ])("rejects missing or invalid budget %s without conversation capability or accepting work", async (budgetHeader) => {
    const f = await outboxFailureHarness(cleanups, { budgetHeader, connected: false });
    await vi.waitFor(() =>
      expect(f.client.status()).toEqual({
        state: "degraded",
        reason: "agent_host_outbound_payload_budget_unsupported"
      })
    );
    expect(f.hellos()).toBe(0);
    expect(f.state.pendingEvents()).toEqual([]);
  });

  it.each([
    "ordinary",
    "historical"
  ] as const)("rejects a lower reconnect budget before hello and preserves immutable %s pending evidence", async (kind) => {
    const f = await outboxFailureHarness(cleanups);
    f.setAutoAck(false);
    if (kind === "ordinary") {
      f.append(100000);
      await vi.waitFor(() => expect(f.received).toHaveLength(1));
    } else {
      const event = {
        type: "interaction.permission_requested",
        protocolVersion: agentHostProtocolVersion,
        messageId: "legacy-large",
        dispatchId: "dispatch",
        leaseId: "lease",
        executionAttemptId: "attempt",
        acpSessionId: "session",
        actionId: "action",
        expiresAt: "2099-01-01T00:00:00.000Z",
        title: "Legacy",
        description: "\u0000".repeat(9500)
      };
      const eventJson = JSON.stringify(event);
      expect(Buffer.byteLength(eventJson)).toBeLessThan(64 * 1024);
      f.database
        .prepare(
          "INSERT INTO agent_host_outbox(message_id,event_key,event_json,created_at) VALUES(?,?,?,?)"
        )
        .run(event.messageId, "legacy-large", eventJson, new Date().toISOString());
    }
    const immutable = f.database
      .prepare(
        "SELECT message_id,event_json,acknowledged_at FROM agent_host_outbox WHERE acknowledged_at IS NULL ORDER BY sequence"
      )
      .all();
    f.setBudgetHeader(String(64 * 1024));
    f.peer().terminate();
    await vi.waitFor(() => expect(f.client.status().state).toBe("backing-off"));
    f.clock.advanceBy(1000);
    await vi.waitFor(() =>
      expect(f.client.status()).toEqual({
        state: "reconciliation-required",
        reason: "agent_host_outbound_payload_too_large"
      })
    );
    expect(f.connections()).toBe(2);
    expect(f.hellos()).toBe(1);
    expect(
      f.database
        .prepare(
          "SELECT message_id,event_json,acknowledged_at FROM agent_host_outbox WHERE acknowledged_at IS NULL ORDER BY sequence"
        )
        .all()
    ).toEqual(immutable);
  });
  it.each([
    { local: 256 * 1024, server: 64 * 1024 },
    { local: 64 * 1024, server: 256 * 1024 }
  ])("rejects new events above negotiated $local/$server bytes and keeps draining terminal and other work", async ({
    local,
    server
  }) => {
    let rejection: unknown;
    const f = await outboxFailureHarness(cleanups, {
      conversationCapability: true,
      limits: { maxPayloadBytes: local },
      serverMaxPayloadBytes: server,
      converse: async (command, broker, _sink, signal) => {
        try {
          await broker.requestElicitation(
            {
              requestId: "oversized",
              message: "Large schema",
              requestedSchema: { description: "x".repeat(70 * 1024) }
            },
            { signal, deadline: new Date(command.expiresAt) }
          );
        } catch (error) {
          rejection = error;
          throw error;
        }
        return {
          terminal: { state: "succeeded", stopReason: "end_turn" },
          cleanup: { attempted: true, completed: true }
        };
      }
    });
    const overflow = {
      ...f.command,
      operationId: "overflow-op",
      turnId: "overflow-turn",
      sessionId: "overflow-session"
    };
    f.state.conversations.accept(overflow);
    f.conversations.handle(overflow);
    await vi.waitFor(() =>
      expect(f.received).toContainEqual(
        expect.objectContaining({
          turnId: overflow.turnId,
          sequence: 2,
          payload: { kind: "status", status: "failed", error: "acp_conversation_cleanup_failed" }
        })
      )
    );
    expect(rejection).toMatchObject({ message: "acp_conversation_event_too_large" });
    f.append(10);
    f.state.conversations.append(f.command.turnId, {
      kind: "status",
      status: "completed",
      error: null
    });
    await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
    expect(
      f.received
        .filter((e) => e.type === "acp_conversation.event")
        .map((e) => [e.turnId, e.sequence])
    ).toEqual([
      [overflow.turnId, 1],
      [overflow.turnId, 2],
      [f.command.turnId, 2],
      [f.command.turnId, 3]
    ]);
    expect(f.client.status().state).toBe("connected");
    expect(f.connections()).toBe(1);
  });

  it("drains maximum legal command identities at the minimum negotiated terminal budget", async () => {
    const f = await outboxFailureHarness(cleanups, {
      conversationCapability: true,
      serverMaxPayloadBytes: ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES
    });
    const command = acpConversationPromptCommandSchema.parse({
      ...f.command,
      operationId: "\u0000".repeat(256),
      turnId: "\u0000".repeat(256),
      executionAttemptId: "a".repeat(128),
      sessionId: "\u0000".repeat(1024),
      sourceEnvelope: {
        ...f.command.sourceEnvelope,
        execution: { ...f.command.sourceEnvelope.execution, attemptId: "a".repeat(128) }
      }
    });
    f.state.conversations.accept(command);
    f.state.conversations.start(command.turnId);
    f.state.conversations.append(command.turnId, {
      kind: "status",
      status: "failed",
      error: `acp_conversation_${"x".repeat(111)}`
    });
    await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
    expect(
      f.received.filter((e) => e.type === "acp_conversation.event").map((e) => e.payload)
    ).toEqual([
      { kind: "status", status: "running", error: null },
      { kind: "status", status: "failed", error: `acp_conversation_${"x".repeat(111)}` }
    ]);
    expect(
      f.received.every(
        (e) => Buffer.byteLength(JSON.stringify(e)) <= ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES
      )
    ).toBe(true);
    expect(f.client.status().state).toBe("connected");
  });

  it("rejects an insufficient local conversation budget before startup", async () => {
    await expect(
      outboxFailureHarness(cleanups, {
        conversationCapability: true,
        limits: { maxPayloadBytes: ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES - 1 },
        connected: false
      })
    ).rejects.toThrow("agent_host_conversation_payload_budget_too_small");
  });

  it.each([
    null,
    "invalid",
    "9007199254740992",
    "1024",
    String(ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES - 1)
  ])("fails closed before event production for budget %s", async (budgetHeader) => {
    const f = await outboxFailureHarness(cleanups, {
      conversationCapability: true,
      budgetHeader,
      connected: false
    });
    await vi.waitFor(() =>
      expect(f.client.status()).toEqual({
        state: "degraded",
        reason:
          budgetHeader === "1024" ||
          budgetHeader === String(ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES - 1)
            ? "agent_host_conversation_payload_budget_too_small"
            : "agent_host_outbound_payload_budget_unsupported"
      })
    );
    await vi.waitFor(() => expect(f.clock.pendingTimerCount()).toBe(0));
    expect(f.received).toEqual([]);
    expect(f.attached()).toBe(0);
    expect(f.state.pendingEvents()).toHaveLength(0);
  });

  it("fully stops an active conversation if reconnect loses the negotiated budget", async () => {
    let activeSignal: AbortSignal | undefined;
    const f = await outboxFailureHarness(cleanups, {
      conversationCapability: true,
      converse: async (_command, _broker, _sink, signal) => {
        activeSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
        return {
          terminal: { state: "cancelled", stopReason: "cancelled" },
          cleanup: { attempted: true, completed: true }
        };
      }
    });
    const active = { ...f.command, turnId: "active-turn", sessionId: "active-session" };
    f.state.conversations.accept(active);
    f.conversations.handle(active);
    expect(f.conversations.isSessionActive(active.sessionId)).toBe(true);
    const stop = vi.spyOn(f.conversations, "stop");
    const recover = vi.spyOn(f.conversations, "recover");
    f.setBudgetHeader(null);
    f.peer().terminate();
    await vi.waitFor(() => expect(f.client.status().state).toBe("backing-off"));
    f.clock.advanceBy(50);
    await vi.waitFor(() =>
      expect(f.client.status()).toEqual({
        state: "degraded",
        reason: "agent_host_outbound_payload_budget_unsupported"
      })
    );
    await vi.waitFor(() => expect(f.clock.pendingTimerCount()).toBe(0));
    expect(activeSignal?.aborted).toBe(true);
    expect(f.conversations.isSessionActive(active.sessionId)).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(f.attached()).toBe(0);
  });

  it.each([
    { failure: "oversized payload", reason: "agent_host_outbound_payload_too_large" },
    { failure: "invalid JSON", reason: "agent_host_outbox_record_invalid" },
    { failure: "invalid schema", reason: "agent_host_outbox_record_invalid" }
  ])("stops $failure without losing records and recovers after explicit coordination", async ({
    failure,
    reason
  }) => {
    const f = await outboxFailureHarness(cleanups);
    const peer = f.peer();
    const closed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    f.append(10);
    const pending = f.state.pendingEvents();
    const target = pending.at(-1);
    if (!target) throw new Error("expected_pending_event");
    const originalJson = JSON.stringify(target);
    if (failure === "oversized payload") {
      const historical = hostEventSchema.parse(JSON.parse(originalJson));
      if (
        historical.type !== "acp_conversation.event" ||
        historical.payload.kind !== "interaction" ||
        historical.payload.request.kind !== "elicitation"
      )
        throw new Error("expected_elicitation_event");
      historical.payload.request.requestedSchema.description = "x".repeat(300_000);
      f.database
        .prepare("UPDATE agent_host_outbox SET event_json=? WHERE message_id=?")
        .run(JSON.stringify(historical), target.messageId);
    } else {
      f.database
        .prepare("UPDATE agent_host_outbox SET event_json=? WHERE message_id=?")
        .run(failure === "invalid JSON" ? "{" : '{"type":"invalid"}', target.messageId);
    }
    const storedJson = f.database
      .prepare("SELECT event_json FROM agent_host_outbox WHERE message_id=?")
      .get(target.messageId)?.event_json;
    await vi.waitFor(() =>
      expect(f.client.status()).toEqual({ state: "reconciliation-required", reason })
    );
    await closed;
    await vi.waitFor(() => expect(f.clock.pendingTimerCount()).toBe(0));
    expect(f.attached()).toBe(0);
    expect(
      f.database
        .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE message_id=?")
        .get(target.messageId)
    ).toEqual({ event_json: storedJson, acknowledged_at: null });
    const notifications = f.notifications();
    f.append(11);
    f.clock.advanceBy(120_000);
    await Promise.resolve();
    expect(f.notifications()).toBe(notifications);
    expect(f.connections()).toBe(1);
    expect(f.received).toEqual([]);

    // Restarting without coordinating the record stops again instead of retrying forever.
    await f.client.stop();
    f.client.start();
    await vi.waitFor(() => expect(f.connections()).toBe(2));
    await vi.waitFor(() =>
      expect(f.client.status()).toEqual({ state: "reconciliation-required", reason })
    );
    await f.client.stop();
    expect(f.attached()).toBe(0);
    expect(f.clock.pendingTimerCount()).toBe(0);

    const repaired = hostEventSchema.parse(JSON.parse(originalJson));
    if (failure === "oversized payload") {
      if (
        repaired.type !== "acp_conversation.event" ||
        repaired.payload.kind !== "interaction" ||
        repaired.payload.request.kind !== "elicitation"
      )
        throw new Error("expected_elicitation_event");
      repaired.payload.request.requestedSchema.description = "coordinated";
    }
    f.database
      .prepare("UPDATE agent_host_outbox SET event_json=? WHERE message_id=?")
      .run(JSON.stringify(repaired), target.messageId);
    f.client.start();
    await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
    expect(f.client.status().state).toBe("connected");
    expect(f.connections()).toBe(3);
    expect(f.attached()).toBe(1);
    expect(f.received.find((event) => event.messageId === target.messageId)).toEqual(repaired);
    await f.client.stop();
    expect(f.attached()).toBe(0);
    expect(f.clock.pendingTimerCount()).toBe(0);
  });

  it.each([
    "socket disconnected",
    "temporary SQLite busy"
  ])("reconnects and continues after $failure", async (failure) => {
    const f = await outboxFailureHarness(cleanups);
    f.setAutoAck(false);
    f.append();
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    const pending = f.state.pendingEvents();
    if (failure === "temporary SQLite busy") {
      const read = f.state.pendingEvents.bind(f.state);
      vi.spyOn(f.state, "pendingEvents")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("database is locked"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 5
          });
        })
        .mockImplementation(read);
      f.append(12);
    } else f.peer().terminate();
    await vi.waitFor(() => expect(f.client.status().state).toBe("backing-off"));
    f.setAutoAck(true);
    f.clock.advanceBy(50);
    await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
    expect(f.connections()).toBe(2);
    expect(f.received.filter((event) => event.messageId === pending[0]?.messageId)).toHaveLength(2);
    f.append(13);
    await vi.waitFor(() => expect(f.state.pendingEventCount()).toBe(0));
    expect(f.client.status().state).toBe("connected");
  });
});

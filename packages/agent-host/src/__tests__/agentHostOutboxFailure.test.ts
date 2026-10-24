import { hostEventSchema } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outboxFailureHarness } from "./support/agentHostOutboxFailureHarness.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("Agent Host durable outbox failures", () => {
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
    f.append(failure === "oversized payload" ? 300_000 : 10);
    const pending = f.state.pendingEvents();
    const target = pending.at(-1);
    if (!target) throw new Error("expected_pending_event");
    const originalJson = JSON.stringify(target);
    if (failure !== "oversized payload") {
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

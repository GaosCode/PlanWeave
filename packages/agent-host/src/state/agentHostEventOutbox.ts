import { randomUUID } from "node:crypto";
import { parseHistoricalPermissionEventJson } from "@planweave-ai/agent-host-protocol";
import type { HostReadinessObservation } from "@planweave-ai/agent-host-protocol";
import {
  parseAgentHostEvent,
  parseHistoricalAgentHostEvent,
  type HistoricalHostEvent,
  type HostEvent
} from "../protocol.js";
import { outboxRowSchema } from "./agentHostStateRecords.js";
import type { SqliteDatabase } from "./sqliteDatabase.js";

function sameEventPayload(left: HistoricalHostEvent, right: HistoricalHostEvent): boolean {
  const { messageId: _leftMessageId, ...leftPayload } = left;
  const { messageId: _rightMessageId, ...rightPayload } = right;
  return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
}

export class AgentHostEventOutbox {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly maxPendingEvents: number
  ) {}

  pending(limit = this.maxPendingEvents): HistoricalHostEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("agent_host_pending_event_query_limit_invalid");
    }
    return this.database
      .prepare(
        `SELECT event_json FROM agent_host_outbox
         WHERE acknowledged_at IS NULL ORDER BY sequence ASC LIMIT ?`
      )
      .all(limit)
      .map((raw) =>
        parseHistoricalAgentHostEvent(JSON.parse(outboxRowSchema.parse(raw).event_json))
      );
  }

  historicalPermissionEventJson(messageId: string): string {
    const row = this.database
      .prepare(
        "SELECT event_json FROM agent_host_outbox WHERE message_id=? AND acknowledged_at IS NULL"
      )
      .get(messageId);
    if (!row) throw new Error("historical_permission_event_not_pending");
    const raw = outboxRowSchema.parse(row).event_json;
    if (parseHistoricalPermissionEventJson(raw).messageId !== messageId)
      throw new Error("host_event_identity_conflict");
    return raw;
  }

  pendingCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM agent_host_outbox WHERE acknowledged_at IS NULL")
      .get();
    return Number(row?.count ?? 0);
  }

  queue(eventKey: string, input: HostEvent): HostEvent {
    const event = parseAgentHostEvent(input);
    const existing = this.database
      .prepare("SELECT event_json FROM agent_host_outbox WHERE event_key=?")
      .get(eventKey);
    if (existing) {
      const stored = parseHistoricalAgentHostEvent(JSON.parse(String(existing.event_json)));
      if (!sameEventPayload(stored, event)) throw new Error("host_event_identity_conflict");
      return parseAgentHostEvent(stored);
    }
    if (this.pendingCount() >= this.maxPendingEvents) {
      throw new Error("agent_host_pending_event_capacity_exceeded");
    }
    this.database
      .prepare(
        `INSERT INTO agent_host_outbox(message_id,event_key,event_json,created_at)
         VALUES(?,?,?,?)`
      )
      .run(event.messageId, eventKey, JSON.stringify(event), new Date().toISOString());
    return event;
  }

  queueHeartbeat(
    activeLeases: ReadonlyArray<{
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    }>,
    readiness?: HostReadinessObservation
  ): HostEvent {
    const heartbeat = parseAgentHostEvent({
      type: "host.heartbeat",
      protocolVersion: 1,
      messageId: randomUUID(),
      activeLeases,
      ...(readiness ? { readiness } : {})
    });
    const existing = this.database
      .prepare(
        "SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE event_key='host.heartbeat'"
      )
      .get();
    if (existing) {
      const stored = parseHistoricalAgentHostEvent(JSON.parse(String(existing.event_json)));
      if (!existing.acknowledged_at && sameEventPayload(stored, heartbeat))
        return parseAgentHostEvent(stored);
      this.database.prepare("DELETE FROM agent_host_outbox WHERE event_key='host.heartbeat'").run();
    }
    return this.queue("host.heartbeat", heartbeat);
  }

  acknowledge(messageId: string):
    | { found: false }
    | { found: true; alreadyAcknowledged: true }
    | {
        found: true;
        alreadyAcknowledged: false;
        event: HistoricalHostEvent;
        acknowledgedAt: string;
      } {
    const raw = this.database
      .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE message_id=?")
      .get(messageId);
    if (!raw) return { found: false };
    if (raw.acknowledged_at) return { found: true, alreadyAcknowledged: true };
    const event = parseHistoricalAgentHostEvent(JSON.parse(String(raw.event_json)));
    const acknowledgedAt = new Date().toISOString();
    this.database
      .prepare("UPDATE agent_host_outbox SET acknowledged_at=? WHERE message_id=?")
      .run(acknowledgedAt, messageId);
    return { found: true, alreadyAcknowledged: false, event, acknowledgedAt };
  }
}

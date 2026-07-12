import type { SqliteDatabase } from "../sqlite.js";
import type { EventEnvelopeV1, Page, ProjectRecordV1, ProjectSnapshotV1 } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

// Maximum number of events the publisher will deliver to a single subscriber per poll cycle.
// Picked so that a single cycle can drain a full 1000-event backlog in 10 cycles.
// Tests may override; this is a safety bound to prevent unbounded reads.
export const DEFAULT_PUBLISHER_BATCH_SIZE = 200;

// Read events with `event_id > afterEventId` for `projectId`, in stable event_id order.
// The cursor is `event_id` — never `occurred_at` (event_id is the source of truth for ordering).
// Returns the page plus the next opaque cursor (the last event_id in this page), or null if
// the returned page is shorter than the requested limit (meaning we've reached the latest event).
export function readEventsPage(
  database: SqliteDatabase,
  input: { projectId: string; afterEventId: string; limit: number },
): Page<EventEnvelopeV1> {
  if (!/^\d+$/.test(input.afterEventId)) {
    throw new RepositoryError("cursor_invalid", "afterEventId must be a decimal integer");
  }
  if (input.limit < 1 || input.limit > 100) {
    throw new RepositoryError("validation_failed", "limit must be between 1 and 100");
  }
  const rows = database
    .prepare(
      "SELECT event_id, project_id, aggregate_type, aggregate_id, aggregate_version, type, occurred_at FROM domain_events WHERE project_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?",
    )
    .all(input.projectId, input.afterEventId, input.limit) as Array<Record<string, unknown>>;
  const items: EventEnvelopeV1[] = rows.map((row) => ({
    protocolVersion: PROTOCOL_VERSION,
    eventId: String(row.event_id),
    projectId: String(row.project_id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    aggregateVersion: Number(row.aggregate_version),
    type: String(row.type),
    occurredAt: String(row.occurred_at),
  }));
  const nextCursor = items.length === input.limit ? items[items.length - 1]!.eventId : null;
  return { items, nextCursor };
}

// Read the project's current state and the highest durable event_id for that project.
// Throws RepositoryError("not_found") if the project doesn't exist.
export function readProjectSnapshot(database: SqliteDatabase, projectId: string): ProjectSnapshotV1 {
  const projectRow = database.prepare("SELECT id, version, name, created_at FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!projectRow) throw new RepositoryError("not_found", `Project ${projectId} not found`);
  const project: ProjectRecordV1 = { id: String(projectRow.id), version: Number(projectRow.version), name: String(projectRow.name), createdAt: String(projectRow.created_at) };
  const lastRow = database.prepare("SELECT MAX(event_id) AS last_event_id FROM domain_events WHERE project_id = ?").get(projectId) as Record<string, unknown> | undefined;
  const lastEventId = lastRow?.last_event_id == null ? "0" : String(lastRow.last_event_id);
  return { project, lastEventId };
}

// Resolve the highest durable event_id for `projectId`. Returns "0" if no events exist.
export function readLastEventId(database: SqliteDatabase, projectId: string): string {
  const row = database
    .prepare("SELECT MAX(event_id) AS last_event_id FROM domain_events WHERE project_id = ?")
    .get(projectId) as Record<string, unknown> | undefined;
  return row?.last_event_id == null ? "0" : String(row.last_event_id);
}

// Read the most recent durable event whose occurred_at is >= (now - retentionMs).
// Used to decide whether a requested afterEventId is still inside the retention window.
// Returns "0" when no events exist or no event is within the window.
export function readOldestEventIdWithinRetention(database: SqliteDatabase, input: { projectId: string; retentionMs: number; nowMs: number }): string {
  const cutoffIso = new Date(input.nowMs - input.retentionMs).toISOString();
  const row = database
    .prepare("SELECT MIN(event_id) AS oldest_event_id FROM domain_events WHERE project_id = ? AND occurred_at >= ?")
    .get(input.projectId, cutoffIso) as Record<string, unknown> | undefined;
  return row?.oldest_event_id == null ? "0" : String(row.oldest_event_id);
}

// Read durable events for a project, after a given event_id, in stable event_id order.
// This is the publisher's internal read path — it is NOT bound to the HTTP API's
// 1..100 page limit. The publisher may batch up to DEFAULT_PUBLISHER_BATCH_SIZE events
// per tick (default 200), and the limit is a safety bound only.
export function readEventsForPublisher(
  database: SqliteDatabase,
  input: { projectId: string; afterEventId: string; limit: number },
): EventEnvelopeV1[] {
  if (!/^\d+$/.test(input.afterEventId)) {
    throw new RepositoryError("cursor_invalid", "afterEventId must be a decimal integer");
  }
  if (input.limit < 1) {
    throw new RepositoryError("validation_failed", "limit must be >= 1");
  }
  const rows = database
    .prepare(
      "SELECT event_id, project_id, aggregate_type, aggregate_id, aggregate_version, type, occurred_at FROM domain_events WHERE project_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?",
    )
    .all(input.projectId, input.afterEventId, input.limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    protocolVersion: PROTOCOL_VERSION,
    eventId: String(row.event_id),
    projectId: String(row.project_id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    aggregateVersion: Number(row.aggregate_version),
    type: String(row.type),
    occurredAt: String(row.occurred_at),
  }));
}

export class RepositoryError extends Error {
  public readonly code: "not_found" | "validation_failed" | "cursor_invalid" | "internal_error";
  constructor(code: "not_found" | "validation_failed" | "cursor_invalid" | "internal_error", message: string) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
  }
}

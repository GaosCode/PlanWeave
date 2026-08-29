import {
  ACP_EVENT_BATCH_MAX_COUNT,
  acpEventCursorSchema,
  canonicalizeJson,
  normalizedAcpEventBatchSchema,
  normalizedAcpEventSchema,
  remoteRunnerEventBatchV2Schema,
  remoteRunnerEventV2Schema,
  type EngineUsageSnapshotLeaf,
  type NormalizedAcpEvent,
  type RemoteRunnerEventV2
} from "@planweave-ai/agent-host-protocol";
import {
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  RUNNER_EVENT_RETENTION_MAX_EVENTS,
  redactRunnerEventText
} from "@planweave-ai/runtime";
import { z } from "zod";
import { HostEventInbox } from "./hostEvents.js";
import type { SqliteDatabase } from "./sqlite.js";

export const REMOTE_ACP_EVENT_RETENTION_MAX_EVENTS = RUNNER_EVENT_RETENTION_MAX_EVENTS;
export const REMOTE_ACP_EVENT_RETENTION_MAX_BYTES = RUNNER_EVENT_RETENTION_MAX_BYTES;

export type RemoteAcpEventReplay = {
  executionAttemptId: string;
  afterCursor: number;
  cursor: number;
  highWatermark: number;
  hasMore: boolean;
  eventProtocolVersion: 1 | 2;
  events: Array<NormalizedAcpEvent | RemoteRunnerEventV2>;
  diagnostics: Array<{
    code: "remote_acp_event_retention_gap" | "remote_acp_event_contract_degraded";
    droppedThroughCursor?: number;
  }>;
};

/** Result of ingesting a host ACP batch. Soft drops keep the Host session writable. */
export type RemoteAcpEventIngestResult = RemoteAcpEventReplay & {
  accepted: boolean;
  dropReason?: "remote_acp_event_attempt_not_writable";
};

function emptyDroppedReplay(
  executionAttemptId: string,
  afterCursor: number
): RemoteAcpEventIngestResult {
  return {
    accepted: false,
    dropReason: "remote_acp_event_attempt_not_writable",
    executionAttemptId,
    afterCursor,
    cursor: afterCursor,
    highWatermark: afterCursor,
    hasMore: false,
    eventProtocolVersion: 1,
    events: [],
    diagnostics: []
  };
}

function logAcpEventDropped(input: {
  hostId: string;
  messageId: string;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
}): void {
  console.warn(
    JSON.stringify({
      scope: "agent-host-ws",
      event: "remote_acp_event_dropped",
      reason: "remote_acp_event_attempt_not_writable",
      hostId: input.hostId,
      messageId: input.messageId,
      dispatchId: input.dispatchId,
      leaseId: input.leaseId,
      executionAttemptId: input.executionAttemptId
    })
  );
}

type RemoteAcpEventRepositoryOptions = {
  maxEvents?: number;
  maxBytes?: number;
  clock?: () => Date;
};

type RemoteAcpCounterDelta = {
  usageSnapshotsAccepted: number;
  usageSnapshotRegressions: number;
};

function redactEvent(event: NormalizedAcpEvent): NormalizedAcpEvent {
  switch (event.kind) {
    case "agent_message":
      return normalizedAcpEventSchema.parse({
        ...event,
        text: redactRunnerEventText(event.text).text
      });
    case "plan":
      return normalizedAcpEventSchema.parse({
        ...event,
        text: redactRunnerEventText(event.text).text
      });
    case "diagnostic":
      return normalizedAcpEventSchema.parse({
        ...event,
        message: redactRunnerEventText(event.message).text
      });
    case "tool_call":
      return normalizedAcpEventSchema.parse({
        ...event,
        title: redactRunnerEventText(event.title).text
      });
  }
}

export class RemoteAcpEventRepository {
  private readonly inbox: HostEventInbox;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly counters = {
    v1Accepted: 0,
    v2Accepted: 0,
    v1Degraded: 0,
    usageSnapshotsAccepted: 0,
    usageSnapshotRegressions: 0
  };

  metrics(): Readonly<typeof this.counters> {
    return { ...this.counters };
  }

  constructor(
    private readonly database: SqliteDatabase,
    options: RemoteAcpEventRepositoryOptions = {}
  ) {
    this.inbox = new HostEventInbox(database);
    this.maxEvents = z
      .number()
      .int()
      .positive()
      .parse(options.maxEvents ?? REMOTE_ACP_EVENT_RETENTION_MAX_EVENTS);
    this.maxBytes = z
      .number()
      .int()
      .positive()
      .parse(options.maxBytes ?? REMOTE_ACP_EVENT_RETENTION_MAX_BYTES);
    this.clock = options.clock ?? (() => new Date());
  }

  ingest(hostId: string, messageId: string, rawBatch: unknown): RemoteAcpEventIngestResult {
    const requestedVersion =
      typeof rawBatch === "object" && rawBatch !== null && "eventProtocolVersion" in rawBatch
        ? (rawBatch as { eventProtocolVersion?: unknown }).eventProtocolVersion
        : 1;
    const batch =
      requestedVersion === 2
        ? remoteRunnerEventBatchV2Schema.parse(rawBatch)
        : normalizedAcpEventBatchSchema.parse(rawBatch);
    const eventProtocolVersion = requestedVersion === 2 ? 2 : 1;
    const redactedEvents: Array<NormalizedAcpEvent | RemoteRunnerEventV2> =
      eventProtocolVersion === 1
        ? batch.events.map((event) => redactEvent(event as NormalizedAcpEvent))
        : ([...batch.events] as RemoteRunnerEventV2[]);
    const counterDelta: RemoteAcpCounterDelta = {
      usageSnapshotsAccepted: 0,
      usageSnapshotRegressions: 0
    };
    let dropReason: "remote_acp_event_attempt_not_writable" | undefined;
    const applied = this.inbox.process(hostId, messageId, batch.type, batch, () => {
      const identity = this.findWritableAttempt({
        hostId,
        dispatchId: batch.dispatchId,
        leaseId: batch.leaseId,
        executionAttemptId: batch.executionAttemptId
      });
      // Expected race after interrupt, lease resume, or terminal status: drop without killing the Host WS.
      if (!identity) {
        dropReason = "remote_acp_event_attempt_not_writable";
        return;
      }
      const now = this.clock().toISOString();
      const stream = this.database
        .prepare("SELECT * FROM remote_acp_event_streams WHERE execution_attempt_id=?")
        .get(batch.executionAttemptId);
      if (!stream) {
        this.database
          .prepare(
            `INSERT INTO remote_acp_event_streams(
              execution_attempt_id,operation_id,dispatch_id,lease_id,host_id,acp_session_id,
              event_protocol_version,updated_at
            ) VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(
            batch.executionAttemptId,
            identity.operationId,
            batch.dispatchId,
            batch.leaseId,
            hostId,
            batch.acpSessionId,
            eventProtocolVersion,
            now
          );
      } else if (
        stream.operation_id !== identity.operationId ||
        stream.dispatch_id !== batch.dispatchId ||
        stream.host_id !== hostId ||
        stream.acp_session_id !== batch.acpSessionId ||
        Number(stream.event_protocol_version) !== eventProtocolVersion
      ) {
        throw new Error("remote_acp_event_stream_identity_conflict");
      } else if (stream.lease_id !== batch.leaseId) {
        this.database
          .prepare(
            `UPDATE remote_acp_event_streams SET lease_id=?,updated_at=?
             WHERE execution_attempt_id=? AND lease_id=?`
          )
          .run(batch.leaseId, now, batch.executionAttemptId, stream.lease_id);
      }

      const current = this.database
        .prepare("SELECT * FROM remote_acp_event_streams WHERE execution_attempt_id=?")
        .get(batch.executionAttemptId);
      const latestCursor = acpEventCursorSchema.parse(Number(current?.latest_cursor));
      const retainedFrom = z.number().int().positive().parse(current?.retained_from_cursor);
      for (const candidate of redactedEvents) {
        const candidateJson = canonicalizeJson(candidate);
        const exactExisting = this.database
          .prepare(
            "SELECT event_json FROM remote_acp_events WHERE execution_attempt_id=? AND cursor=?"
          )
          .get(batch.executionAttemptId, candidate.cursor);
        if (exactExisting?.event_json === candidateJson) continue;
        const event =
          eventProtocolVersion === 2
            ? this.normalizeUsageSnapshot(
                batch.executionAttemptId,
                candidate as RemoteRunnerEventV2,
                counterDelta
              )
            : candidate;
        if (event.cursor < retainedFrom) throw new Error("remote_acp_event_cursor_evicted");
        const eventJson = canonicalizeJson(event);
        const existing = this.database
          .prepare(
            "SELECT event_json FROM remote_acp_events WHERE execution_attempt_id=? AND cursor=?"
          )
          .get(batch.executionAttemptId, event.cursor);
        if (existing) {
          if (existing.event_json !== eventJson) {
            throw new Error("remote_acp_event_cursor_conflict");
          }
          continue;
        }
        const expectedCursor =
          Number(
            this.database
              .prepare(
                "SELECT COALESCE(MAX(cursor),0) AS cursor FROM remote_acp_events WHERE execution_attempt_id=?"
              )
              .get(batch.executionAttemptId)?.cursor ?? latestCursor
          ) + 1;
        if (event.cursor !== Math.max(latestCursor + 1, expectedCursor)) {
          throw new Error("remote_acp_event_cursor_gap");
        }
        const encodedBytes = Buffer.byteLength(eventJson, "utf8");
        if (encodedBytes > this.maxBytes) throw new Error("remote_acp_event_retention_exhausted");
        this.database
          .prepare(
            `INSERT INTO remote_acp_events(
              execution_attempt_id,cursor,event_json,encoded_bytes,received_at,event_version
            ) VALUES (?,?,?,?,?,?)`
          )
          .run(
            batch.executionAttemptId,
            event.cursor,
            eventJson,
            encodedBytes,
            now,
            eventProtocolVersion
          );
      }
      this.enforceRetention(batch.executionAttemptId);
      this.database
        .prepare(
          `UPDATE remote_acp_event_streams
           SET latest_cursor=MAX(latest_cursor,?),updated_at=? WHERE execution_attempt_id=?`
        )
        .run(batch.cursor, now, batch.executionAttemptId);
    });
    if (dropReason) {
      logAcpEventDropped({
        hostId,
        messageId,
        dispatchId: batch.dispatchId,
        leaseId: batch.leaseId,
        executionAttemptId: batch.executionAttemptId
      });
      return emptyDroppedReplay(batch.executionAttemptId, batch.afterCursor);
    }
    if (applied) {
      if (eventProtocolVersion === 2) this.counters.v2Accepted += 1;
      else this.counters.v1Accepted += 1;
      this.counters.usageSnapshotsAccepted += counterDelta.usageSnapshotsAccepted;
      this.counters.usageSnapshotRegressions += counterDelta.usageSnapshotRegressions;
    }
    // Idempotent retry: accept only when this batch's cursor was actually persisted.
    // Soft-dropped receipts leave no new events even if an earlier writable lease wrote a stream.
    if (!applied) {
      const persisted = this.database
        .prepare(
          "SELECT 1 AS present FROM remote_acp_events WHERE execution_attempt_id=? AND cursor=?"
        )
        .get(batch.executionAttemptId, batch.cursor);
      if (!persisted) {
        return emptyDroppedReplay(batch.executionAttemptId, batch.afterCursor);
      }
    }
    return {
      accepted: true,
      ...this.replay(batch.executionAttemptId, batch.afterCursor)
    };
  }

  replay(executionAttemptId: string, rawAfterCursor = 0): RemoteAcpEventReplay {
    const afterCursor = acpEventCursorSchema.parse(rawAfterCursor);
    const stream = this.database
      .prepare("SELECT * FROM remote_acp_event_streams WHERE execution_attempt_id=?")
      .get(executionAttemptId);
    if (!stream) throw new Error("remote_acp_event_stream_not_found");
    const highWatermark = acpEventCursorSchema.parse(Number(stream.latest_cursor));
    if (afterCursor > highWatermark) throw new Error("remote_acp_event_replay_cursor_ahead");
    const retainedFrom = z.number().int().positive().parse(stream.retained_from_cursor);
    if (Number(stream.event_protocol_version) === 1) this.counters.v1Degraded += 1;
    const effectiveAfterCursor = Math.max(afterCursor, retainedFrom - 1);
    const events = this.database
      .prepare(
        `SELECT event_json,event_version FROM remote_acp_events
         WHERE execution_attempt_id=? AND cursor>? ORDER BY cursor LIMIT ?`
      )
      .all(executionAttemptId, effectiveAfterCursor, ACP_EVENT_BATCH_MAX_COUNT)
      .map((row) =>
        Number(row.event_version) === 2
          ? remoteRunnerEventV2Schema.parse(JSON.parse(String(row.event_json)))
          : normalizedAcpEventSchema.parse(JSON.parse(String(row.event_json)))
      );
    const cursor = events.at(-1)?.cursor ?? effectiveAfterCursor;
    return {
      executionAttemptId,
      afterCursor,
      cursor,
      highWatermark,
      hasMore: cursor < highWatermark,
      events,
      eventProtocolVersion: Number(stream.event_protocol_version) === 2 ? 2 : 1,
      diagnostics: [
        ...(afterCursor < retainedFrom - 1
          ? [
              {
                code: "remote_acp_event_retention_gap" as const,
                droppedThroughCursor: retainedFrom - 1
              }
            ]
          : []),
        ...(Number(stream.event_protocol_version) === 1
          ? [{ code: "remote_acp_event_contract_degraded" as const }]
          : [])
      ]
    };
  }

  /** Replay a recognized operation before or after its first Host event batch arrives. */
  replayAvailable(executionAttemptId: string, rawAfterCursor = 0): RemoteAcpEventReplay {
    const afterCursor = acpEventCursorSchema.parse(rawAfterCursor);
    if (!this.hasStream(executionAttemptId)) {
      if (afterCursor > 0) throw new Error("remote_acp_event_replay_cursor_ahead");
      return {
        executionAttemptId,
        afterCursor,
        cursor: 0,
        highWatermark: 0,
        hasMore: false,
        eventProtocolVersion: 1,
        events: [],
        diagnostics: []
      };
    }
    return this.replay(executionAttemptId, afterCursor);
  }

  hasStream(executionAttemptId: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 AS present FROM remote_acp_event_streams WHERE execution_attempt_id=?")
        .get(executionAttemptId)?.present
    );
  }

  readCompletionTranscript(executionAttemptId: string): {
    sessionId: string;
    events: Array<{ timestamp: string; event: NormalizedAcpEvent | RemoteRunnerEventV2 }>;
  } | null {
    const stream = this.database
      .prepare("SELECT * FROM remote_acp_event_streams WHERE execution_attempt_id=?")
      .get(executionAttemptId);
    if (!stream) return null;
    if (Number(stream.dropped_count) > 0) {
      throw new Error("remote_acp_event_transcript_truncated");
    }
    return {
      sessionId: String(stream.acp_session_id),
      events: this.database
        .prepare(
          `SELECT event_json,received_at,event_version FROM remote_acp_events
           WHERE execution_attempt_id=? ORDER BY cursor`
        )
        .all(executionAttemptId)
        .map((row) => {
          const event =
            Number(row.event_version) === 2
              ? remoteRunnerEventV2Schema.parse(JSON.parse(String(row.event_json)))
              : normalizedAcpEventSchema.parse(JSON.parse(String(row.event_json)));
          return {
            timestamp:
              "timestamp" in event ? event.timestamp : z.string().datetime().parse(row.received_at),
            event
          };
        })
    };
  }

  private normalizeUsageSnapshot(
    executionAttemptId: string,
    event: RemoteRunnerEventV2,
    counterDelta: RemoteAcpCounterDelta
  ): RemoteRunnerEventV2 {
    if (
      event.fragment.kind !== "engine_evidence" ||
      event.fragment.evidence.kind !== "usage_snapshot"
    ) {
      return event;
    }
    const stream = this.database
      .prepare(
        `SELECT usage_source_sequence,usage_snapshot_json FROM remote_acp_event_streams
         WHERE execution_attempt_id=?`
      )
      .get(executionAttemptId);
    const priorSequence =
      stream?.usage_source_sequence == null ? null : Number(stream.usage_source_sequence);
    const prior = stream?.usage_snapshot_json
      ? (JSON.parse(String(stream.usage_snapshot_json)) as EngineUsageSnapshotLeaf)
      : null;
    const usage = event.fragment.evidence.usage;
    const numericKeys = [
      "totalTokens",
      "inputTokens",
      "outputTokens",
      "thoughtTokens",
      "cachedReadTokens",
      "cachedWriteTokens"
    ] as const;
    const regressed =
      (priorSequence !== null && event.sourceSequence <= priorSequence) ||
      (prior !== null &&
        numericKeys.some(
          (key) => usage[key] !== null && prior[key] !== null && usage[key] < prior[key]
        ));
    if (regressed) {
      counterDelta.usageSnapshotRegressions += 1;
      return remoteRunnerEventV2Schema.parse({
        ...event,
        fragment: {
          kind: "runner_body",
          body: {
            kind: "diagnostic",
            code: "remote_usage_snapshot_regressed",
            message: "Remote cumulative usage snapshot regressed and was ignored."
          }
        }
      });
    }
    this.database
      .prepare(
        `UPDATE remote_acp_event_streams
         SET usage_source_sequence=?,usage_snapshot_json=? WHERE execution_attempt_id=?`
      )
      .run(event.sourceSequence, canonicalizeJson(usage), executionAttemptId);
    counterDelta.usageSnapshotsAccepted += 1;
    return event;
  }

  private findWritableAttempt(input: {
    hostId: string;
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
  }): { operationId: string } | undefined {
    const row = this.database
      .prepare(
        `SELECT a.operation_id,a.dispatch_id,a.host_id,a.lease_id,a.status AS attempt_status,
           r.status AS reservation_status,d.status AS dispatch_status,
           d.host_id AS dispatch_host_id,d.lease_id AS dispatch_lease_id,
           d.execution_attempt_id AS dispatch_attempt_id
         FROM remote_execution_attempts a
         JOIN host_capacity_reservations r ON r.lease_id=a.lease_id
         JOIN dispatches d ON d.id=a.dispatch_id
         WHERE a.execution_attempt_id=?`
      )
      .get(input.executionAttemptId);
    if (
      !row ||
      row.operation_id === undefined ||
      row.dispatch_id !== input.dispatchId ||
      row.host_id !== input.hostId ||
      row.lease_id !== input.leaseId ||
      row.reservation_status !== "active" ||
      row.dispatch_host_id !== input.hostId ||
      row.dispatch_lease_id !== input.leaseId ||
      row.dispatch_attempt_id !== input.executionAttemptId ||
      !["activated", "running"].includes(String(row.attempt_status)) ||
      !["leased", "running", "cancelling"].includes(String(row.dispatch_status))
    ) {
      return undefined;
    }
    return { operationId: String(row.operation_id) };
  }

  private enforceRetention(executionAttemptId: string): void {
    while (true) {
      const totals = this.database
        .prepare(
          `SELECT COUNT(*) AS count,COALESCE(SUM(encoded_bytes),0) AS bytes
           FROM remote_acp_events WHERE execution_attempt_id=?`
        )
        .get(executionAttemptId);
      const count = Number(totals?.count ?? 0);
      const bytes = Number(totals?.bytes ?? 0);
      if (count <= this.maxEvents && bytes <= this.maxBytes) {
        const first = this.database
          .prepare(
            "SELECT MIN(cursor) AS cursor FROM remote_acp_events WHERE execution_attempt_id=?"
          )
          .get(executionAttemptId);
        this.database
          .prepare(
            `UPDATE remote_acp_event_streams SET retained_from_cursor=?,retained_count=?,
              retained_bytes=? WHERE execution_attempt_id=?`
          )
          .run(Number(first?.cursor ?? 1), count, bytes, executionAttemptId);
        return;
      }
      const oldest = this.database
        .prepare(
          `SELECT cursor FROM remote_acp_events
           WHERE execution_attempt_id=? ORDER BY cursor LIMIT 1`
        )
        .get(executionAttemptId);
      if (!oldest) throw new Error("remote_acp_event_retention_inconsistent");
      this.database
        .prepare("DELETE FROM remote_acp_events WHERE execution_attempt_id=? AND cursor=?")
        .run(executionAttemptId, oldest.cursor);
      this.database
        .prepare(
          `UPDATE remote_acp_event_streams SET dropped_count=dropped_count+1
           WHERE execution_attempt_id=?`
        )
        .run(executionAttemptId);
    }
  }
}

import { rm } from "node:fs/promises";
import { exampleRunnerBodyFragments } from "@planweave-ai/agent-host-protocol";
import { remoteAcpEventBody } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { operatorEventReplaySchema } from "../operatorDtos.js";
import { RemoteAcpEventRepository } from "../remoteAcpEvents.js";
import {
  createRemoteAcpEventV2Fixture,
  remoteAcpV2Batch
} from "./support/remoteAcpEventV2Fixture.js";

const fixtures: Awaited<ReturnType<typeof createRemoteAcpEventV2Fixture>>[] = [];

afterEach(async () => {
  const completed = fixtures.splice(0);
  for (const fixture of completed) fixture.server.close();
  await Promise.all(
    completed.map((fixture) => rm(fixture.directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const fixture = await createRemoteAcpEventV2Fixture();
  fixtures.push(fixture);
  return fixture;
}

function event(cursor: number, body: unknown, sourceSequence = cursor) {
  return {
    eventVersion: 2 as const,
    cursor,
    sourceSequence,
    timestamp: new Date(Date.UTC(2030, 0, 1, 0, 0, cursor)).toISOString(),
    fragment: { kind: "runner_body" as const, body }
  };
}

function usageEvent(cursor: number, totalTokens: number) {
  return {
    eventVersion: 2 as const,
    cursor,
    sourceSequence: cursor,
    timestamp: new Date(Date.UTC(2030, 0, 1, 0, 0, cursor)).toISOString(),
    fragment: {
      kind: "engine_evidence" as const,
      evidence: {
        kind: "usage_snapshot" as const,
        usage: {
          semantics: "cumulative_session_total" as const,
          totalTokens,
          inputTokens: totalTokens,
          outputTokens: 0,
          thoughtTokens: null,
          cachedReadTokens: null,
          cachedWriteTokens: null
        }
      }
    }
  };
}

describe("remote ACP events v2", () => {
  it("rejects operator replay payloads that mix event protocol versions", () => {
    const base = {
      executionAttemptId: "attempt-1",
      afterCursor: 0,
      cursor: 1,
      highWatermark: 1,
      hasMore: false,
      diagnostics: []
    };
    const v1Event = { cursor: 1, kind: "agent_message", text: "legacy" };
    const v2Event = event(1, exampleRunnerBodyFragments[0]);

    expect(
      operatorEventReplaySchema.safeParse({ ...base, eventProtocolVersion: 1, events: [v2Event] })
        .success
    ).toBe(false);
    expect(
      operatorEventReplaySchema.safeParse({ ...base, eventProtocolVersion: 2, events: [v1Event] })
        .success
    ).toBe(false);
  });

  it("replays every shared Runner body without changing its Runtime projection", async () => {
    const fixture = await setup();
    const repository = new RemoteAcpEventRepository(fixture.server.database, {
      clock: fixture.clock
    });
    const events = exampleRunnerBodyFragments.map((body, index) => event(index + 1, body));
    repository.ingest(fixture.host.id, "matrix-v2", remoteAcpV2Batch(fixture, events));
    const replay = repository.replay(fixture.operation.executionAttemptId);
    expect(replay.eventProtocolVersion).toBe(2);
    expect(replay.events.map((candidate) => remoteAcpEventBody(candidate, new Set()))).toEqual(
      exampleRunnerBodyFragments
    );
  });

  it("keeps duplicate cursors idempotent, rejects gaps, and isolates unknown attempts", async () => {
    const fixture = await setup();
    const repository = new RemoteAcpEventRepository(fixture.server.database, {
      clock: fixture.clock
    });
    const first = remoteAcpV2Batch(fixture, [event(1, exampleRunnerBodyFragments[0])]);
    expect(repository.ingest(fixture.host.id, "duplicate-v2-1", first).accepted).toBe(true);
    expect(repository.ingest(fixture.host.id, "duplicate-v2-2", first).accepted).toBe(true);
    expect(() =>
      repository.ingest(
        fixture.host.id,
        "gap-v2",
        remoteAcpV2Batch(fixture, [event(3, exampleRunnerBodyFragments[0])], 2)
      )
    ).toThrowError("remote_acp_event_cursor_gap");
    expect(
      repository.ingest(fixture.host.id, "foreign-attempt-v2", {
        ...remoteAcpV2Batch(fixture, [event(1, exampleRunnerBodyFragments[0])]),
        executionAttemptId: "foreign-attempt"
      })
    ).toMatchObject({ accepted: false, dropReason: "remote_acp_event_attempt_not_writable" });
    expect(repository.replay(fixture.operation.executionAttemptId).events).toHaveLength(1);
  });

  it("rejects missing and explicit v1 live batches without advancing v1 metrics", async () => {
    const fixture = await setup();
    const repository = new RemoteAcpEventRepository(fixture.server.database, {
      clock: fixture.clock
    });
    const legacy = {
      type: "acp.events",
      dispatchId: fixture.operation.dispatchId,
      leaseId: fixture.reservation.leaseId,
      executionAttemptId: fixture.operation.executionAttemptId,
      acpSessionId: "session-v1",
      afterCursor: 0,
      cursor: 1,
      events: [{ cursor: 1, kind: "agent_message", text: "legacy" }]
    };

    expect(() => repository.ingest(fixture.host.id, "missing-version", legacy)).toThrow();
    expect(() =>
      repository.ingest(fixture.host.id, "explicit-v1", {
        ...legacy,
        eventProtocolVersion: 1
      })
    ).toThrow();
    expect(repository.metrics()).toMatchObject({ v1Accepted: 0, v2Accepted: 0 });
    expect(repository.hasStream(fixture.operation.executionAttemptId)).toBe(false);
  });

  it("reports v2 retention loss and both v1 degraded diagnostics", async () => {
    const fixture = await setup();
    const v2 = new RemoteAcpEventRepository(fixture.server.database, {
      maxEvents: 1,
      clock: fixture.clock
    });
    v2.ingest(
      fixture.host.id,
      "retention-v2",
      remoteAcpV2Batch(fixture, [
        event(1, exampleRunnerBodyFragments[0]),
        event(2, exampleRunnerBodyFragments[1])
      ])
    );
    expect(v2.replay(fixture.operation.executionAttemptId)).toMatchObject({
      eventProtocolVersion: 2,
      diagnostics: [{ code: "remote_acp_event_retention_gap", droppedThroughCursor: 1 }]
    });

    fixture.server.database
      .prepare("DELETE FROM remote_acp_events WHERE execution_attempt_id=?")
      .run(fixture.operation.executionAttemptId);
    fixture.server.database
      .prepare("DELETE FROM remote_acp_event_streams WHERE execution_attempt_id=?")
      .run(fixture.operation.executionAttemptId);
    const historicalEvent = JSON.stringify({
      cursor: 2,
      kind: "agent_message",
      text: "second"
    });
    fixture.server.database
      .prepare(
        `INSERT INTO remote_acp_event_streams(
          execution_attempt_id,operation_id,dispatch_id,lease_id,host_id,acp_session_id,
          latest_cursor,retained_from_cursor,retained_count,retained_bytes,dropped_count,
          event_protocol_version,updated_at
        ) VALUES (?,?,?,?,?,?,2,2,1,?,1,1,?)`
      )
      .run(
        fixture.operation.executionAttemptId,
        fixture.operation.id,
        fixture.operation.dispatchId,
        fixture.reservation.leaseId,
        fixture.host.id,
        "session-v1",
        Buffer.byteLength(historicalEvent),
        fixture.clock().toISOString()
      );
    fixture.server.database
      .prepare(
        `INSERT INTO remote_acp_events(
          execution_attempt_id,cursor,event_json,encoded_bytes,received_at
        ) VALUES (?,2,?,?,?)`
      )
      .run(
        fixture.operation.executionAttemptId,
        historicalEvent,
        Buffer.byteLength(historicalEvent),
        fixture.clock().toISOString()
      );
    const v1 = new RemoteAcpEventRepository(fixture.server.database, {
      maxEvents: 1,
      clock: fixture.clock
    });
    expect(v1.replay(fixture.operation.executionAttemptId).diagnostics).toEqual([
      { code: "remote_acp_event_retention_gap", droppedThroughCursor: 1 },
      { code: "remote_acp_event_contract_degraded" }
    ]);
  });

  it("applies usage counters only after the ingest transaction commits", async () => {
    const fixture = await setup();
    const repository = new RemoteAcpEventRepository(fixture.server.database, {
      maxBytes: 500,
      clock: fixture.clock
    });
    expect(() =>
      repository.ingest(
        fixture.host.id,
        "rollback-v2",
        remoteAcpV2Batch(fixture, [
          usageEvent(1, 10),
          event(2, {
            kind: "output",
            stream: "stdout",
            content: "x".repeat(450),
            redaction: { classes: [], replaced: 0 }
          })
        ])
      )
    ).toThrowError("remote_acp_event_retention_exhausted");
    expect(repository.metrics()).toEqual({
      v1Accepted: 0,
      v2Accepted: 0,
      v1Degraded: 0,
      usageSnapshotsAccepted: 0,
      usageSnapshotRegressions: 0
    });
    expect(repository.hasStream(fixture.operation.executionAttemptId)).toBe(false);
  });

  it("reconciles migration 65 when its record is lost after columns were added", async () => {
    const fixture = await setup();
    fixture.server.database.prepare("DELETE FROM schema_migrations WHERE version=65").run();
    expect(() => applyMigrations(fixture.server.database)).not.toThrow();
    expect(
      fixture.server.database
        .prepare("SELECT 1 AS present FROM schema_migrations WHERE version=65")
        .get()
    ).toEqual({ present: 1 });
  });
});

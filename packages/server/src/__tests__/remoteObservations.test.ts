import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostReservationRepository } from "../hostReservations.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteAcpEventRepository } from "../remoteAcpEvents.js";
import { RemoteInteractionService, type RemoteInteractionIdentity } from "../remoteInteractions.js";
import { RemoteOperationRepository } from "../remoteOperations.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-observation-"));
  directories.push(directory);
  let now = new Date("2030-01-01T00:00:00.000Z");
  const clock = () => now;
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const hosts = new AgentHostRepository(server.database, clock);
  const host = hosts.register("Observation Host").host;
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject("project-observation");
  hosts.bindToWorkspace(host.id, workspaceId);
  hosts.reportOnline(host.id, ["linux", "acp.codex", "acp.session.load"], 2, {
    workspaceMappings: [{ workspaceId, status: "ready" }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Test Agent",
        status: "ready",
        capabilities: ["linux", "acp.codex", "acp.session.load"]
      }
    ]
  });
  const operations = new RemoteOperationRepository(server.database, clock);
  let operation = operations.markClaimed(
    operations.create({
      workspaceId,
      projectId: "project-observation",
      canvasId: "default",
      blockRef: "RC-003#B-002",
      ownershipGeneration: "generation-1",
      idempotencyKey: "observation-1",
      sourceFingerprint: "fingerprint-1",
      requiredCapabilities: ["acp.codex"]
    }).id
  );
  const reservations = new HostReservationRepository(server.database, {
    leaseDurationMs: 60_000,
    hostOfflineAfterMs: 60_000,
    clock
  });
  const reservation = reservations.reserve(operation.id, {
    agentId: "codex",
    agentProfileId: "codex-acp"
  });
  operation = operations.getRequired(operation.id);
  server.database
    .prepare(
      `INSERT INTO dispatches(
        id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
        lease_id,execution_attempt_id,lease_expires_at,created_at
      ) VALUES (?,?,?,?,?,?,'running',?,?,?,?)`
    )
    .run(
      operation.dispatchId,
      operation.workspaceId,
      operation.projectId,
      operation.blockRef,
      host.id,
      JSON.stringify(operation.requiredCapabilities),
      reservation.leaseId,
      operation.executionAttemptId,
      reservation.leaseExpiresAt,
      operation.createdAt
    );
  let attempt = reservations.transition({
    leaseId: reservation.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: operation.attempt.stateVersion,
    status: "activated"
  });
  attempt = reservations.transition({
    leaseId: reservation.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: attempt.attempt.stateVersion,
    status: "running"
  });
  operation = operations.getRequired(operation.id);
  return {
    server,
    host,
    operations,
    reservations,
    reservation,
    operation,
    clock,
    setNow: (value: string) => {
      now = new Date(value);
    }
  };
}

function eventBatch(
  fixture: Awaited<ReturnType<typeof setup>>,
  input: { leaseId?: string; afterCursor: number; cursor: number; text: string }
) {
  return {
    type: "acp.events" as const,
    dispatchId: fixture.operation.dispatchId,
    leaseId: input.leaseId ?? fixture.reservation.leaseId,
    executionAttemptId: fixture.operation.executionAttemptId,
    acpSessionId: "acp-session-1",
    afterCursor: input.afterCursor,
    cursor: input.cursor,
    events: [{ cursor: input.cursor, kind: "agent_message" as const, text: input.text }]
  };
}

function interactionRequest(
  fixture: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<{
    actionId: string;
    acpSessionId: string;
    expiresAt: string;
    description: string;
  }> = {}
) {
  return {
    type: "interaction.permission_requested" as const,
    dispatchId: fixture.operation.dispatchId,
    leaseId: fixture.reservation.leaseId,
    executionAttemptId: fixture.operation.executionAttemptId,
    actionId: overrides.actionId ?? "permission-1",
    acpSessionId: overrides.acpSessionId ?? "acp-session-1",
    expiresAt: overrides.expiresAt ?? "2030-01-01T00:01:00.000Z",
    title: "Permission",
    description: overrides.description ?? "Allow this operation?"
  };
}

function interactionIdentity(
  fixture: Awaited<ReturnType<typeof setup>>,
  request: ReturnType<typeof interactionRequest>
): RemoteInteractionIdentity {
  return {
    hostId: fixture.host.id,
    dispatchId: request.dispatchId,
    executionAttemptId: request.executionAttemptId,
    acpSessionId: request.acpSessionId,
    actionId: request.actionId
  };
}

describe("remote ACP observations", () => {
  it("persists strict v2 fragments and replaces regressed cumulative usage with a diagnostic", async () => {
    const fixture = await setup();
    const repository = new RemoteAcpEventRepository(fixture.server.database, {
      clock: fixture.clock
    });
    const common = {
      type: "acp.events" as const,
      eventProtocolVersion: 2 as const,
      dispatchId: fixture.operation.dispatchId,
      leaseId: fixture.reservation.leaseId,
      executionAttemptId: fixture.operation.executionAttemptId,
      acpSessionId: "acp-session-1"
    };
    const usage = (cursor: number, sourceSequence: number, totalTokens: number) => ({
      eventVersion: 2 as const,
      cursor,
      sourceSequence,
      timestamp: `2030-01-01T00:00:0${cursor}.000Z`,
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
    });
    const firstBatch = {
      ...common,
      afterCursor: 0,
      cursor: 1,
      events: [usage(1, 10, 10)]
    };
    repository.ingest(fixture.host.id, "v2-1", firstBatch);
    repository.ingest(fixture.host.id, "v2-1-retry", firstBatch);
    repository.ingest(fixture.host.id, "v2-2", {
      ...common,
      afterCursor: 1,
      cursor: 2,
      events: [usage(2, 11, 8)]
    });

    expect(repository.replay(fixture.operation.executionAttemptId)).toMatchObject({
      eventProtocolVersion: 2,
      events: [
        { fragment: { evidence: { kind: "usage_snapshot" } } },
        { fragment: { body: { code: "remote_usage_snapshot_regressed" } } }
      ]
    });
    expect(repository.metrics()).toMatchObject({
      v2Accepted: 3,
      usageSnapshotsAccepted: 1,
      usageSnapshotRegressions: 1
    });
  });

  it("replays monotonic redacted events and fails closed on conflict, gap, and retention loss", async () => {
    const fixture = await setup();
    const events = new RemoteAcpEventRepository(fixture.server.database, {
      maxEvents: 2,
      maxBytes: 4_096,
      clock: fixture.clock
    });
    events.ingest(
      fixture.host.id,
      "event-1",
      eventBatch(fixture, { afterCursor: 0, cursor: 1, text: "first" })
    );
    events.ingest(
      fixture.host.id,
      "event-2",
      eventBatch(fixture, { afterCursor: 1, cursor: 2, text: "token=secret-value" })
    );
    events.ingest(
      fixture.host.id,
      "event-3",
      eventBatch(fixture, { afterCursor: 2, cursor: 3, text: "third" })
    );

    expect(events.replay(fixture.operation.executionAttemptId, 0)).toMatchObject({
      cursor: 3,
      highWatermark: 3,
      hasMore: false,
      events: [{ cursor: 2 }, { cursor: 3 }],
      diagnostics: [
        { code: "remote_acp_event_retention_gap", droppedThroughCursor: 1 },
        { code: "remote_acp_event_contract_degraded" }
      ]
    });
    const persisted = fixture.server.database
      .prepare(
        `SELECT group_concat(event_json) AS event_json FROM remote_acp_events
         WHERE execution_attempt_id=?`
      )
      .get(fixture.operation.executionAttemptId);
    expect(String(persisted?.event_json)).not.toContain("secret-value");
    expect(() =>
      events.ingest(
        fixture.host.id,
        "event-conflict",
        eventBatch(fixture, { afterCursor: 2, cursor: 3, text: "changed" })
      )
    ).toThrowError("remote_acp_event_cursor_conflict");
    expect(() =>
      events.ingest(
        fixture.host.id,
        "event-gap",
        eventBatch(fixture, { afterCursor: 4, cursor: 5, text: "gap" })
      )
    ).toThrowError("remote_acp_event_cursor_gap");
  });

  it("advances replay cursors only through returned pages", async () => {
    const fixture = await setup();
    const repository = new RemoteAcpEventRepository(fixture.server.database, {
      maxEvents: 256,
      clock: fixture.clock
    });
    repository.ingest(fixture.host.id, "page-1", {
      type: "acp.events",
      dispatchId: fixture.operation.dispatchId,
      leaseId: fixture.reservation.leaseId,
      executionAttemptId: fixture.operation.executionAttemptId,
      acpSessionId: "acp-session-1",
      afterCursor: 0,
      cursor: 128,
      events: Array.from({ length: 128 }, (_, index) => ({
        cursor: index + 1,
        kind: "agent_message" as const,
        text: `event-${index + 1}`
      }))
    });
    repository.ingest(fixture.host.id, "page-2", {
      type: "acp.events",
      dispatchId: fixture.operation.dispatchId,
      leaseId: fixture.reservation.leaseId,
      executionAttemptId: fixture.operation.executionAttemptId,
      acpSessionId: "acp-session-1",
      afterCursor: 128,
      cursor: 130,
      events: [129, 130].map((cursor) => ({
        cursor,
        kind: "agent_message" as const,
        text: `event-${cursor}`
      }))
    });

    expect(repository.replay(fixture.operation.executionAttemptId, 0)).toMatchObject({
      cursor: 128,
      highWatermark: 130,
      hasMore: true
    });
    expect(repository.replay(fixture.operation.executionAttemptId, 128)).toMatchObject({
      cursor: 130,
      highWatermark: 130,
      hasMore: false,
      events: [{ cursor: 129 }, { cursor: 130 }]
    });
  });

  it("continues one attempt/session cursor across a fresh resume lease and rejects the old lease", async () => {
    const fixture = await setup();
    const events = new RemoteAcpEventRepository(fixture.server.database, { clock: fixture.clock });
    events.ingest(
      fixture.host.id,
      "event-before-resume",
      eventBatch(fixture, { afterCursor: 0, cursor: 1, text: "before" })
    );
    fixture.reservations.release({
      leaseId: fixture.reservation.leaseId,
      fencingToken: fixture.reservation.fencingToken,
      expectedVersion: fixture.reservation.version,
      reason: "expired"
    });
    fixture.server.database
      .prepare("UPDATE dispatches SET status='interrupted' WHERE id=?")
      .run(fixture.operation.dispatchId);
    const interrupted = fixture.operations.getRequired(fixture.operation.id);
    const freshLeaseId = "lease-resumed-1";
    const resumed = fixture.reservations.resumeSameAttempt({
      priorLeaseId: fixture.reservation.leaseId,
      leaseId: freshLeaseId,
      leaseExpiresAt: "2030-01-01T00:01:00.000Z",
      expectedAttemptVersion: interrupted.attempt.stateVersion
    });
    fixture.server.database
      .prepare(`UPDATE dispatches SET status='running',lease_id=?,lease_expires_at=? WHERE id=?`)
      .run(freshLeaseId, resumed.leaseExpiresAt, fixture.operation.dispatchId);
    fixture.reservations.transition({
      leaseId: freshLeaseId,
      fencingToken: resumed.fencingToken,
      expectedAttemptVersion: fixture.operations.getRequired(fixture.operation.id).attempt
        .stateVersion,
      status: "running"
    });

    expect(
      events.ingest(
        fixture.host.id,
        "event-after-resume",
        eventBatch(fixture, { leaseId: freshLeaseId, afterCursor: 1, cursor: 2, text: "after" })
      )
    ).toMatchObject({
      accepted: true,
      events: [expect.objectContaining({ cursor: 2 })]
    });
    // Stale lease batches are soft-dropped (receipt recorded, no write, no throw) so Host WS stays up.
    expect(
      events.ingest(
        fixture.host.id,
        "event-old-lease",
        eventBatch(fixture, {
          leaseId: fixture.reservation.leaseId,
          afterCursor: 2,
          cursor: 3,
          text: "late"
        })
      )
    ).toMatchObject({
      accepted: false,
      dropReason: "remote_acp_event_attempt_not_writable",
      events: []
    });
    expect(events.replay(fixture.operation.executionAttemptId, 0).events).toEqual([
      expect.objectContaining({ cursor: 1 }),
      expect.objectContaining({ cursor: 2 })
    ]);
    // Idempotent retry of the soft-dropped message stays a drop.
    expect(
      events.ingest(
        fixture.host.id,
        "event-old-lease",
        eventBatch(fixture, {
          leaseId: fixture.reservation.leaseId,
          afterCursor: 2,
          cursor: 3,
          text: "late"
        })
      )
    ).toMatchObject({ accepted: false, dropReason: "remote_acp_event_attempt_not_writable" });
  });
});

describe("remote interaction settlement", () => {
  it("redacts requests and authorizes one exact idempotent settlement", async () => {
    const fixture = await setup();
    const interactions = new RemoteInteractionService(fixture.server.database, {
      clock: fixture.clock,
      authorization: { canRespond: ({ responderId }) => responderId === "member-1" }
    });
    const request = interactionRequest(fixture, { description: "token=secret-value" });
    const recorded = interactions.recordRequest(fixture.host.id, "request-1", request);
    expect(recorded.request).toMatchObject({ description: "[REDACTED:CREDENTIAL]" });
    const settlement = {
      type: "interaction.permission_response" as const,
      dispatchId: request.dispatchId,
      leaseId: request.leaseId,
      executionAttemptId: request.executionAttemptId,
      actionId: request.actionId,
      acpSessionId: request.acpSessionId,
      decision: "deny" as const
    };
    expect(() =>
      interactions.settle({ hostId: fixture.host.id, responderId: "foreign", settlement })
    ).toThrowError("remote_interaction_responder_unauthorized");
    expect(
      interactions.settle({ hostId: fixture.host.id, responderId: "member-1", settlement })
    ).toMatchObject({ status: "settled", settledBy: "member-1", settlement });
    fixture.reservations.release({
      leaseId: fixture.reservation.leaseId,
      fencingToken: fixture.reservation.fencingToken,
      expectedVersion: fixture.reservation.version,
      reason: "expired"
    });
    expect(
      interactions.settle({ hostId: fixture.host.id, responderId: "member-1", settlement })
    ).toMatchObject({ status: "settled" });
    expect(() =>
      interactions.settle({
        hostId: fixture.host.id,
        responderId: "member-1",
        settlement: { ...settlement, decision: "allow_once" }
      })
    ).toThrowError("remote_interaction_settlement_conflict");
  });

  it("scopes reused action ids by session and rejects settlement after lease fencing", async () => {
    const fixture = await setup();
    const interactions = new RemoteInteractionService(fixture.server.database, {
      clock: fixture.clock,
      authorization: { canRespond: () => true }
    });
    const first = interactionRequest(fixture, { actionId: "shared", acpSessionId: "session-a" });
    const second = interactionRequest(fixture, { actionId: "shared", acpSessionId: "session-b" });
    interactions.recordRequest(fixture.host.id, "request-a", first);
    interactions.recordRequest(fixture.host.id, "request-b", second);
    expect(interactions.getRequired(interactionIdentity(fixture, first)).request.acpSessionId).toBe(
      "session-a"
    );
    expect(
      interactions.getRequired(interactionIdentity(fixture, second)).request.acpSessionId
    ).toBe("session-b");
    fixture.reservations.release({
      leaseId: fixture.reservation.leaseId,
      fencingToken: fixture.reservation.fencingToken,
      expectedVersion: fixture.reservation.version,
      reason: "expired"
    });
    expect(() =>
      interactions.settle({
        hostId: fixture.host.id,
        responderId: "member-1",
        settlement: {
          type: "interaction.permission_response",
          dispatchId: first.dispatchId,
          leaseId: first.leaseId,
          executionAttemptId: first.executionAttemptId,
          actionId: first.actionId,
          acpSessionId: first.acpSessionId,
          decision: "deny"
        }
      })
    ).toThrowError("remote_interaction_attempt_not_active");
  });

  it("durably cancels expired elicitation and replays the mailbox command after restart", async () => {
    const fixture = await setup();
    const request = {
      type: "interaction.elicitation_requested" as const,
      dispatchId: fixture.operation.dispatchId,
      leaseId: fixture.reservation.leaseId,
      executionAttemptId: fixture.operation.executionAttemptId,
      actionId: "elicitation-expiry",
      acpSessionId: "acp-session-1",
      expiresAt: "2030-01-01T00:00:30.000Z",
      prompt: "Choose safely",
      options: ["one"]
    };
    const interactions = new RemoteInteractionService(fixture.server.database, {
      clock: fixture.clock,
      authorization: { canRespond: () => true }
    });
    interactions.recordRequest(fixture.host.id, "elicitation-request", request);
    fixture.setNow("2030-01-01T00:00:31.000Z");
    expect(interactions.expireDue()).toEqual([expect.objectContaining({ status: "expired" })]);
    const restarted = new RemoteInteractionService(fixture.server.database, {
      clock: fixture.clock,
      authorization: { canRespond: () => true }
    });
    const identity = interactionIdentity(fixture, {
      ...interactionRequest(fixture),
      ...request,
      description: ""
    });
    expect(restarted.getRequired(identity)).toMatchObject({ status: "expired" });
    expect(
      fixture.server.database
        .prepare(
          "SELECT command_json FROM mailbox_messages WHERE message_id LIKE 'interaction-expiry-%'"
        )
        .get()?.command_json
    ).toContain('"outcome":"cancelled"');
  });
});

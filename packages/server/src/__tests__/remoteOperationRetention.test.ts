import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { ArtifactAuthorizationRepository } from "../artifactAuthorization.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import { RemoteOperationRetention } from "../remoteOperationRetention.js";
import { RemoteAcpEventRepository } from "../remoteAcpEvents.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const oldTime = "2029-01-01T00:00:00.000Z";
const maintenanceTime = new Date("2030-01-01T00:00:00.000Z");

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-retention-"));
  directories.push(directory);
  const databasePath = join(directory, "server.sqlite");
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath,
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const host = new AgentHostRepository(server.database, () => new Date(oldTime)).register(
    "Retention Host"
  ).host;
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject("project-retention");
  return { server, databasePath, directory, hostId: host.id, workspaceId };
}

function seedTerminalOperation(
  fixture: Awaited<ReturnType<typeof setup>>,
  suffix: string,
  state: "completed" | "failed" | "cancelled" = "completed",
  canvasId = "default"
) {
  const operations = new RemoteOperationRepository(
    fixture.server.database,
    () => new Date(oldTime)
  );
  const created = operations.create({
    workspaceId: fixture.workspaceId,
    projectId: "project-retention",
    canvasId,
    blockRef: `T-001#B-${suffix}`,
    ownershipGeneration: `generation-${suffix}`,
    idempotencyKey: `retention-${suffix}`,
    sourceFingerprint: `fingerprint-${suffix}`,
    requiredCapabilities: ["acp.codex"]
  });
  const attemptStatus = state;
  const dispatchStatus = state;
  fixture.server.database
    .prepare(
      `UPDATE remote_execution_attempts
       SET status=?,host_id=?,lease_id=?,lease_fencing_token=1,lease_expires_at=?,
         state_version=1,updated_at=?,terminal_at=? WHERE execution_attempt_id=?`
    )
    .run(
      attemptStatus,
      fixture.hostId,
      `lease-${suffix}`,
      oldTime,
      oldTime,
      oldTime,
      created.executionAttemptId
    );
  fixture.server.database
    .prepare("UPDATE remote_operations SET state=?,updated_at=?,terminal_at=? WHERE id=?")
    .run(state, oldTime, oldTime, created.id);
  fixture.server.database
    .prepare(
      `INSERT INTO dispatches(
        id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
        lease_id,execution_attempt_id,lease_expires_at,created_at,finished_at,result_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      created.dispatchId,
      fixture.workspaceId,
      created.projectId,
      created.blockRef,
      fixture.hostId,
      JSON.stringify(created.requiredCapabilities),
      dispatchStatus,
      `lease-${suffix}`,
      created.executionAttemptId,
      oldTime,
      oldTime,
      oldTime,
      state === "completed"
        ? JSON.stringify({
            summary: "retained result",
            reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
            artifactRefs: []
          })
        : null
    );
  return operations.getRequired(created.id);
}

function count(server: PlanweaveServer, table: string, column: string, value: string): number {
  return Number(
    server.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(value)
      ?.count ?? 0
  );
}

describe("remote operation retention", () => {
  it("keeps the per-scope recent and age windows and compacts only bounded older terminal rows", async () => {
    const fixture = await setup();
    const first = seedTerminalOperation(fixture, "001");
    const second = seedTerminalOperation(fixture, "002");
    const third = seedTerminalOperation(fixture, "003");
    fixture.server.database
      .prepare("UPDATE remote_operations SET terminal_at=? WHERE id=?")
      .run("2029-12-20T00:00:00.000Z", third.id);

    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => maintenanceTime,
      1,
      30 * 24 * 60 * 60 * 1_000,
      1
    );
    expect(retention.compactBatch()).toEqual({ selected: 1, compacted: 1, skipped: 0 });
    expect([first, second].filter((operation) => retention.getReceipt(operation.id))).toHaveLength(
      1
    );
    expect(retention.getReceipt(third.id)).toBeUndefined();
    expect(retention.compactBatch()).toEqual({ selected: 1, compacted: 1, skipped: 0 });
    expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
  });

  it("writes an auditable receipt before child-first compaction and preserves terminal queries", async () => {
    const fixture = await setup();
    const operation = seedTerminalOperation(fixture, "receipt");
    const database = fixture.server.database;
    database
      .prepare(
        `INSERT INTO remote_operation_events(operation_id,execution_attempt_id,type,occurred_at)
         VALUES (?,?,'remote.attempt.completed',?)`
      )
      .run(operation.id, operation.executionAttemptId, oldTime);
    database
      .prepare(
        `INSERT INTO host_capacity_reservations(
          lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,
          version,created_at,released_at
        ) VALUES (?,?,?,1,'released',?,1,?,?)`
      )
      .run(
        operation.attempt.leaseId,
        operation.executionAttemptId,
        fixture.hostId,
        oldTime,
        oldTime,
        oldTime
      );
    database
      .prepare(
        `INSERT INTO dispatch_execution_envelopes(dispatch_id,envelope_digest,canonical_json,created_at)
         VALUES (?,?,?,?)`
      )
      .run(
        operation.dispatchId,
        `envelope:sha256:${"b".repeat(64)}`,
        JSON.stringify({ retained: true }),
        oldTime
      );
    database
      .prepare(
        `INSERT INTO remote_acp_event_streams(
          execution_attempt_id,operation_id,dispatch_id,lease_id,host_id,acp_session_id,
          latest_cursor,retained_from_cursor,retained_count,retained_bytes,dropped_count,updated_at
        ) VALUES (?,?,?,?,?,?,1,1,1,2,0,?)`
      )
      .run(
        operation.executionAttemptId,
        operation.id,
        operation.dispatchId,
        operation.attempt.leaseId,
        fixture.hostId,
        "session-receipt",
        oldTime
      );
    database
      .prepare(
        `INSERT INTO remote_acp_events(execution_attempt_id,cursor,event_json,encoded_bytes,received_at)
         VALUES (?,1,'{}',2,?)`
      )
      .run(operation.executionAttemptId, oldTime);
    const artifactRef = `artifact:sha256:${"a".repeat(64)}`;
    database
      .prepare(
        `INSERT INTO artifact_blobs(ref,sha256,size_bytes,media_type,relative_path,created_at)
         VALUES (?,?,1,'text/plain',?,?)`
      )
      .run(artifactRef, "a".repeat(64), `${"a".repeat(2)}/${"a".repeat(64)}`, oldTime);
    database
      .prepare(
        `INSERT INTO artifact_grants(
          grant_id,request_fingerprint,project_id,host_id,dispatch_id,lease_id,
          execution_attempt_id,permission,artifact_ref,expected_sha256,expected_size_bytes,
          expected_media_type,expires_at,consumed_at,created_at
        ) VALUES (?,?,?,?,?,? ,?,'report_write',?,?,1,'text/plain',?,?,?)`
      )
      .run(
        "grant-receipt",
        "e".repeat(64),
        operation.projectId,
        fixture.hostId,
        operation.dispatchId,
        operation.attempt.leaseId,
        operation.executionAttemptId,
        artifactRef,
        "a".repeat(64),
        oldTime,
        oldTime,
        oldTime
      );
    database
      .prepare(
        `INSERT INTO dispatch_artifact_links(
          project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,
          purpose,permission,grant_id,produced_by_host_id,linked_at
        ) VALUES (?,?,?,?,?,?,'report','report_write',?,?,?)`
      )
      .run(
        operation.projectId,
        fixture.hostId,
        operation.dispatchId,
        operation.attempt.leaseId,
        operation.executionAttemptId,
        artifactRef,
        "grant-receipt",
        fixture.hostId,
        oldTime
      );
    const historicalAttemptId = "attempt-historical-receipt";
    const historicalDispatchId = "dispatch-historical-receipt";
    const historicalLeaseId = "lease-historical-receipt";
    database
      .prepare(
        `INSERT INTO remote_execution_attempts(
          execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,
          block_ref,ownership_generation,status,host_id,lease_id,lease_fencing_token,
          lease_expires_at,state_version,created_at,updated_at,terminal_at
        ) VALUES (?,?,?,?,?,?,?,?,'superseded',?,?,1,?,1,?,?,?)`
      )
      .run(
        historicalAttemptId,
        operation.id,
        historicalDispatchId,
        fixture.workspaceId,
        operation.projectId,
        operation.canvasId,
        operation.blockRef,
        operation.ownershipGeneration,
        fixture.hostId,
        historicalLeaseId,
        oldTime,
        oldTime,
        oldTime,
        oldTime
      );
    database
      .prepare(
        `INSERT INTO dispatches(
          id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
          lease_id,execution_attempt_id,lease_expires_at,created_at,finished_at
        ) VALUES (?,?,?,?,?,?,'failed',?,?,?,?,?)`
      )
      .run(
        historicalDispatchId,
        fixture.workspaceId,
        operation.projectId,
        operation.blockRef,
        fixture.hostId,
        JSON.stringify(operation.requiredCapabilities),
        historicalLeaseId,
        historicalAttemptId,
        oldTime,
        oldTime,
        oldTime
      );
    database
      .prepare(
        `INSERT INTO dispatch_execution_envelopes(dispatch_id,envelope_digest,canonical_json,created_at)
         VALUES (?,?,?,?)`
      )
      .run(
        historicalDispatchId,
        `envelope:sha256:${"c".repeat(64)}`,
        JSON.stringify({ historical: true }),
        oldTime
      );
    database
      .prepare(
        `INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at)
         VALUES (?,'dispatch.failed','{}',?)`
      )
      .run(historicalDispatchId, oldTime);
    database
      .prepare(
        `INSERT INTO artifact_grants(
          grant_id,request_fingerprint,project_id,host_id,dispatch_id,lease_id,
          execution_attempt_id,permission,artifact_ref,expected_sha256,expected_size_bytes,
          expected_media_type,expires_at,consumed_at,created_at
        ) VALUES ('grant-historical',?,?,?,?,?,?,'report_write',?,?,1,'text/plain',?,?,?)`
      )
      .run(
        "f".repeat(64),
        operation.projectId,
        fixture.hostId,
        historicalDispatchId,
        historicalLeaseId,
        historicalAttemptId,
        artifactRef,
        "a".repeat(64),
        oldTime,
        oldTime,
        oldTime
      );
    database
      .prepare(
        `INSERT INTO dispatch_artifact_links(
          project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,
          purpose,permission,grant_id,produced_by_host_id,linked_at
        ) VALUES (?,?,?,?,?,?,'report','report_write','grant-historical',?,?)`
      )
      .run(
        operation.projectId,
        fixture.hostId,
        historicalDispatchId,
        historicalLeaseId,
        historicalAttemptId,
        artifactRef,
        fixture.hostId,
        oldTime
      );

    const retention = new RemoteOperationRetention(database, () => maintenanceTime, 0, 1, 25);
    expect(retention.compactBatch()).toMatchObject({ compacted: 1 });
    const receipt = retention.getReceipt(operation.id);
    expect(receipt).toMatchObject({
      operationId: operation.id,
      summary: {
        version: "remote-operation-retention-receipt/v1",
        operation: {
          terminalState: "completed",
          executionAttemptId: operation.executionAttemptId,
          dispatchId: operation.dispatchId
        },
        streams: {
          operationEvents: { count: 2, digest: expect.any(String) },
          reservations: { count: 1, digest: expect.any(String) },
          acpEvents: { count: 1, digest: expect.any(String) },
          historicalDispatchEnvelopes: { count: 1, digest: expect.any(String) },
          historicalArtifactGrants: { count: 1, digest: expect.any(String) },
          historicalArtifactLinks: { count: 1, digest: expect.any(String) }
        },
        historicalArtifactProvenance: [
          expect.objectContaining({
            artifactRef,
            dispatchId: historicalDispatchId,
            executionAttemptId: historicalAttemptId,
            grantId: "grant-historical"
          })
        ]
      }
    });
    expect(new RemoteOperationRepository(database).getRequired(operation.id)).toMatchObject({
      state: "completed",
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId
    });
    expect(count(fixture.server, "remote_operation_events", "operation_id", operation.id)).toBe(0);
    expect(
      count(
        fixture.server,
        "host_capacity_reservations",
        "execution_attempt_id",
        operation.executionAttemptId
      )
    ).toBe(0);
    expect(
      count(
        fixture.server,
        "remote_acp_events",
        "execution_attempt_id",
        operation.executionAttemptId
      )
    ).toBe(0);
    expect(count(fixture.server, "dispatches", "id", operation.dispatchId)).toBe(1);
    expect(
      count(fixture.server, "dispatch_execution_envelopes", "dispatch_id", operation.dispatchId)
    ).toBe(1);
    expect(
      new ArtifactAuthorizationRepository(database).getGrantRequired("grant-receipt")
    ).toMatchObject({
      dispatchId: operation.dispatchId,
      artifactRef
    });
    expect(
      count(fixture.server, "dispatch_artifact_links", "dispatch_id", operation.dispatchId)
    ).toBe(1);
    expect(count(fixture.server, "dispatches", "id", historicalDispatchId)).toBe(0);
    expect(
      count(fixture.server, "dispatch_execution_envelopes", "dispatch_id", historicalDispatchId)
    ).toBe(0);
    expect(count(fixture.server, "artifact_grants", "dispatch_id", historicalDispatchId)).toBe(0);
    expect(
      count(fixture.server, "dispatch_artifact_links", "dispatch_id", historicalDispatchId)
    ).toBe(0);
    expect(
      count(
        fixture.server,
        "remote_execution_attempts",
        "execution_attempt_id",
        historicalAttemptId
      )
    ).toBe(0);
    expect(
      new RemoteAcpEventRepository(database).replay(operation.executionAttemptId, 0)
    ).toMatchObject({
      cursor: 1,
      highWatermark: 1,
      events: [],
      diagnostics: [
        { code: "remote_acp_event_retention_gap", droppedThroughCursor: 1 },
        { code: "remote_acp_event_contract_degraded" }
      ]
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
    database
      .prepare(
        `UPDATE remote_operation_retention_receipts
         SET summary_json=json_set(summary_json,'$.operation.terminalState','failed')
         WHERE operation_id=?`
      )
      .run(operation.id);
    expect(() => retention.getReceipt(operation.id)).toThrow(
      "remote_operation_retention_receipt_digest_mismatch"
    );
  });

  it.each([
    ["active reservation", "reservation"],
    ["unsettled action", "action"],
    ["pending interaction", "interaction"],
    ["awaiting writeback dispatch", "writeback"]
  ])("refuses a terminal-looking operation with %s", async (_label, unsafe) => {
    const fixture = await setup();
    const operation = seedTerminalOperation(fixture, unsafe);
    const database = fixture.server.database;
    if (unsafe === "reservation") {
      database
        .prepare(
          `INSERT INTO host_capacity_reservations(
            lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,created_at
          ) VALUES (?,?,?,1,'active',?,?)`
        )
        .run(
          operation.attempt.leaseId,
          operation.executionAttemptId,
          fixture.hostId,
          oldTime,
          oldTime
        );
    } else if (unsafe === "action") {
      database
        .prepare(
          `INSERT INTO remote_execution_actions(
            action_id,operation_id,dispatch_id,execution_attempt_id,kind,request_fingerprint,
            request_json,state,created_at
          ) VALUES (?,?,?,?,? ,?,?, 'recorded',?)`
        )
        .run(
          "action-unsafe",
          operation.id,
          operation.dispatchId,
          operation.executionAttemptId,
          "fail",
          "c".repeat(64),
          "{}",
          oldTime
        );
    } else if (unsafe === "interaction") {
      database
        .prepare(
          `INSERT INTO remote_interactions(
            action_id,operation_id,host_id,dispatch_id,lease_id,execution_attempt_id,
            acp_session_id,request_type,request_fingerprint,request_json,status,expires_at,created_at
          ) VALUES (?,?,?,?,?,?,?,'interaction.permission_requested',?,?,'pending',?,?)`
        )
        .run(
          "interaction-unsafe",
          operation.id,
          fixture.hostId,
          operation.dispatchId,
          operation.attempt.leaseId,
          operation.executionAttemptId,
          "session-unsafe",
          "d".repeat(64),
          "{}",
          "2031-01-01T00:00:00.000Z",
          oldTime
        );
    } else {
      database
        .prepare("UPDATE dispatches SET status='awaiting_writeback' WHERE id=?")
        .run(operation.dispatchId);
    }

    const retention = new RemoteOperationRetention(database, () => maintenanceTime, 0, 1, 25);
    expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
    expect(retention.getReceipt(operation.id)).toBeUndefined();
    expect(new RemoteOperationRepository(database).getRequired(operation.id).state).toBe(
      "completed"
    );
  });
});

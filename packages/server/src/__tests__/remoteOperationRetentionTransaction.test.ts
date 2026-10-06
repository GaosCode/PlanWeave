import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import { RemoteOperationRetention } from "../remoteOperationRetention.js";

const oldTime = "2029-01-01T00:00:00.000Z";
const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("remote operation retention transaction", () => {
  it("rolls back the receipt with child deletes and replays migration across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-retention-transaction-"));
    directories.push(directory);
    const databasePath = join(directory, "server.sqlite");
    const server = await startPlanweaveServer({
      dataDirectory: directory,
      databasePath,
      busyTimeoutMs: 5_000
    });
    servers.push(server);
    const hostId = new AgentHostRepository(server.database, () => new Date(oldTime)).register(
      "Retention Transaction Host"
    ).host.id;
    const workspaceId = new WorkspaceIdentityRepository(
      server.database
    ).ensureWorkspaceForLegacyProject("project-retention-transaction");
    const operation = new RemoteOperationRepository(
      server.database,
      () => new Date(oldTime)
    ).create({
      workspaceId,
      projectId: "project-retention-transaction",
      canvasId: "default",
      blockRef: "T-001#B-rollback",
      ownershipGeneration: "generation-rollback",
      idempotencyKey: "retention-rollback",
      sourceFingerprint: "fingerprint-rollback",
      requiredCapabilities: ["acp.codex"]
    });
    server.database
      .prepare(
        `UPDATE remote_execution_attempts
         SET status='completed',host_id=?,lease_id='lease-rollback',lease_fencing_token=1,
           lease_expires_at=?,state_version=1,updated_at=?,terminal_at=?
         WHERE execution_attempt_id=?`
      )
      .run(hostId, oldTime, oldTime, oldTime, operation.executionAttemptId);
    server.database
      .prepare(
        "UPDATE remote_operations SET state='completed',updated_at=?,terminal_at=? WHERE id=?"
      )
      .run(oldTime, oldTime, operation.id);
    server.database
      .prepare(
        `INSERT INTO dispatches(
          id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
          lease_id,execution_attempt_id,lease_expires_at,created_at,finished_at
        ) VALUES (?,?,?,?,?,?,'completed','lease-rollback',?,?,?,?)`
      )
      .run(
        operation.dispatchId,
        workspaceId,
        operation.projectId,
        operation.blockRef,
        hostId,
        JSON.stringify(operation.requiredCapabilities),
        operation.executionAttemptId,
        oldTime,
        oldTime,
        oldTime
      );
    server.database.exec(`
      CREATE TRIGGER reject_retention_delete
      BEFORE DELETE ON remote_operation_events
      BEGIN SELECT RAISE(ABORT,'injected_retention_delete_failure'); END;
    `);
    const retention = new RemoteOperationRetention(
      server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      25
    );

    expect(() => retention.compactBatch()).toThrow("injected_retention_delete_failure");
    expect(retention.getReceipt(operation.id)).toBeUndefined();
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_operation_events WHERE operation_id=?")
        .get(operation.id)?.count
    ).toBe(1);
    server.database.exec("DROP TRIGGER reject_retention_delete");
    server.database.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE corrupted_child(operation_id TEXT REFERENCES remote_operations(id));
      INSERT INTO corrupted_child VALUES ('missing-operation');
      PRAGMA foreign_keys=ON;
    `);
    expect(server.database.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    expect(() => retention.compactBatch()).toThrow(
      "remote_operation_retention_foreign_key_violation"
    );
    expect(retention.getReceipt(operation.id)).toBeUndefined();
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_operation_events WHERE operation_id=?")
        .get(operation.id)?.count
    ).toBe(1);
    server.database.exec("DELETE FROM corrupted_child");
    expect(retention.compactBatch().compacted).toBe(1);
    server.close();
    servers.splice(servers.indexOf(server), 1);

    const restarted = await startPlanweaveServer({
      dataDirectory: directory,
      databasePath,
      busyTimeoutMs: 5_000
    });
    servers.push(restarted);
    expect(restarted.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      new RemoteOperationRetention(
        restarted.database,
        () => new Date("2030-01-01T00:00:00.000Z"),
        0,
        1,
        25
      ).compactBatch()
    ).toMatchObject({ compacted: 0 });
  });
});

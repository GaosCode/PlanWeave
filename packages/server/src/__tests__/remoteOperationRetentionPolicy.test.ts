import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import {
  REMOTE_OPERATION_RETENTION_BATCH_SIZE,
  REMOTE_OPERATION_RETENTION_FULL_PER_SCOPE,
  REMOTE_OPERATION_RETENTION_MAX_AGE_MS,
  RemoteOperationRetention
} from "../remoteOperationRetention.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const oldTime = "2029-01-01T00:00:00.000Z";

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-retention-policy-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const hostId = new AgentHostRepository(server.database, () => new Date(oldTime)).register(
    "Retention Policy Host"
  ).host.id;
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject("project-retention-policy");
  return { server, hostId, workspaceId };
}

function seedTerminal(
  fixture: Awaited<ReturnType<typeof setup>>,
  suffix: string,
  canvasId = "default"
) {
  const operations = new RemoteOperationRepository(
    fixture.server.database,
    () => new Date(oldTime)
  );
  const operation = operations.create({
    workspaceId: fixture.workspaceId,
    projectId: "project-retention-policy",
    canvasId,
    blockRef: `T-001#B-${suffix}`,
    ownershipGeneration: `generation-${suffix}`,
    idempotencyKey: `retention-${suffix}`,
    sourceFingerprint: `fingerprint-${suffix}`,
    requiredCapabilities: ["acp.codex"]
  });
  const leaseId = `lease-${suffix}`;
  fixture.server.database
    .prepare(
      `UPDATE remote_execution_attempts
       SET status='completed',host_id=?,lease_id=?,lease_fencing_token=1,lease_expires_at=?,
         state_version=1,updated_at=?,terminal_at=? WHERE execution_attempt_id=?`
    )
    .run(fixture.hostId, leaseId, oldTime, oldTime, oldTime, operation.executionAttemptId);
  fixture.server.database
    .prepare("UPDATE remote_operations SET state='completed',updated_at=?,terminal_at=? WHERE id=?")
    .run(oldTime, oldTime, operation.id);
  fixture.server.database
    .prepare(
      `INSERT INTO dispatches(
        id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
        lease_id,execution_attempt_id,lease_expires_at,created_at,finished_at
      ) VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?)`
    )
    .run(
      operation.dispatchId,
      fixture.workspaceId,
      operation.projectId,
      operation.blockRef,
      fixture.hostId,
      JSON.stringify(operation.requiredCapabilities),
      leaseId,
      operation.executionAttemptId,
      oldTime,
      oldTime,
      oldTime
    );
  return operation;
}

describe("remote operation retention policy", () => {
  it("keeps the default count and age windows per exact scope and bounds each batch", async () => {
    expect(REMOTE_OPERATION_RETENTION_FULL_PER_SCOPE).toBe(100);
    expect(REMOTE_OPERATION_RETENTION_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(REMOTE_OPERATION_RETENTION_BATCH_SIZE).toBe(25);
    const fixture = await setup();
    const oldDefaultScope = Array.from({ length: 126 }, (_, index) =>
      seedTerminal(fixture, `default-${String(index).padStart(3, "0")}`)
    );
    const otherScope = seedTerminal(fixture, "other-000", "other");
    const recentOutsideCount = seedTerminal(fixture, "recent-000");
    fixture.server.database
      .prepare("UPDATE remote_operations SET terminal_at=? WHERE id=?")
      .run("2029-12-20T00:00:00.000Z", recentOutsideCount.id);

    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z")
    );
    expect(retention.compactBatch()).toEqual({ selected: 25, compacted: 25, skipped: 0 });
    expect(oldDefaultScope.filter((operation) => retention.getReceipt(operation.id))).toHaveLength(
      25
    );
    expect(retention.getReceipt(otherScope.id)).toBeUndefined();
    expect(retention.getReceipt(recentOutsideCount.id)).toBeUndefined();
  });

  it("converges past twenty-five ineligible operations to the next eligible operation", async () => {
    const fixture = await setup();
    const blocked = Array.from({ length: 40 }, (_, index) =>
      seedTerminal(fixture, `blocked-${String(index).padStart(2, "0")}`)
    );
    for (const [index, operation] of blocked.entries()) {
      fixture.server.database
        .prepare("UPDATE remote_operations SET terminal_at=? WHERE id=?")
        .run(new Date(Date.UTC(2028, 0, index + 1)).toISOString(), operation.id);
      fixture.server.database
        .prepare("UPDATE dispatches SET status='awaiting_writeback' WHERE id=?")
        .run(operation.dispatchId);
    }
    const eligible = seedTerminal(fixture, "eligible-26");
    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      1
    );

    for (let page = 0; page < 40; page += 1) {
      expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
    }
    expect(retention.compactBatch()).toEqual({ selected: 1, compacted: 1, skipped: 0 });
    expect(retention.getReceipt(eligible.id)?.operationId).toBe(eligible.id);
    expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
    expect(blocked.every((operation) => retention.getReceipt(operation.id) === undefined)).toBe(
      true
    );
  });

  it("rotates scopes, revisits settled old rows, and discovers new scopes across restart", async () => {
    const fixture = await setup();
    const blocked = seedTerminal(fixture, "rotating-blocked", "a");
    const eligible = seedTerminal(fixture, "rotating-eligible", "b");
    fixture.server.database
      .prepare("UPDATE dispatches SET status='awaiting_writeback' WHERE id=?")
      .run(blocked.dispatchId);
    let retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      1
    );
    expect(retention.compactBatch().compacted).toBe(0);
    expect(retention.compactBatch().compacted).toBe(1);
    expect(retention.getReceipt(eligible.id)).toBeDefined();
    fixture.server.database
      .prepare("UPDATE dispatches SET status='completed' WHERE id=?")
      .run(blocked.dispatchId);
    const newScope = seedTerminal(fixture, "new-scope", "c");
    for (let pass = 0; pass < 8; pass += 1) retention.compactBatch();
    expect(retention.getReceipt(blocked.id)).toBeDefined();
    expect(retention.getReceipt(newScope.id)).toBeDefined();
    const restartScope = seedTerminal(fixture, "restart-scope", "0");
    const directory = directories.at(-1)!;
    fixture.server.close();
    servers.splice(servers.indexOf(fixture.server), 1);
    const restarted = await startPlanweaveServer({
      dataDirectory: directory,
      databasePath: join(directory, "server.sqlite"),
      busyTimeoutMs: 5000
    });
    servers.push(restarted);
    retention = new RemoteOperationRetention(
      restarted.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      1
    );
    expect(retention.compactBatch().compacted).toBe(1);
    expect(retention.getReceipt(restartScope.id)).toBeDefined();
  });

  it("includes already compacted operations in the latest hundred ranking at equal timestamps", async () => {
    const fixture = await setup();
    const operations = Array.from({ length: 105 }, (_, index) =>
      seedTerminal(fixture, `rank-${index}`)
    );
    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z")
    );
    expect(retention.compactBatch().compacted).toBe(5);
    const newest = [...operations].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 100);
    const initialReceipt = retention.getReceipt(
      operations.find((operation) => retention.getReceipt(operation.id))!.id
    )!;
    for (let pass = 0; pass < 4; pass += 1) retention.compactBatch();
    expect(newest.every((operation) => retention.getReceipt(operation.id) === undefined)).toBe(
      true
    );
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_operation_retention_receipts")
        .get()?.count
    ).toBe(5);
    expect(retention.getReceipt(initialReceipt.operationId)).toEqual(initialReceipt);
  });

  it("performs empty receipt-only and unsafe passes while another connection holds the write lock", async () => {
    const fixture = await setup();
    const operation = seedTerminal(fixture, "empty-write-lock");
    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      25
    );
    expect(retention.compactBatch().compacted).toBe(1);
    const blocked = seedTerminal(fixture, "unsafe-write-lock");
    fixture.server.database
      .prepare("UPDATE dispatches SET status='awaiting_writeback' WHERE id=?")
      .run(blocked.dispatchId);
    const other = await openServerDatabase(join(directories.at(-1)!, "server.sqlite"), 1);
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
      expect(retention.getReceipt(operation.id)).toBeDefined();
      expect(retention.getReceipt(blocked.id)).toBeUndefined();
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });

  it("revalidates the newest ranking and safety after acquiring the write transaction", async () => {
    const fixture = await setup();
    const older = seedTerminal(fixture, "race-older");
    const newer = seedTerminal(fixture, "race-newer");
    fixture.server.database
      .prepare("UPDATE remote_operations SET terminal_at=? WHERE id=?")
      .run("2028-01-01T00:00:00.000Z", older.id);
    let changed = false;
    const database: SqliteDatabase = {
      prepare: (sql) => fixture.server.database.prepare(sql),
      close: () => fixture.server.database.close(),
      exec: (sql) => {
        if (sql === "BEGIN IMMEDIATE" && !changed) {
          changed = true;
          fixture.server.database
            .prepare("UPDATE remote_operations SET terminal_at=? WHERE id=?")
            .run("2027-01-01T00:00:00.000Z", newer.id);
        }
        fixture.server.database.exec(sql);
      }
    };
    const retention = new RemoteOperationRetention(
      database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      1,
      1,
      25
    );
    expect(retention.compactBatch()).toEqual({ selected: 1, compacted: 0, skipped: 1 });
    expect(retention.getReceipt(older.id)).toBeUndefined();
    expect(retention.compactBatch().compacted).toBe(1);
    expect(retention.getReceipt(newer.id)).toBeDefined();
  });

  it.each([150, 750])("bounds raw index pages with %i previously compacted rows", async (count) => {
    const fixture = await setup();
    for (let index = 0; index < count; index += 1) seedTerminal(fixture, `bounded-${index}`);
    const initial = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      25
    );
    for (let pass = 0; pass < Math.ceil(count / 25); pass += 1) initial.compactBatch();
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_operation_retention_receipts")
        .get()?.count
    ).toBe(count);
    const pages: number[] = [];
    const plans: string[] = [];
    let writes = 0;
    const database: SqliteDatabase = {
      close: () => fixture.server.database.close(),
      exec: (sql) => {
        writes += 1;
        fixture.server.database.exec(sql);
      },
      prepare: (sql) => {
        const statement = fixture.server.database.prepare(sql);
        return {
          get: (...values) => statement.get(...values),
          run: (...values) => statement.run(...values),
          all: (...values) => {
            const rows = statement.all(...values);
            pages.push(rows.length);
            plans.push(
              ...fixture.server.database
                .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all(...values)
                .map((row) => String(row.detail))
            );
            return rows;
          }
        };
      }
    };
    const retention = new RemoteOperationRetention(
      database,
      () => new Date("2030-01-01T00:00:00.000Z")
    );
    for (let pass = 0; pass < 3; pass += 1) {
      const before = pages.length;
      expect(retention.compactBatch().compacted).toBe(0);
      expect(pages.slice(before)).toEqual([100, 25]);
    }
    expect(writes).toBe(0);
    expect(
      plans.every((plan) =>
        plan.includes("USING INDEX idx_remote_operation_retention_scope_terminal")
      )
    ).toBe(true);
    expect(plans.every((plan) => !plan.includes("TEMP B-TREE"))).toBe(true);
  });

  it("discovers operations when the age cutoff advances after an empty pass", async () => {
    const fixture = await setup();
    const operation = seedTerminal(fixture, "new-cutoff");
    let now = new Date("2029-01-20T00:00:00.000Z");
    const retention = new RemoteOperationRetention(fixture.server.database, () => now, 0);
    expect(retention.compactBatch().compacted).toBe(0);
    now = new Date("2029-02-20T00:00:00.000Z");
    expect(retention.compactBatch().compacted).toBe(1);
    expect(retention.getReceipt(operation.id)).toBeDefined();
  });

  it.each([
    ["missing dispatch", "missing"],
    ["attempt identity mismatch", "attempt"],
    ["dispatch scope mismatch", "scope"]
  ])("fails closed for %s", async (_label, mismatch) => {
    const fixture = await setup();
    const operation = seedTerminal(fixture, `mismatch-${mismatch}`);
    if (mismatch === "missing") {
      fixture.server.database
        .prepare("DELETE FROM dispatches WHERE id=?")
        .run(operation.dispatchId);
    } else if (mismatch === "attempt") {
      fixture.server.database
        .prepare("UPDATE dispatches SET execution_attempt_id=? WHERE id=?")
        .run("attempt-mismatched", operation.dispatchId);
    } else {
      fixture.server.database
        .prepare("UPDATE dispatches SET workspace_id=? WHERE id=?")
        .run("workspace-mismatched", operation.dispatchId);
    }
    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      25
    );

    expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
    expect(retention.getReceipt(operation.id)).toBeUndefined();
  });
});

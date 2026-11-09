import { afterEach, describe, expect, it } from "vitest";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import { RuntimeArtifactRetention } from "../canvas/runtimeArtifactRetention.js";
import { AgentHostRepository } from "../hosts.js";
import { applyMigrations } from "../migrations.js";
import { migrations } from "../migrations/registry.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup(oldSchema = false) {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  if (oldSchema) {
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)"
    );
    for (const migration of migrations.filter((item) => item.version < 80)) {
      if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys=OFF");
      database.exec("BEGIN IMMEDIATE");
      migration.before?.(database);
      database.exec(migration.sql);
      migration.after?.(database);
      database
        .prepare("INSERT INTO schema_migrations VALUES(?,?)")
        .run(migration.version, "2030-01-01T00:00:00.000Z");
      database.exec("COMMIT");
      if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys=ON");
    }
  } else applyMigrations(database);
  const host = new AgentHostRepository(database).register("retention host").host;
  let now = new Date("2030-01-01T00:00:00.000Z");
  let authority = true;
  const clock = () => now;
  const grants = new RuntimeArtifactGrantRepository(database, {
    clock,
    maxArtifactBytes: 1024,
    leaseActive: () => authority
  });
  const retention = new RuntimeArtifactRetention(database, grants, clock);
  const lease = (id: string, expiresAt = "2030-01-01T00:01:00.000Z") =>
    grants.recordLease({
      runtimeLeaseId: id,
      hostId: host.id,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      attachmentVersion: 0,
      sourceRevision: `snapshot:${"b".repeat(64)}`,
      graphFingerprint: `pkg-${"a".repeat(64)}`,
      expiresAt
    });
  const grant = (id: string, operationId = "op") =>
    grants.createDownloadGrant({
      runtimeLeaseId: id,
      operationId,
      artifactRef: `artifact:sha256:${"c".repeat(64)}`,
      sha256: "c".repeat(64),
      sizeBytes: 1,
      mediaType: "text/plain",
      expiresAt: "2030-01-01T00:01:00.000Z"
    });
  const counts = () => ({
    leases: Number(database.prepare("SELECT COUNT(*) n FROM canvas_runtime_leases").get()!.n),
    grants: Number(
      database.prepare("SELECT COUNT(*) n FROM canvas_runtime_artifact_grants").get()!.n
    )
  });
  return {
    database,
    host,
    grants,
    retention,
    lease,
    grant,
    counts,
    time: (value: string) => {
      now = new Date(value);
    },
    detach: () => {
      authority = false;
    }
  };
}

describe("RuntimeArtifactRetention", () => {
  it("converges old released, revoked, expired active and grantless history with bounded fair pages", async () => {
    const test = await setup();
    test.lease("a-fanout");
    for (let index = 0; index < 405; index++) test.grant("a-fanout", `fan-${index}`);
    for (let index = 0; index < 120; index++) {
      const id = `lease-${String(index).padStart(3, "0")}`;
      test.lease(id);
      if (index % 3 !== 0) test.grant(id);
      if (index % 3 === 1) test.grants.releaseLease(id);
    }
    test.lease("restart");
    test.grant("restart");
    test.grants.revokeActiveAfterRestart();
    test.lease("expired-active");
    test.grant("expired-active");
    test.time("2030-01-03T00:00:00.000Z");
    const first = test.retention.compactBatch();
    expect(first.selected).toBe(100);
    expect(first.grantsDeleted).toBeLessThanOrEqual(200);
    expect(test.grants.lease("a-fanout")).toBeDefined();
    expect(test.grants.lease("lease-001")).toBeUndefined();
    for (let pass = 0; pass < 12; pass++) {
      const batch = test.retention.compactBatch();
      expect(batch.selected).toBeLessThanOrEqual(100);
      expect(batch.grantsDeleted).toBeLessThanOrEqual(200);
    }
    expect(test.counts()).toEqual({ leases: 0, grants: 0 });
    expect(test.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains valid, recently terminal and expiry-grace rows and original retry identity", async () => {
    const test = await setup();
    test.lease("window");
    const descriptor = test.grant("window");
    expect(test.grant("window")).toEqual(descriptor);
    test.database
      .prepare("UPDATE canvas_runtime_artifact_grants SET consumed_at=? WHERE grant_id=?")
      .run("2030-01-01T00:00:10.000Z", descriptor.grantId);
    test.lease("live", "2031-01-01T00:00:00.000Z");
    test.lease("released");
    test.grant("released");
    test.time("2030-01-01T23:00:00.000Z");
    test.grants.releaseLease("released");
    test.time("2030-01-02T00:00:30.000Z");
    expect(test.retention.compactBatch().selected).toBe(0);
    expect(test.counts()).toEqual({ leases: 3, grants: 2 });
    test.time("2030-01-02T00:01:00.000Z");
    expect(test.retention.compactBatch().compacted).toBe(1);
    expect(test.grants.lease("released")).toBeDefined();
    expect(test.grants.lease("live")).toBeDefined();
    test.time("2030-01-03T00:00:00.000Z");
    expect(test.retention.compactBatch().compacted).toBe(1);
  });

  it("holds real transfer lifetimes across expiry and release until all holders finish", async () => {
    const test = await setup();
    test.lease("held");
    test.grant("held");
    const first = test.grants.holdTransfer("held");
    const second = test.grants.holdTransfer("held");
    test.grants.releaseLease("held");
    test.time("2030-01-03T00:00:00.000Z");
    expect(test.retention.compactBatch().compacted).toBe(0);
    first();
    first();
    expect(test.retention.compactBatch().compacted).toBe(0);
    second();
    expect(test.retention.compactBatch().compacted).toBe(1);
  });

  it("advances past a full held timestamp page and resumes partial work after owner restart", async () => {
    const test = await setup();
    const releases: Array<() => void> = [];
    for (let index = 0; index < 101; index++) {
      const id = `held-${String(index).padStart(3, "0")}`;
      test.lease(id);
      if (index < 100) releases.push(test.grants.holdTransfer(id));
    }
    test.time("2030-01-03T00:00:00.000Z");
    expect(test.retention.compactBatch()).toMatchObject({ selected: 100, compacted: 0 });
    expect(test.retention.compactBatch()).toMatchObject({ selected: 1, compacted: 1 });
    expect(test.grants.lease("held-100")).toBeUndefined();
    const restarted = new RuntimeArtifactRetention(
      test.database,
      test.grants,
      () => new Date("2030-01-03T00:00:00.000Z")
    );
    expect(restarted.compactBatch().compacted).toBe(0);
    for (const release of releases) release();
    expect(restarted.compactBatch().compacted).toBe(100);
    expect(test.counts()).toEqual({ leases: 0, grants: 0 });
  });

  it("rolls back child deletion when parent deletion fails and retries without losing the page", async () => {
    const test = await setup();
    test.lease("rollback");
    test.grant("rollback");
    test.time("2030-01-03T00:00:00.000Z");
    test.database.exec(
      "CREATE TRIGGER retention_abort BEFORE DELETE ON canvas_runtime_leases BEGIN SELECT RAISE(ABORT,'retention_failure'); END"
    );
    expect(() => test.retention.compactBatch()).toThrow("retention_failure");
    expect(test.counts()).toEqual({ leases: 1, grants: 1 });
    test.database.exec("DROP TRIGGER retention_abort");
    expect(test.retention.compactBatch().compacted).toBe(1);
  });

  it("rejects old grant and acquire replays after collection without replacing valid identity", async () => {
    const test = await setup();
    const original = test.lease("old-response");
    const transfer = test.grant("old-response");
    expect(test.grants.recordLease(original)).toEqual(original);
    expect(() =>
      test.grants.recordLease({ ...original, graphFingerprint: `pkg-${"d".repeat(64)}` })
    ).toThrow("canvas_runtime_lease_identity_conflict");
    test.time("2030-01-03T00:00:00.000Z");
    test.retention.compactBatch();
    expect(() => test.grants.recordLease(original)).toThrow("runtime_artifact_scope_forbidden");
    expect(() => test.grant("old-response")).toThrow("runtime_artifact_scope_forbidden");
    expect(() =>
      test.grants.authorizeDownload({
        hostId: test.host.id,
        runtimeLeaseId: original.runtimeLeaseId,
        grantId: transfer.grantId,
        sha256: transfer.sha256
      })
    ).toThrow("runtime_artifact_scope_forbidden");
    expect(test.counts()).toEqual({ leases: 0, grants: 0 });
  });

  it("upgrades populated old schema with indexed candidates and rolls forward atomically", async () => {
    const test = await setup(true);
    test.lease("old-database");
    test.grant("old-database");
    const originalLease = test.database.prepare("SELECT * FROM canvas_runtime_leases").all();
    const originalGrant = test.database
      .prepare("SELECT * FROM canvas_runtime_artifact_grants")
      .all();
    test.database.exec("CREATE TABLE idx_canvas_runtime_artifact_grants_retention(id TEXT)");
    expect(() => applyMigrations(test.database)).toThrow();
    expect(
      test.database.prepare("SELECT 1 FROM schema_migrations WHERE version=80").get()
    ).toBeUndefined();
    expect(
      test.database
        .prepare("SELECT 1 FROM sqlite_master WHERE name='idx_canvas_runtime_leases_retention'")
        .get()
    ).toBeUndefined();
    test.database.exec("DROP TABLE idx_canvas_runtime_artifact_grants_retention");
    applyMigrations(test.database);
    applyMigrations(test.database);
    expect(test.counts()).toEqual({ leases: 1, grants: 1 });
    expect(test.database.prepare("SELECT * FROM canvas_runtime_leases").all()).toEqual(
      originalLease
    );
    expect(test.database.prepare("SELECT * FROM canvas_runtime_artifact_grants").all()).toEqual(
      originalGrant
    );
    const plan = test.database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT runtime_lease_id FROM canvas_runtime_leases WHERE MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END)<=? ORDER BY MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END),runtime_lease_id LIMIT 100"
      )
      .all("2030-01-03T00:00:00.000Z");
    expect(plan.map((row) => String(row.detail)).join(" ")).toContain(
      "idx_canvas_runtime_leases_retention"
    );
    const equalityPlan = test.database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT runtime_lease_id FROM canvas_runtime_leases WHERE MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END)=? AND runtime_lease_id>? ORDER BY runtime_lease_id LIMIT 100"
      )
      .all("2030-01-01T00:01:00.000Z", "old-database");
    const equalityDetails = equalityPlan.map((row) => String(row.detail)).join(" ");
    expect(equalityDetails).toContain("<expr>=? AND runtime_lease_id>?");
    expect(equalityDetails).not.toContain("TEMP B-TREE");
    const laterPlan = test.database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT runtime_lease_id FROM canvas_runtime_leases WHERE MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END)>? AND MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END)<=? ORDER BY MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END),runtime_lease_id LIMIT 100"
      )
      .all("2030-01-01T00:01:00.000Z", "2030-01-03T00:00:00.000Z");
    const laterDetails = laterPlan.map((row) => String(row.detail)).join(" ");
    expect(laterDetails).toContain("<expr>>? AND <expr><?");
    expect(laterDetails).not.toContain("TEMP B-TREE");

    test.time("2030-01-03T00:00:00.000Z");
    expect(test.retention.compactBatch().compacted).toBe(1);
    expect(test.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("respects a backwards clock and newly terminal eligibility while resuming its cursor", async () => {
    const test = await setup();
    test.lease("held-first");
    test.grant("held-first");
    const finish = test.grants.holdTransfer("held-first");
    test.time("2030-01-02T00:00:59.999Z");
    expect(test.retention.compactBatch().selected).toBe(0);
    test.time("2030-01-02T00:01:00.000Z");
    expect(test.retention.compactBatch()).toMatchObject({ selected: 1, compacted: 0 });
    test.time("2030-01-01T00:00:00.000Z");
    test.lease("new-live");
    const grant = test.grant("new-live");
    expect(test.grant("new-live")).toEqual(grant);
    test.grants.releaseLease("held-first");
    finish();
    expect(test.retention.compactBatch().selected).toBe(0);
    expect(test.counts()).toEqual({ leases: 2, grants: 2 });
    test.time("2030-01-02T00:01:00.001Z");
    expect(test.retention.compactBatch().compacted).toBe(2);
    expect(test.counts()).toEqual({ leases: 0, grants: 0 });
  });

  it.each([
    100, 10_000
  ])("uses indexed bounded candidate pages among %i historical rows", async (size) => {
    const test = await setup();
    for (let index = 0; index < size; index++)
      test.lease(`history-${String(index).padStart(5, "0")}`);
    test.time("2030-01-03T00:00:00.000Z");
    const plans: string[] = [];
    const candidateRows: number[] = [];
    const observed: SqliteDatabase = {
      close: () => test.database.close(),
      exec: (sql) => test.database.exec(sql),
      prepare: (sql) => {
        const statement = test.database.prepare(sql);
        return {
          get: (...values) => statement.get(...values),
          run: (...values) => statement.run(...values),
          all: (...values) => {
            const rows = statement.all(...values);
            if (sql.includes("AS eligible_at")) {
              candidateRows.push(rows.length);
              const details = test.database
                .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all(...values)
                .map((row) => String(row.detail))
                .join(" ");
              expect(details).toContain("SEARCH");
              expect(details).toContain("idx_canvas_runtime_leases_retention");
              expect(details).not.toContain("TEMP B-TREE");
              plans.push(details);
            }
            return rows;
          }
        };
      }
    };
    const retention = new RuntimeArtifactRetention(
      observed,
      test.grants,
      () => new Date("2030-01-03T00:00:00.000Z")
    );
    for (let pass = 0; pass < 2; pass++) {
      candidateRows.length = 0;
      const batch = retention.compactBatch();
      expect(batch.selected).toBeLessThanOrEqual(100);
      expect(candidateRows.reduce((sum, count) => sum + count, 0)).toBe(batch.selected);
    }
    expect(test.counts().leases).toBe(Math.max(0, size - 200));
    process.stdout.write(
      `${JSON.stringify({ historySize: size, remaining: test.counts(), plans })}\n`
    );
  });
});

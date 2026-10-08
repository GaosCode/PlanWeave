import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, centralSchemaVersion } from "../migrations.js";
import { packageSnapshotCleanupMigration } from "../migrations/packageSnapshotCleanup.js";
import { packageSnapshotFixture } from "./packageSnapshotFixture.js";

const fixtures: Awaited<ReturnType<typeof packageSnapshotFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await Promise.all(
      [fixture.workspace.root, fixture.workspace.home].map((path) =>
        rm(path, { recursive: true, force: true })
      )
    );
  }
});

async function oldDatabase() {
  const fixture = await packageSnapshotFixture(
    undefined,
    packageSnapshotCleanupMigration.version - 1
  );
  fixtures.push(fixture);
  const canvas = fixture.access.registry.canvasInternal("w", "p", "default")!;
  const project = fixture.access.registry.projectInternal("w", "p")!;
  const insert = fixture.database.prepare(`INSERT INTO package_snapshots(
    snapshot_id,project_registry_id,canvas_registry_id,workspace_id,project_id,canvas_id,
    source_revision,digest_manifest_json,digest_fingerprint,content_root_internal,
    creator_kind,creator_id,migration_marker,state,acl_revision,project_visibility,
    canvas_visibility,created_at,updated_at,revoked_at,retention_order,restore_marker)
    VALUES(?,?,?,'w','p','default',?,'[]',?,?, 'human','owner','digest_verified',?,0,
      'private','shared','2026-01-01','2026-01-01',?,NULL,?)`);
  for (const [index, state, marker] of [
    [1, "revoked", "none"],
    [2, "available", "none"],
    [3, "available", "restore_pending"]
  ] as const) {
    insert.run(
      `snapshot-${index.toString(16).padStart(32, "0")}`,
      project.projectRegistryId,
      canvas.canvasRegistryId,
      `source-${index}`,
      "a".repeat(64),
      `/legacy/backing-${index}`,
      state,
      state === "revoked" ? "2026-01-01" : null,
      marker
    );
  }
  return fixture.database;
}

describe("package snapshot cleanup migration", () => {
  it("upgrades actual v72 rows and identity without changing audit contents or constraints", async () => {
    const database = await oldDatabase();
    expect(centralSchemaVersion(database)).toBe(72);
    const oldRows = database.prepare("SELECT * FROM package_snapshots ORDER BY snapshot_id").all();
    const identities = database
      .prepare("SELECT * FROM workspace_principals ORDER BY human_principal_id")
      .all();
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(packageSnapshotCleanupMigration.version);
    const upgraded = database.prepare("SELECT * FROM package_snapshots ORDER BY snapshot_id").all();
    expect(upgraded).toEqual(
      oldRows.map((row) => ({ ...row, backing_cleanup_completed_at: null }))
    );
    expect(
      database.prepare("SELECT * FROM workspace_principals ORDER BY human_principal_id").all()
    ).toEqual(identities);
    expect(database.prepare("SELECT * FROM package_snapshot_cleanup_cursors").all()).toEqual([]);
    expect(() =>
      database.exec("UPDATE package_snapshots SET revoked_at=NULL WHERE state='revoked'")
    ).toThrow();
    expect(() =>
      database.exec(
        "UPDATE package_snapshots SET backing_cleanup_completed_at='2026-01-02' WHERE state='available'"
      )
    ).toThrow();
    const indexes = database.prepare("PRAGMA index_list(package_snapshots)").all();
    expect(indexes.some((row) => row.name === "idx_package_snapshots_pending_cleanup")).toBe(true);
    applyMigrations(database);
    expect(database.prepare("SELECT * FROM package_snapshots ORDER BY snapshot_id").all()).toEqual(
      upgraded
    );
  });

  it("rolls the entire forward migration back if recording the schema version fails", async () => {
    const database = await oldDatabase();
    const oldRows = database.prepare("SELECT * FROM package_snapshots ORDER BY snapshot_id").all();
    database.exec(`CREATE TRIGGER fail_snapshot_cleanup_version BEFORE INSERT ON schema_migrations
      WHEN NEW.version=73 BEGIN SELECT RAISE(ABORT,'controlled migration failure'); END`);
    expect(() => applyMigrations(database)).toThrow("controlled migration failure");
    expect(centralSchemaVersion(database)).toBe(72);
    expect(database.prepare("SELECT * FROM package_snapshots ORDER BY snapshot_id").all()).toEqual(
      oldRows
    );
    expect(
      database
        .prepare("PRAGMA table_info(package_snapshots)")
        .all()
        .some((row) => row.name === "backing_cleanup_completed_at")
    ).toBe(false);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('package_snapshot_cleanup_cursors','idx_package_snapshots_pending_cleanup')"
        )
        .all()
    ).toEqual([]);
    database.exec("DROP TRIGGER fail_snapshot_cleanup_version");
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(73);
  });
});

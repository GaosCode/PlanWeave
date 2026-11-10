import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { canvasCommandServiceFixture } from "./support/canvasCommandServiceFixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function tableRows(database: SqliteDatabase) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','sqlite_sequence') ORDER BY name"
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => {
      if (typeof name !== "string" || !/^[a-z_]+$/.test(name)) throw new Error("unsafe_test_table");
      return [
        name,
        database
          .prepare(`SELECT * FROM ${name}`)
          .all()
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      ];
    })
  );
}

async function historicalFixture() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-shared-migration-"));
  directories.push(directory);
  const fixture = await canvasCommandServiceFixture({
    migrationVersion: 80,
    databasePath: join(directory, "server.sqlite")
  });
  const head = fixture.contentVersions.head({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default"
  })!;
  const host = new AgentHostRepository(fixture.database).register("Migration Host").host;
  fixture.database
    .prepare(`INSERT INTO canvas_runtime_leases(runtime_lease_id,host_id,workspace_id,project_id,canvas_id,attachment_version,source_revision,graph_fingerprint,expires_at,status,created_at,updated_at)
    VALUES('lease',?,'w','p','default',0,'source','fingerprint','2030-01-01','active','2026-01-01','2026-01-01')`)
    .run(host.id);
  fixture.database.exec(`INSERT INTO canvas_runtime_artifact_grants(grant_id,request_digest,runtime_lease_id,direction,artifact_ref,sha256,max_size_bytes,media_type,expires_at,created_at,updated_at)
    VALUES('grant','digest','lease','download','artifact','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',100,'text/plain','2030-01-01','2026-01-01','2026-01-01')`);
  fixture.database.exec(
    "INSERT INTO owner_canvas_materialization_scopes VALUES('owner','p','default','w','2026-01-01')"
  );
  fixture.database
    .prepare(
      `INSERT INTO owner_canvas_materialization_receipts VALUES('owner','p','default','receipt','w',?,?,1,'source','fingerprint','2026-01-01')`
    )
    .run(head.content.canonicalDigest, head.content.versionId);
  return { ...fixture, path: join(directory, "server.sqlite"), head };
}

describe("shared Prompt content member migration", () => {
  it("preserves every populated v80 row and related authority across upgrade, retry and reopened reads", async () => {
    const fixture = await historicalFixture();
    expect(centralSchemaVersion(fixture.database)).toBe(80);
    const before = tableRows(fixture.database);
    const indexes = fixture.database
      .prepare(
        "SELECT name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name"
      )
      .all();
    const content = fixture.contentVersions.readVersion(
      { workspaceId: "w", projectId: "p", canvasId: "default" },
      fixture.head.content
    );
    applyMigrations(fixture.database);
    expect(centralSchemaVersion(fixture.database)).toBe(latestCentralSchemaVersion);
    expect(tableRows(fixture.database)).toEqual(before);
    expect(
      fixture.database
        .prepare(
          "SELECT name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name"
        )
        .all()
    ).toEqual(indexes);
    expect(fixture.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(fixture.database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(() =>
      fixture.database.exec("UPDATE canvas_content_version_members SET member_kind='unrecognized'")
    ).toThrow();
    expect(() =>
      fixture.database.exec(
        "INSERT INTO canvas_content_version_members SELECT * FROM canvas_content_version_members LIMIT 1"
      )
    ).toThrow();
    applyMigrations(fixture.database);
    expect(tableRows(fixture.database)).toEqual(before);
    const reopened = await openServerDatabase(fixture.path, 5_000);
    try {
      applyMigrations(reopened);
      expect(tableRows(reopened)).toEqual(before);
      expect(
        new ContentVersionRepository(reopened).readVersion(
          { workspaceId: "w", projectId: "p", canvasId: "default" },
          fixture.head.content
        )
      ).toEqual(content);
    } finally {
      reopened.close();
    }
  });

  it("rolls table replacement and all rows back when recording v81 fails, then retries", async () => {
    const fixture = await historicalFixture();
    const before = tableRows(fixture.database);
    const schema = fixture.database
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name")
      .all();
    fixture.database.exec(
      "CREATE TRIGGER reject_shared_prompt_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=81 BEGIN SELECT RAISE(ABORT,'shared_prompt_marker_failed'); END"
    );
    expect(() => applyMigrations(fixture.database)).toThrow("shared_prompt_marker_failed");
    expect(centralSchemaVersion(fixture.database)).toBe(80);
    expect(tableRows(fixture.database)).toEqual(before);
    fixture.database.exec("DROP TRIGGER reject_shared_prompt_migration");
    expect(
      fixture.database
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name")
        .all()
    ).toEqual(schema);
    applyMigrations(fixture.database);
    expect(tableRows(fixture.database)).toEqual(before);
  });
});

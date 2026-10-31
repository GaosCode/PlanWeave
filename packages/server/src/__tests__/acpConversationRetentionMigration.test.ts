import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";

const fixtures: { directory: string; database: SqliteDatabase }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.database.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function historicalDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-conversation-retention-migration-"));
  const path = join(directory, "server.sqlite");
  const database = await openServerDatabase(path, 5_000);
  const fixture = { directory, database };
  fixtures.push(fixture);
  applyMigrationsThroughVersion(database, 76);
  const insert = database.prepare(`INSERT INTO acp_conversation_turns(
    turn_id,operation_id,actor_id,host_id,session_id,execution_attempt_id,request_json,
    status,created_at,expires_at) VALUES(?,'operation','actor','host',?,'attempt','{}',?,
    '2000-01-01T00:00:00.000Z','2000-01-01T00:15:00.000Z')`);
  for (const status of ["queued", "running", "completed", "failed", "cancelled"]) {
    insert.run(status, status, status);
  }
  database
    .prepare(
      "INSERT INTO acp_conversation_events(turn_id,sequence,event_json) VALUES('completed',1,'{}')"
    )
    .run();
  database.prepare("INSERT INTO acp_conversation_actions VALUES('action','completed','{}')").run();
  return { fixture, database, path };
}

describe("ACP conversation retention migration", () => {
  it("conservatively timestamps legacy terminal rows at migration time and preserves active rows and payloads after reopening", async () => {
    const f = await historicalDatabase();
    const oldTurns = f.database
      .prepare("SELECT * FROM acp_conversation_turns ORDER BY turn_id")
      .all();
    const oldEvents = f.database.prepare("SELECT * FROM acp_conversation_events").all();
    const oldActions = f.database.prepare("SELECT * FROM acp_conversation_actions").all();
    const before = Date.now();
    applyMigrations(f.database);
    const after = Date.now();
    expect(centralSchemaVersion(f.database)).toBe(latestCentralSchemaVersion);
    const upgraded = f.database
      .prepare("SELECT * FROM acp_conversation_turns ORDER BY turn_id")
      .all();
    for (let index = 0; index < oldTurns.length; index += 1) {
      const { terminal_at, compacted_at, ...unchanged } = upgraded[index]!;
      expect(unchanged).toEqual(oldTurns[index]);
      expect(compacted_at).toBeNull();
      if (["queued", "running"].includes(String(unchanged.status))) {
        expect(terminal_at).toBeNull();
      } else {
        const ended = Date.parse(String(terminal_at));
        expect(ended).toBeGreaterThanOrEqual(before);
        expect(ended).toBeLessThanOrEqual(after);
      }
    }
    expect(f.database.prepare("SELECT * FROM acp_conversation_events").all()).toEqual(oldEvents);
    expect(f.database.prepare("SELECT * FROM acp_conversation_actions").all()).toEqual(oldActions);
    f.database.close();
    f.fixture.database = await openServerDatabase(f.path, 5_000);
    applyMigrations(f.fixture.database);
    expect(
      f.fixture.database.prepare("SELECT * FROM acp_conversation_turns ORDER BY turn_id").all()
    ).toEqual(upgraded);
    expect(
      f.fixture.database.prepare("SELECT * FROM acp_conversation_replay_receipts").all()
    ).toEqual([]);
    expect(f.fixture.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back added columns and summary tables when recording the migration fails", async () => {
    const f = await historicalDatabase();
    f.database.exec(`CREATE TRIGGER reject_retention_version BEFORE INSERT ON schema_migrations
      WHEN NEW.version=77 BEGIN SELECT RAISE(ABORT,'retention migration interrupted'); END`);
    expect(() => applyMigrations(f.database)).toThrow("retention migration interrupted");
    expect(centralSchemaVersion(f.database)).toBe(76);
    expect(
      f.database
        .prepare("PRAGMA table_info(acp_conversation_turns)")
        .all()
        .some((row) => row.name === "terminal_at")
    ).toBe(false);
    expect(
      f.database
        .prepare("SELECT name FROM sqlite_master WHERE name='acp_conversation_replay_receipts'")
        .all()
    ).toEqual([]);
    f.database.exec("DROP TRIGGER reject_retention_version");
    applyMigrations(f.database);
    expect(centralSchemaVersion(f.database)).toBe(latestCentralSchemaVersion);
  });
});

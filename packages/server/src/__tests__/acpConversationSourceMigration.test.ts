import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { applyMigrations, centralSchemaVersion } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";

const fixtures: { database: SqliteDatabase; directory: string }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function historicalDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-acp-source-"));
  const path = join(directory, "server.sqlite");
  const database = await openServerDatabase(path, 5_000);
  const fixture = { database, directory };
  fixtures.push(fixture);
  applyMigrationsThroughVersion(database, 78);
  const host = new AgentHostRepository(database).register("Source migration Host").host;
  return { database, host, fixture, path };
}

describe("ACP source command index migration", () => {
  it("upgrades v78 without changing messages or Host delivery cursors across reinitialization and reopening", async () => {
    const { database, host, fixture, path } = await historicalDatabase();
    database
      .prepare(`INSERT INTO mailbox_messages(
        message_id,host_id,command_json,created_at,acknowledged_at,published_at,previous_sequence)
        VALUES('source',?,?,'2030-01-01','2030-01-02','2030-01-01',0)`)
      .run(host.id, JSON.stringify({ type: "execute_block", executionAttemptId: "attempt" }));
    database.prepare("UPDATE agent_hosts SET last_acknowledged_sequence=1 WHERE id=?").run(host.id);
    const messages = database.prepare("SELECT * FROM mailbox_messages").all();
    const hosts = database.prepare("SELECT * FROM agent_hosts").all();

    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(79);
    const markers = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    applyMigrations(database);
    expect(database.prepare("SELECT * FROM mailbox_messages").all()).toEqual(messages);
    expect(database.prepare("SELECT * FROM agent_hosts").all()).toEqual(hosts);
    expect(database.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(
      markers
    );
    database.close();
    fixture.database = await openServerDatabase(path, 5_000);
    const reopened = fixture.database;
    applyMigrations(reopened);
    expect(reopened.prepare("SELECT * FROM mailbox_messages").all()).toEqual(messages);
    expect(reopened.prepare("SELECT * FROM agent_hosts").all()).toEqual(hosts);
    expect(reopened.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(
      markers
    );
    expect(reopened.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  });

  it("rolls back the new index if its migration marker fails and can retry without changing rows", async () => {
    const { database, host } = await historicalDatabase();
    database
      .prepare(`INSERT INTO mailbox_messages(message_id,host_id,command_json,created_at)
      VALUES('pending-source',?,?,'2030-01-01')`)
      .run(host.id, JSON.stringify({ type: "execute_block", executionAttemptId: "attempt" }));
    const messages = database.prepare("SELECT * FROM mailbox_messages").all();
    database.exec(`CREATE TRIGGER reject_source_migration BEFORE INSERT ON schema_migrations
      WHEN NEW.version=79 BEGIN SELECT RAISE(ABORT,'source_marker_failed'); END`);
    expect(() => applyMigrations(database)).toThrow("source_marker_failed");
    expect(centralSchemaVersion(database)).toBe(78);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='idx_mailbox_host_execution_attempt_sequence'"
        )
        .get()
    ).toBeUndefined();
    expect(database.prepare("SELECT * FROM mailbox_messages").all()).toEqual(messages);
    database.exec("DROP TRIGGER reject_source_migration");
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(79);
    expect(database.prepare("SELECT * FROM mailbox_messages").all()).toEqual(messages);
  });

  it("reports the corrupt legacy message and leaves the migration unapplied", async () => {
    const { database, host } = await historicalDatabase();
    database
      .prepare(`INSERT INTO mailbox_messages(message_id,host_id,command_json,created_at)
        VALUES('corrupt-source',?,'{broken','2030-01-01')`)
      .run(host.id);
    const messages = database.prepare("SELECT * FROM mailbox_messages").all();

    expect(() => applyMigrations(database)).toThrow(
      "mailbox_command_json_invalid:sequence=1:message_id=corrupt-source"
    );
    expect(centralSchemaVersion(database)).toBe(78);
    expect(database.prepare("SELECT * FROM mailbox_messages").all()).toEqual(messages);
  });
});

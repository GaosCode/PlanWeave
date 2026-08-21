import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("HumanObserverJournal", () => {
  const projectA = { workspaceId: "workspace-a", projectId: "project-a" };
  const projectB = { workspaceId: "workspace-b", projectId: "project-a" };

  it("upgrades v37 observer rows into a scoped journal and quarantines ambiguous projects", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    database.exec(`
      DROP TABLE human_observer_events_unscoped_legacy;
      DROP INDEX idx_human_observer_workspace_project_cursor;
      DROP TABLE human_observer_events;
      CREATE TABLE human_observer_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        previous_cursor INTEGER NOT NULL CHECK(previous_cursor >= 0),
        event_json TEXT NOT NULL CHECK(json_valid(event_json)),
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX idx_human_observer_project_cursor
        ON human_observer_events(project_id,cursor);
    `);
    database.prepare("DELETE FROM schema_migrations WHERE version=38").run();
    database.exec(`
      INSERT INTO workspaces(workspace_id,display_name,created_at,archived_at) VALUES
        ('workspace-unique','Workspace unique','2026-01-01T00:00:00.000Z',NULL),
        ('workspace-a','Workspace A','2026-01-01T00:00:00.000Z',NULL),
        ('workspace-b','Workspace B','2026-01-01T00:00:00.000Z',NULL);
      INSERT INTO project_registry(
        project_registry_id,workspace_id,project_id,project_root_internal,visibility,
        owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at
      ) VALUES
        ('registry-unique','workspace-unique','project-unique',NULL,'private',NULL,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
        ('registry-a','workspace-a','project-ambiguous',NULL,'private',NULL,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
        ('registry-b','workspace-b','project-ambiguous',NULL,'private',NULL,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
      INSERT INTO human_observer_events(project_id,previous_cursor,event_json,occurred_at) VALUES
        ('project-unique',0,'{"kind":"membership"}','2026-01-01T00:00:00.000Z'),
        ('project-ambiguous',0,'{"kind":"membership"}','2026-01-01T00:00:00.000Z');
    `);

    applyMigrations(database);

    expect(
      database.prepare("SELECT version FROM schema_migrations WHERE version=38").get()?.version
    ).toBe(38);
    expect(
      database.prepare("SELECT workspace_id,project_id FROM human_observer_events").all()
    ).toEqual([{ workspace_id: "workspace-unique", project_id: "project-unique" }]);
    expect(
      database.prepare("SELECT project_id FROM human_observer_events_unscoped_legacy").all()
    ).toEqual([{ project_id: "project-ambiguous" }]);
  });

  it("isolates identical project IDs across workspaces for head, replay, retention, and subscriptions", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    expect(latestCentralSchemaVersion).toBe(53);
    const journal = new HumanObserverJournal(database, 2);

    const first = journal.appendInCallerTransaction(projectA, { kind: "membership" });
    const other = journal.appendInCallerTransaction(projectB, { kind: "invitation" });
    const second = journal.appendInCallerTransaction(projectA, { kind: "assignment" });
    const third = journal.appendInCallerTransaction(projectA, { kind: "comment" });
    const fourth = journal.appendInCallerTransaction(projectA, { kind: "activity" });

    expect([first.cursor, other.cursor, second.cursor, third.cursor, fourth.cursor]).toEqual([
      1, 2, 3, 4, 5
    ]);
    expect(second.previousCursor).toBe(first.cursor);
    expect(third.previousCursor).toBe(second.cursor);
    expect(journal.replay(projectB, other.cursor)).toEqual({
      kind: "events",
      headCursor: other.cursor,
      events: []
    });
    expect(journal.replay(projectA, first.cursor)).toMatchObject({
      kind: "gap",
      reason: "retention_gap",
      headCursor: fourth.cursor,
      droppedThroughCursor: second.cursor
    });
    expect(journal.replay(projectA, second.cursor)).toMatchObject({
      kind: "events",
      events: [
        { cursor: third.cursor, previousCursor: second.cursor },
        { cursor: fourth.cursor, previousCursor: third.cursor }
      ]
    });
    expect(journal.replay(projectA, fourth.cursor + 1)).toMatchObject({
      kind: "gap",
      reason: "cursor_ahead",
      headCursor: fourth.cursor
    });

    const observed: number[] = [];
    const rollbackScope = { workspaceId: "workspace-rollback", projectId: "project-rollback" };
    journal.subscribe(rollbackScope, (event) => observed.push(event.cursor));
    database.exec("BEGIN IMMEDIATE");
    journal.appendInCallerTransaction(rollbackScope, { kind: "project" });
    database.exec("ROLLBACK");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observed).toEqual([]);
    expect(journal.head(rollbackScope)).toBe(0);
  });

  it("requires authoritative catch-up when replay exceeds event or byte limits", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, 10);
    const first = journal.appendInCallerTransaction(projectA, { kind: "membership" });
    journal.appendInCallerTransaction(projectA, { kind: "invitation" });
    const head = journal.appendInCallerTransaction(projectA, { kind: "assignment" });

    expect(journal.replay(projectA, first.cursor, { maxEvents: 1, maxBytes: 100_000 })).toEqual({
      kind: "gap",
      reason: "reset",
      headCursor: head.cursor
    });
    expect(journal.replay(projectA, first.cursor, { maxEvents: 10, maxBytes: 1 })).toEqual({
      kind: "gap",
      reason: "reset",
      headCursor: head.cursor
    });
  });

  it("applies the replay byte budget exactly across accumulated serialized events", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, 10);
    const anchor = journal.appendInCallerTransaction(projectA, { kind: "membership" });
    const detailed = journal.appendInCallerTransaction(projectA, {
      kind: "membership",
      humanPrincipalId: "observer-principal"
    });
    const detailedBytes = Buffer.byteLength(JSON.stringify(detailed), "utf8");
    expect(
      journal.replay(projectA, anchor.cursor, { maxEvents: 10, maxBytes: detailedBytes })
    ).toEqual({
      kind: "events",
      headCursor: detailed.cursor,
      events: [detailed]
    });

    const following = journal.appendInCallerTransaction(projectA, { kind: "invitation" });
    const cumulativeBytes = detailedBytes + Buffer.byteLength(JSON.stringify(following), "utf8");
    expect(
      journal.replay(projectA, anchor.cursor, { maxEvents: 10, maxBytes: cumulativeBytes })
    ).toEqual({
      kind: "events",
      headCursor: following.cursor,
      events: [detailed, following]
    });
    expect(
      journal.replay(projectA, anchor.cursor, {
        maxEvents: 10,
        maxBytes: cumulativeBytes - 1
      })
    ).toEqual({ kind: "gap", reason: "reset", headCursor: following.cursor });
  });
});

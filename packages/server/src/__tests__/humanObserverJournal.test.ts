import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("HumanObserverJournal", () => {
  const projectA = { workspaceId: "workspace-a", projectId: "project-a" };
  const projectB = { workspaceId: "workspace-b", projectId: "project-a" };

  it("upgrades v37 observer rows into a scoped journal and quarantines ambiguous projects", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrationsThroughVersion(database, 37);
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
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
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

  it.each([
    1, 3
  ])("keeps cap=%i exact across scopes, journal instances and outer rollback", async (cap) => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, cap);
    const otherJournal = new HumanObserverJournal(database, cap);
    const thirdScope = { ...projectA, projectId: "project-other" };
    const observed: number[] = [];
    journal.subscribe(projectA, (event) => observed.push(event.cursor));
    let previous = 0;
    for (let i = 0; i < cap + 2; i++) {
      inWriteTransaction(database, () => {
        const event = (i % 2 ? otherJournal : journal).appendInCallerTransaction(projectA, {
          kind: "membership"
        });
        expect(event.previousCursor).toBe(previous);
        previous = event.cursor;
        journal.appendInCallerTransaction(projectB, { kind: "project" });
        journal.appendInCallerTransaction(thirdScope, { kind: "invitation" });
      });
    }
    const retained = () =>
      database
        .prepare(
          "SELECT workspace_id,project_id,retained_count FROM human_observer_retention ORDER BY workspace_id,project_id"
        )
        .all();
    const expected = [
      { workspace_id: projectA.workspaceId, project_id: projectA.projectId, retained_count: cap },
      {
        workspace_id: thirdScope.workspaceId,
        project_id: thirdScope.projectId,
        retained_count: cap
      },
      { workspace_id: projectB.workspaceId, project_id: projectB.projectId, retained_count: cap }
    ];
    expect(retained()).toEqual(expected);
    const rowsBefore = database
      .prepare("SELECT * FROM human_observer_events ORDER BY cursor")
      .all();
    expect(rowsBefore).toHaveLength(cap * 3);
    expect(() =>
      inWriteTransaction(database, () => {
        journal.appendInCallerTransaction(projectA, { kind: "comment" });
        otherJournal.appendInCallerTransaction(projectA, { kind: "activity" });
        expect(retained()).toEqual(expected);
        throw new Error("outer_transaction_failed");
      })
    ).toThrow("outer_transaction_failed");
    expect(retained()).toEqual(expected);
    expect(database.prepare("SELECT * FROM human_observer_events ORDER BY cursor").all()).toEqual(
      rowsBefore
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observed.every((cursor) => rowsBefore.some((row) => row.cursor === cursor))).toBe(true);
    const next = inWriteTransaction(database, () =>
      journal.appendInCallerTransaction(projectA, { kind: "assignment" })
    );
    expect(next.previousCursor).toBe(previous);
    expect(retained()).toEqual(expected);
    const firstRetained = database
      .prepare(
        "SELECT previous_cursor FROM human_observer_events WHERE workspace_id=? AND project_id=? ORDER BY cursor LIMIT 1"
      )
      .get(projectA.workspaceId, projectA.projectId);
    expect(journal.replay(projectA, Number(firstRetained?.previous_cursor))).toMatchObject({
      kind: "events",
      headCursor: next.cursor
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observed).toContain(next.cursor);
  });

  it("migrates nonempty scoped history atomically and keeps counts across delete, restart and connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-observer-retention-"));
    directories.push(directory);
    const path = join(directory, "server.sqlite");
    const database = await openServerDatabase(path, 5_000);
    databases.push(database);
    applyMigrationsThroughVersion(database, 74);
    database.exec(`
      INSERT INTO human_observer_events(cursor,workspace_id,project_id,previous_cursor,event_json,occurred_at) VALUES
        (1,'workspace-a','project-a',0,'{"kind":"membership"}','2026-01-01T00:00:00.000Z'),
        (2,'workspace-b','project-a',0,'{"kind":"project"}','2026-01-01T00:00:00.000Z'),
        (3,'workspace-a','project-a',1,'{"kind":"activity"}','2026-01-01T00:00:00.000Z');
      INSERT INTO human_observer_events_unscoped_legacy VALUES
        (4,'project-a',0,'{"kind":"membership"}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      CREATE TRIGGER fail_retention_marker BEFORE INSERT ON schema_migrations WHEN NEW.version=75
      BEGIN SELECT RAISE(ABORT, 'retention_migration_interrupted'); END;
    `);
    expect(() => applyMigrations(database)).toThrow("retention_migration_interrupted");
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name='human_observer_retention'").get()
    ).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM human_observer_events").get()).toEqual({
      count: 3
    });
    database.exec("DROP TRIGGER fail_retention_marker");
    applyMigrations(database);
    expect(
      database
        .prepare("SELECT retained_count FROM human_observer_retention ORDER BY workspace_id")
        .all()
    ).toEqual([{ retained_count: 2 }, { retained_count: 1 }]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM human_observer_events_unscoped_legacy").get()
    ).toEqual({ count: 1 });
    const journal = new HumanObserverJournal(database, 1);
    const appended = inWriteTransaction(database, () =>
      journal.appendInCallerTransaction(projectA, { kind: "comment" })
    );
    expect(appended.previousCursor).toBe(3);
    expect(
      database.prepare("SELECT cursor FROM human_observer_events ORDER BY cursor").all()
    ).toEqual([{ cursor: 2 }, { cursor: appended.cursor }]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = await openServerDatabase(path, 5_000);
    const secondConnection = await openServerDatabase(path, 5_000);
    databases.push(reopened, secondConnection);
    applyMigrations(reopened);
    const next = inWriteTransaction(reopened, () =>
      new HumanObserverJournal(reopened, 1).appendInCallerTransaction(projectA, {
        kind: "assignment"
      })
    );
    const latest = inWriteTransaction(secondConnection, () =>
      new HumanObserverJournal(secondConnection, 1).appendInCallerTransaction(projectA, {
        kind: "activity"
      })
    );
    expect([next.previousCursor, latest.previousCursor]).toEqual([appended.cursor, next.cursor]);
    expect(
      reopened.prepare("SELECT cursor FROM human_observer_events ORDER BY cursor").all()
    ).toEqual([{ cursor: 2 }, { cursor: latest.cursor }]);
    expect(() =>
      inWriteTransaction(reopened, () => {
        reopened
          .prepare("DELETE FROM human_observer_events WHERE workspace_id=?")
          .run(projectB.workspaceId);
        throw new Error("delete_rolled_back");
      })
    ).toThrow("delete_rolled_back");
    expect(
      secondConnection
        .prepare("SELECT retained_count FROM human_observer_retention WHERE workspace_id=?")
        .get(projectB.workspaceId)
    ).toEqual({ retained_count: 1 });
    inWriteTransaction(secondConnection, () =>
      secondConnection
        .prepare("DELETE FROM human_observer_events WHERE workspace_id=?")
        .run(projectB.workspaceId)
    );
    expect(
      reopened
        .prepare("SELECT retained_count FROM human_observer_retention WHERE workspace_id=?")
        .get(projectB.workspaceId)
    ).toEqual({ retained_count: 0 });
    const replacement = inWriteTransaction(reopened, () =>
      new HumanObserverJournal(reopened, 1).appendInCallerTransaction(projectB, { kind: "project" })
    );
    expect(replacement.previousCursor).toBe(0);
    expect(
      reopened
        .prepare("SELECT retained_count FROM human_observer_retention ORDER BY workspace_id")
        .all()
    ).toEqual([{ retained_count: 1 }, { retained_count: 1 }]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
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

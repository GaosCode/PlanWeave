import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { applyMigrations } from "../migrations.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];
const scope = { workspaceId: "workspace-commit", projectId: "project-commit" };
const occurredAt = "2026-10-20T00:00:00.000Z";
const flushDelivery = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

describe("HumanObserverJournal commit boundary", () => {
  it.each([
    1, 3
  ])("does not deliver rolled-back events when a new transaction reuses identical cursors at cap=%i", async (cap) => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, cap);
    const first = inWriteTransaction(database, () =>
      journal.appendInCallerTransaction(scope, { kind: "membership" }, occurredAt)
    );
    await flushDelivery();
    const observed: number[] = [];
    journal.subscribe(scope, (event) => observed.push(event.cursor));
    const before = database.prepare("SELECT * FROM human_observer_events").all();
    const counts = database.prepare("SELECT * FROM human_observer_retention").all();

    for (const appendCount of [1, cap + 1]) {
      expect(() =>
        inWriteTransaction(database, () => {
          for (let index = 0; index < appendCount; index++) {
            journal.appendInCallerTransaction(scope, { kind: "membership" }, occurredAt);
          }
          throw new Error("caller_failed");
        })
      ).toThrow("caller_failed");
      expect(database.prepare("SELECT * FROM human_observer_events").all()).toEqual(before);
      expect(database.prepare("SELECT * FROM human_observer_retention").all()).toEqual(counts);
      expect(journal.head(scope)).toBe(first.cursor);
      expect(journal.replay(scope, first.cursor)).toEqual({
        kind: "events",
        headCursor: first.cursor,
        events: []
      });
    }

    // Commit before queued delivery runs: SQLite reuses a rolled-back AUTOINCREMENT cursor.
    const committed = inWriteTransaction(database, () =>
      journal.appendInCallerTransaction(scope, { kind: "membership" }, occurredAt)
    );
    expect(committed.cursor).toBe(first.cursor + 1);
    await flushDelivery();
    expect(observed).toEqual([committed.cursor]);
    expect(journal.replay(scope, first.cursor)).toEqual({
      kind: "events",
      headCursor: committed.cursor,
      events: [committed]
    });
  });

  it("does not confuse a raw rolled-back transaction with a second connection's identical commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-observer-commit-"));
    directories.push(directory);
    const path = join(directory, "server.sqlite");
    const firstDatabase = await openServerDatabase(path, 5_000);
    const secondDatabase = await openServerDatabase(path, 5_000);
    databases.push(firstDatabase, secondDatabase);
    applyMigrations(firstDatabase);
    const firstJournal = new HumanObserverJournal(firstDatabase, 3);
    const secondJournal = new HumanObserverJournal(secondDatabase, 3);
    const observed: number[] = [];
    firstJournal.subscribe(scope, (event) => observed.push(event.cursor));
    firstDatabase.exec("BEGIN IMMEDIATE");
    const rolledBack = firstJournal.appendInCallerTransaction(
      scope,
      { kind: "project" },
      occurredAt
    );
    firstDatabase.exec("ROLLBACK");
    const committed = inWriteTransaction(secondDatabase, () =>
      secondJournal.appendInCallerTransaction(scope, { kind: "project" }, occurredAt)
    );
    expect(committed).toEqual(rolledBack);
    await flushDelivery();
    expect(observed).toEqual([]);
    expect(firstJournal.head(scope)).toBe(committed.cursor);
    expect(
      firstDatabase.prepare("SELECT retained_count FROM human_observer_retention").all()
    ).toEqual([{ retained_count: 1 }]);
  });

  it("commits two same-scope events atomically and replays the exact count boundary", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const journal = new HumanObserverJournal(database, 3);
    const anchor = inWriteTransaction(database, () =>
      journal.appendInCallerTransaction(scope, { kind: "project" })
    );
    await flushDelivery();
    const observed: number[] = [];
    journal.subscribe(scope, (event) => observed.push(event.cursor));
    const committed = inWriteTransaction(database, () => [
      journal.appendInCallerTransaction(scope, { kind: "membership" }),
      journal.appendInCallerTransaction(scope, { kind: "activity" })
    ]);
    expect(observed).toEqual([]);
    expect(committed.map((event) => event.previousCursor)).toEqual([
      anchor.cursor,
      committed[0]!.cursor
    ]);
    const limits = { maxEvents: 2, maxBytes: 100_000 };
    expect(journal.replay(scope, anchor.cursor, limits)).toEqual({
      kind: "events",
      headCursor: committed[1]!.cursor,
      events: committed
    });
    expect(journal.replay(scope, anchor.cursor, { ...limits, maxEvents: 1 })).toEqual({
      kind: "gap",
      reason: "reset",
      headCursor: committed[1]!.cursor
    });
    await flushDelivery();
    expect(observed).toEqual(committed.map((event) => event.cursor));
  });
});

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export type SqliteStatement = {
  run(...values: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Array<Record<string, unknown>>;
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

const require = createRequire(import.meta.url);

function databaseConstructor(): new (
  path: string,
  options?: { readOnly?: boolean }
) => SqliteDatabase {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
  };
  return DatabaseSync;
}

export async function openAgentHostDatabase(
  path: string,
  busyTimeoutMs: number
): Promise<SqliteDatabase> {
  await mkdir(dirname(path), { recursive: true });
  const DatabaseSync = databaseConstructor();
  const database = new DatabaseSync(path);
  database.exec(
    `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`
  );
  return database;
}

export function openReadonlyAgentHostDatabase(path: string, busyTimeoutMs: number): SqliteDatabase {
  const DatabaseSync = databaseConstructor();
  const database = new DatabaseSync(path, { readOnly: true });
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
  return database;
}

// Only the transaction owner can release an outbox hint after a durable commit.
const pendingOutboxNotifications = new WeakMap<SqliteDatabase, Set<() => void>>();

export function notifyOutboxAfterCommit(database: SqliteDatabase, notify: () => void): void {
  const pending = pendingOutboxNotifications.get(database);
  if (pending) pending.add(notify);
  else notify();
}

export function inWriteTransaction<T>(database: SqliteDatabase, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  const notifications = new Set<() => void>();
  pendingOutboxNotifications.set(database, notifications);
  let result: T;
  try {
    result = action();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    pendingOutboxNotifications.delete(database);
  }
  for (const notify of notifications) notify();
  return result;
}

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export type SqliteStatement = { run(...values: unknown[]): { lastInsertRowid: number | bigint; changes: number }; get(...values: unknown[]): Record<string, unknown> | undefined; all(...values: unknown[]): Array<Record<string, unknown>> };
export type SqliteDatabase = { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void };
const require = createRequire(import.meta.url);

export async function openServerDatabase(path: string, busyTimeoutMs: number): Promise<SqliteDatabase> {
  await mkdir(dirname(path), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
  return database;
}

export function inWriteTransaction<T>(database: SqliteDatabase, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; }
}

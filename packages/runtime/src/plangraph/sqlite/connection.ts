import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { isRecord } from "./columns.js";

export type SqliteRunResult = {
  lastInsertRowid: number | bigint;
};

export type SqliteStatement = {
  run(...values: unknown[]): SqliteRunResult;
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Array<Record<string, unknown>>;
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteModule = {
  DatabaseSync: new (location: string) => SqliteDatabase;
};

const nodeRequire = createRequire(import.meta.url);

function isSqliteModule(value: unknown): value is SqliteModule {
  return isRecord(value) && typeof value.DatabaseSync === "function";
}

function loadSqliteModule(): SqliteModule {
  const moduleValue: unknown = nodeRequire("node:sqlite");
  if (!isSqliteModule(moduleValue)) {
    throw new Error("node:sqlite module did not expose DatabaseSync.");
  }
  return moduleValue;
}

export async function openDatabase(indexPath: string): Promise<SqliteDatabase> {
  await mkdir(dirname(indexPath), { recursive: true });
  const sqlite = loadSqliteModule();
  const db = new sqlite.DatabaseSync(indexPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

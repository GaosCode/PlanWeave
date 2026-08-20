import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function migratedDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  return database;
}

describe("remote operation retention migration", () => {
  it("replays idempotently when the existing v49 objects have the expected shape", async () => {
    const database = await migratedDatabase();
    database.prepare("DELETE FROM schema_migrations WHERE version=49").run();

    expect(() => applyMigrations(database)).not.toThrow();
    expect(
      database.prepare("SELECT version FROM schema_migrations WHERE version=49").get()?.version
    ).toBe(49);
    expect(latestCentralSchemaVersion).toBe(52);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    "table",
    "index"
  ])("rejects a conflicting same-named %s instead of accepting it as migrated", async (objectKind) => {
    const database = await migratedDatabase();
    database.prepare("DELETE FROM schema_migrations WHERE version=49").run();
    if (objectKind === "table") {
      database.exec(`
          DROP TABLE remote_operation_retention_receipts;
          CREATE TABLE remote_operation_retention_receipts(operation_id TEXT PRIMARY KEY);
        `);
    } else {
      database.exec(`
          DROP INDEX idx_remote_operation_retention_scope_terminal;
          CREATE INDEX idx_remote_operation_retention_scope_terminal ON remote_operations(id);
        `);
    }

    expect(() => applyMigrations(database)).toThrow(
      `remote_operation_retention_schema_invalid:${objectKind === "table" ? "receipt_columns" : "scope_index"}`
    );
    expect(
      database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version=49").get()
    ).toBeUndefined();
  });

  it("rejects a same-shaped receipt table with cascading operation deletion", async () => {
    const database = await migratedDatabase();
    database.prepare("DELETE FROM schema_migrations WHERE version=49").run();
    const createSql = database
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type='table' AND name='remote_operation_retention_receipts'`
      )
      .get()?.sql;
    expect(typeof createSql).toBe("string");
    database.exec("DROP TABLE remote_operation_retention_receipts");
    database.exec(
      String(createSql).replace(
        "REFERENCES remote_operations(id)",
        "REFERENCES remote_operations(id) ON DELETE CASCADE"
      )
    );

    expect(() => applyMigrations(database)).toThrow(
      "remote_operation_retention_schema_invalid:receipt_foreign_key"
    );
    expect(
      database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version=49").get()
    ).toBeUndefined();
  });

  it("rejects a unique partial scope index with otherwise identical shape", async () => {
    const database = await migratedDatabase();
    database.prepare("DELETE FROM schema_migrations WHERE version=49").run();
    database.exec(`
      DROP INDEX idx_remote_operation_retention_scope_terminal;
      CREATE UNIQUE INDEX idx_remote_operation_retention_scope_terminal
        ON remote_operations(workspace_id,project_id,canvas_id,terminal_at DESC,id DESC)
        WHERE state IN ('completed','failed','cancelled');
    `);

    expect(() => applyMigrations(database)).toThrow(
      "remote_operation_retention_schema_invalid:scope_index"
    );
    expect(
      database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version=49").get()
    ).toBeUndefined();
  });

  it("rejects an otherwise identical receipt table with an extra column constraint", async () => {
    const database = await migratedDatabase();
    database.prepare("DELETE FROM schema_migrations WHERE version=49").run();
    const createSql = database
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type='table' AND name='remote_operation_retention_receipts'`
      )
      .get()?.sql;
    expect(typeof createSql).toBe("string");
    database.exec("DROP TABLE remote_operation_retention_receipts");
    database.exec(
      String(createSql).replace(
        "workspace_id TEXT NOT NULL,",
        "workspace_id TEXT NOT NULL CHECK(workspace_id='blocked'),"
      )
    );

    expect(() => applyMigrations(database)).toThrow(
      "remote_operation_retention_schema_invalid:receipt_definition"
    );
    expect(
      database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version=49").get()
    ).toBeUndefined();
  });

  it("rejects an otherwise identical partial index with a narrower predicate", async () => {
    const database = await migratedDatabase();
    database.prepare("DELETE FROM schema_migrations WHERE version=49").run();
    database.exec(`
      DROP INDEX idx_remote_operation_retention_scope_terminal;
      CREATE INDEX idx_remote_operation_retention_scope_terminal
        ON remote_operations(workspace_id,project_id,canvas_id,terminal_at DESC,id DESC)
        WHERE state IN ('completed','failed','cancelled')
          AND terminal_at<'2020-01-01T00:00:00.000Z';
    `);

    expect(() => applyMigrations(database)).toThrow(
      "remote_operation_retention_schema_invalid:scope_index"
    );
    expect(
      database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version=49").get()
    ).toBeUndefined();
  });
});

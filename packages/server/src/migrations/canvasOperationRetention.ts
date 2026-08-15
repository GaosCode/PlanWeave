import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

const receiptTableSql = `
CREATE TABLE IF NOT EXISTS canvas_command_operation_receipts (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
  outcome_json TEXT NOT NULL CHECK(length(CAST(outcome_json AS BLOB)) <= 4096),
  terminal_sequence INTEGER NOT NULL CHECK(terminal_sequence > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, operation_id),
  UNIQUE(workspace_id, project_id, canvas_id, terminal_sequence)
)
`;

const scopeTableSql = `
CREATE TABLE IF NOT EXISTS canvas_command_operation_retention_scopes (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  high_water_sequence INTEGER NOT NULL CHECK(high_water_sequence >= 0),
  retained_from_sequence INTEGER NOT NULL CHECK(
    retained_from_sequence >= 1 AND retained_from_sequence <= high_water_sequence + 1
  ),
  status TEXT NOT NULL CHECK(status IN ('reconciling','ready','repair_required')),
  failure_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id),
  CHECK((status='repair_required') = (failure_code IS NOT NULL))
)
`;

const pendingTableSql = `
CREATE TABLE IF NOT EXISTS canvas_command_pending_scopes (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  intent_json TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','local_admin','system')),
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  reserved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('applying','needs_recovery')),
  PRIMARY KEY(workspace_id, project_id, canvas_id)
)
`;

export const canvasOperationRetentionMigrationSql = `${receiptTableSql};${scopeTableSql};${pendingTableSql};`;

const expectedColumns = {
  canvas_command_operation_receipts: [
    ["workspace_id", "TEXT", 1, null, 1],
    ["project_id", "TEXT", 1, null, 2],
    ["canvas_id", "TEXT", 1, null, 3],
    ["operation_id", "TEXT", 1, null, 4],
    ["intent_digest", "TEXT", 1, null, 0],
    ["outcome_json", "TEXT", 1, null, 0],
    ["terminal_sequence", "INTEGER", 1, null, 0],
    ["created_at", "TEXT", 1, null, 0]
  ],
  canvas_command_operation_retention_scopes: [
    ["workspace_id", "TEXT", 1, null, 1],
    ["project_id", "TEXT", 1, null, 2],
    ["canvas_id", "TEXT", 1, null, 3],
    ["high_water_sequence", "INTEGER", 1, null, 0],
    ["retained_from_sequence", "INTEGER", 1, null, 0],
    ["status", "TEXT", 1, null, 0],
    ["failure_code", "TEXT", 0, null, 0],
    ["updated_at", "TEXT", 1, null, 0]
  ],
  canvas_command_pending_scopes: [
    ["workspace_id", "TEXT", 1, null, 1],
    ["project_id", "TEXT", 1, null, 2],
    ["canvas_id", "TEXT", 1, null, 3],
    ["operation_id", "TEXT", 1, null, 0],
    ["expected_revision", "INTEGER", 1, null, 0],
    ["intent_json", "TEXT", 1, null, 0],
    ["intent_digest", "TEXT", 1, null, 0],
    ["actor_kind", "TEXT", 1, null, 0],
    ["actor_id", "TEXT", 1, null, 0],
    ["actor_display_name", "TEXT", 0, null, 0],
    ["reserved_at", "TEXT", 1, null, 0],
    ["status", "TEXT", 1, null, 0]
  ]
} as const;

const expectedDefinitions = {
  canvas_command_operation_receipts: receiptTableSql,
  canvas_command_operation_retention_scopes: scopeTableSql,
  canvas_command_pending_scopes: pendingTableSql
} as const;

const expectedUniqueIndexes = {
  canvas_command_operation_receipts: [
    { origin: "pk", columns: "workspace_id,project_id,canvas_id,operation_id" },
    { origin: "u", columns: "workspace_id,project_id,canvas_id,terminal_sequence" }
  ],
  canvas_command_operation_retention_scopes: [
    { origin: "pk", columns: "workspace_id,project_id,canvas_id" }
  ],
  canvas_command_pending_scopes: [{ origin: "pk", columns: "workspace_id,project_id,canvas_id" }]
} as const;

function canonicalSql(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").replace("ifnotexists", "").replace(/;$/, "");
}

export function validateCanvasOperationRetentionSchema(database: SqliteDatabase): void {
  for (const table of Object.keys(expectedColumns) as Array<keyof typeof expectedColumns>) {
    const columns = expectedColumns[table];
    const actual = database.prepare(`PRAGMA table_info(${table})`).all();
    if (
      actual.length !== columns.length ||
      actual.some((column, index) => {
        const expected = columns[index];
        return (
          column.name !== expected?.[0] ||
          column.type !== expected[1] ||
          column.notnull !== expected[2] ||
          (column.dflt_value ?? null) !== expected[3] ||
          column.pk !== expected[4]
        );
      })
    ) {
      throw new Error(`canvas_operation_retention_schema_invalid:${table}:columns`);
    }
    const definition = database
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)?.sql;
    if (
      typeof definition !== "string" ||
      canonicalSql(definition) !== canonicalSql(expectedDefinitions[table])
    ) {
      throw new Error(`canvas_operation_retention_schema_invalid:${table}:definition`);
    }
    const actualUniqueIndexes = database
      .prepare(`PRAGMA index_list(${table})`)
      .all()
      .filter((index) => index.unique === 1)
      .map((index) => ({
        origin: String(index.origin),
        partial: Number(index.partial),
        columns: database
          .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(String(index.name))
          .map((column) => String(column.name))
          .join(",")
      }))
      .sort((left, right) => left.origin.localeCompare(right.origin));
    const expectedIndexes = [...expectedUniqueIndexes[table]]
      .map((index) => ({ origin: index.origin, partial: 0, columns: index.columns }))
      .sort((left, right) => left.origin.localeCompare(right.origin));
    if (JSON.stringify(actualUniqueIndexes) !== JSON.stringify(expectedIndexes)) {
      throw new Error(`canvas_operation_retention_schema_invalid:${table}:indexes`);
    }
  }
}

export const canvasOperationRetentionMigration: Migration = {
  version: 50,
  sql: canvasOperationRetentionMigrationSql,
  after: validateCanvasOperationRetentionSchema
};

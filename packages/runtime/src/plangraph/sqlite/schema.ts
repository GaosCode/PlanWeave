import { isRecord } from "./columns.js";
import type { SqliteDatabase } from "./connection.js";

const sqliteIndexDefinitions = [
  {
    name: "idx_operation_log_undo_redo",
    sql: "CREATE INDEX IF NOT EXISTS idx_operation_log_undo_redo ON operation_log (project_root, undone_at DESC, id ASC)"
  },
  {
    name: "idx_edges_project_order",
    sql: "CREATE INDEX IF NOT EXISTS idx_edges_project_order ON edges (project_root, edge_type, from_ref, to_ref)"
  }
] as const;

export function ensureSchema(db: SqliteDatabase): void {
  const projectionVersionsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_versions'").get();
  if (projectionVersionsTable) {
    const columns = db.prepare("PRAGMA table_info(projection_versions)").all();
    const cacheKeyColumn = columns.find((column) => isRecord(column) && column.name === "cache_key");
    const cacheKeyPrimaryKeyPosition = isRecord(cacheKeyColumn) ? cacheKeyColumn.pk : null;
    if (cacheKeyPrimaryKeyPosition !== 3) {
      db.exec("DROP TABLE projection_versions");
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_meta (
      project_root TEXT PRIMARY KEY,
      package_fingerprint TEXT NOT NULL,
      graph_version TEXT NOT NULL,
      project_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      project_root TEXT NOT NULL,
      task_id TEXT NOT NULL,
      canvas_id TEXT,
      title TEXT NOT NULL,
      prompt_path TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_preview TEXT NOT NULL,
      executor TEXT,
      acceptance_json TEXT NOT NULL,
      block_refs_json TEXT NOT NULL,
      PRIMARY KEY (project_root, task_id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      project_root TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      task_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt_path TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_preview TEXT NOT NULL,
      executor TEXT,
      depends_on_json TEXT NOT NULL,
      PRIMARY KEY (project_root, block_ref)
    );

    CREATE TABLE IF NOT EXISTS edges (
      project_root TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      from_ref TEXT NOT NULL,
      to_ref TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_index (
      project_root TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_ref TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      preview TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (project_root, owner_ref)
    );

    CREATE TABLE IF NOT EXISTS operation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_root TEXT NOT NULL,
      graph_version_before TEXT NOT NULL,
      graph_version_after TEXT NOT NULL,
      command_json TEXT NOT NULL,
      inverse_json TEXT NOT NULL,
      affected_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      undone_at TEXT
    );

    CREATE TABLE IF NOT EXISTS projection_versions (
      project_root TEXT NOT NULL,
      projection_name TEXT NOT NULL,
      graph_version TEXT NOT NULL,
      projection_version TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_root, projection_name, cache_key)
    );
  `);
  const operationLogColumns = db.prepare("PRAGMA table_info(operation_log)").all();
  if (!operationLogColumns.some((column) => isRecord(column) && column.name === "workspace_ref_json")) {
    db.exec("ALTER TABLE operation_log ADD COLUMN workspace_ref_json TEXT");
  }
  ensureIndexes(db);
}

function ensureIndexes(db: SqliteDatabase): void {
  for (const indexDefinition of sqliteIndexDefinitions) {
    db.exec(indexDefinition.sql);
  }
}

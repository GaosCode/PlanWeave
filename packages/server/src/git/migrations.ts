import type { SqliteDatabase } from "../sqlite.js"

const mergeQueueMigration1 = `
CREATE TABLE merge_queue_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  submission_id TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  worktree_path TEXT,
  check_logs TEXT,
  review_verdict TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, submission_id)
);
CREATE INDEX idx_merge_queue_entries_project_status ON merge_queue_entries(project_id, status);
CREATE INDEX idx_merge_queue_entries_submission ON merge_queue_entries(submission_id);

CREATE TABLE merge_queue_config (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  bare_repo_path TEXT NOT NULL,
  config_json TEXT NOT NULL
);
`

export const mergeQueueMigrations = [{ version: 1, sql: mergeQueueMigration1 }] as const

export function applyMergeQueueMigrations(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS merge_queue_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
  const applied = new Set(
    (database.prepare("SELECT version FROM merge_queue_schema_migrations").all() as Array<Record<string, unknown>>).map((row) => Number(row.version))
  )
  for (const migration of mergeQueueMigrations) {
    if (applied.has(migration.version)) continue
    database.exec("BEGIN IMMEDIATE")
    try {
      database.exec(migration.sql)
      database.prepare("INSERT INTO merge_queue_schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString())
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }
}

export function mergeQueueSchemaVersion(database: SqliteDatabase): number {
  try {
    const row = database.prepare("SELECT MAX(version) AS version FROM merge_queue_schema_migrations").get() as { version: number | null } | undefined
    return Number(row?.version ?? 0)
  } catch {
    return 0
  }
}

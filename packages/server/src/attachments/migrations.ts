import type { SqliteDatabase } from "../sqlite.js";

const attachmentsMigrations = [
  {
    version: 5,
    sql: `
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  uploader_user_id TEXT NOT NULL REFERENCES users(id),
  declared_size INTEGER NOT NULL,
  declared_digest TEXT NOT NULL,
  actual_size INTEGER,
  actual_digest TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  staged_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  supersedes_attachment_id TEXT REFERENCES attachments(id),
  CHECK (status IN ('staged','ready','failed','superseded'))
);
CREATE INDEX idx_attachments_project_id_digest ON attachments(project_id, actual_digest);
CREATE INDEX idx_attachments_uploader_user_id ON attachments(uploader_user_id);
CREATE INDEX idx_attachments_supersedes ON attachments(supersedes_attachment_id);
`
  }
] as const;

function applyMigrationsToDatabase(database: SqliteDatabase, migrations: readonly { version: number; sql: string }[]): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

export function applyAttachmentsMigrations(database: SqliteDatabase): void {
  applyMigrationsToDatabase(database, attachmentsMigrations);
}

export { attachmentsMigrations };

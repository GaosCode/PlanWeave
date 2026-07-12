import type { SqliteDatabase } from "../sqlite.js";

const planningMigrations = [
  {
    version: 3,
    sql: `
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_rooms_project_id ON rooms(project_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL,
  supersedes_message_id TEXT REFERENCES messages(id)
);
CREATE INDEX idx_messages_room_id_created_at ON messages(room_id, created_at, id);
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;
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

export function applyPlanningMigrations(database: SqliteDatabase): void {
  applyMigrationsToDatabase(database, planningMigrations);
}

export { planningMigrations };

import type { SqliteDatabase } from "../sqlite.js";

// A4 eventing migrations.
//
// The `subscribers` table tracks LIVE subscriber state (eventing state, not domain state).
// It is intentionally separate from the v1 domain migrations in `packages/server/src/migrations.ts`.
// An integration PR will wire `applyEventsMigrations` into the main lifecycle; see MIGRATIONS.md.
//
// We use a private `events_schema_migrations` table to track these migrations independently
// of the v1 domain schema. This keeps A4 strictly within its allowed paths.

const migration1 = `
CREATE TABLE IF NOT EXISTS subscribers (
  subscriber_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_seen_event_id TEXT NOT NULL DEFAULT '0',
  queue_size INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscribers_project ON subscribers(project_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_user ON subscribers(user_id);
`;

export const eventsMigrations = [{ version: 1, sql: migration1 }] as const;

export function applyEventsMigrations(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS events_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (database.prepare("SELECT version FROM events_schema_migrations").all() as Array<Record<string, unknown>>).map((row) => Number(row.version)),
  );
  for (const migration of eventsMigrations) {
    if (!applied.has(migration.version)) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database.prepare("INSERT INTO events_schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

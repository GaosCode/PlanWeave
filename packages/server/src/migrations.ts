import type { SqliteDatabase } from "./sqlite.js";

const migration1 = `
CREATE TABLE projects (id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE memberships (project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,user_id));
CREATE TABLE idempotency_keys (device_id TEXT NOT NULL, route TEXT NOT NULL, project_id TEXT, key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(device_id,route,project_id,key));
CREATE TABLE domain_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT REFERENCES projects(id), actor_id TEXT NOT NULL, action TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, occurred_at TEXT NOT NULL, details_json TEXT NOT NULL);
CREATE INDEX idx_domain_events_project_event ON domain_events(project_id,event_id);
CREATE INDEX idx_audit_log_project_id ON audit_log(project_id,id);
`;
const migrations = [{ version: 1, sql: migration1 }] as const;

export function applyMigrations(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
  for (const migration of migrations) if (!applied.has(migration.version)) { database.exec("BEGIN IMMEDIATE"); try { database.exec(migration.sql); database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString()); database.exec("COMMIT"); } catch (error) { database.exec("ROLLBACK"); throw error; } }
  const latest = Math.max(...migrations.map((migration) => migration.version));
  const found = Number(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0);
  if (found < latest) throw new Error(`Unsupported schema version ${found}; expected at least ${latest}.`);
}

export function centralSchemaVersion(database: SqliteDatabase): number {
  try {
    const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined;
    return Number(row?.version ?? 0);
  } catch {
    return 0;
  }
}

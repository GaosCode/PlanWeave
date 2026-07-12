import type { SqliteDatabase } from "../sqlite.js";

const SYSTEM_PROJECT_ID = "_system";
const SYSTEM_PROJECT_SEED_AT = "2026-07-12T00:00:00.000Z";

const identityMigrations = [
  {
    version: 2,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_name TEXT NOT NULL,
  public_key_fingerprint TEXT,
  last_seen_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  code TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_by_user_id TEXT REFERENCES users(id),
  redeemed_at TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invitations_project_id ON invitations(project_id);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_device_id ON sessions(device_id);
INSERT INTO projects(id, version, name, created_at) VALUES ('${SYSTEM_PROJECT_ID}', 1, 'System', '${SYSTEM_PROJECT_SEED_AT}');
`
  }
] as const;

export const IDENTITY_SYSTEM_PROJECT_ID = SYSTEM_PROJECT_ID;

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

export function applyIdentityMigrations(database: SqliteDatabase): void {
  applyMigrationsToDatabase(database, identityMigrations);
}

export { identityMigrations };

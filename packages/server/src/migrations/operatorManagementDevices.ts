import type { Migration } from "./types.js";

export const operatorManagementDevicesMigration: Migration = {
  version: 72,
  sql: `
    CREATE TABLE operator_management_devices (
      device_id TEXT PRIMARY KEY,
      secret_sha256 TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      authority_sha256 TEXT NOT NULL REFERENCES workspace_operator_sessions(credential_sha256),
      authority_revoked_at TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      revoked_at TEXT
    );
    ALTER TABLE operator_management_sessions ADD COLUMN device_id TEXT REFERENCES operator_management_devices(device_id);
    CREATE INDEX operator_management_sessions_device ON operator_management_sessions(device_id);
  `
};

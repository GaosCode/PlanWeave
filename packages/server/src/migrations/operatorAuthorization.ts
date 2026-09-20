import type { Migration } from "./types.js";

export const operatorAuthorizationMigration: Migration = {
  version: 71,
  sql: `
    CREATE TABLE operator_management_sessions (
      credential_sha256 TEXT PRIMARY KEY REFERENCES workspace_operator_sessions(credential_sha256),
      authority_sha256 TEXT NOT NULL REFERENCES workspace_operator_sessions(credential_sha256),
      authority_revoked_at TEXT
    );
    CREATE TABLE operator_management_recovery_codes (
      code_sha256 TEXT PRIMARY KEY,
      authority_sha256 TEXT NOT NULL REFERENCES workspace_operator_sessions(credential_sha256),
      authority_revoked_at TEXT,
      expires_at TEXT NOT NULL,
      redeemed_credential_sha256 TEXT
    );
  `
};

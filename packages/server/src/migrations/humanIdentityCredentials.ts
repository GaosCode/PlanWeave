import { tableExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";

/**
 * Server-global Human Identity Credentials and auditable principal aliases.
 * Independent of workspace_device_sessions and workspace membership.
 * Does not merge pre-upgrade split principals; merge requires dual identity proofs.
 */
export const humanIdentityCredentialsMigration: Migration = {
  version: 61,
  sql: "",
  after(database) {
    if (!tableExists(database, "human_principals")) {
      throw new Error("human_identity_credentials_source_missing:human_principals");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS human_identity_credentials (
        identity_credential_id TEXT PRIMARY KEY,
        human_principal_id TEXT NOT NULL REFERENCES human_principals(human_principal_id),
        token_sha256 TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        revoked_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_human_identity_credentials_principal
        ON human_identity_credentials(human_principal_id);

      CREATE TABLE IF NOT EXISTS human_principal_merges (
        merge_id TEXT PRIMARY KEY,
        source_human_principal_id TEXT NOT NULL,
        canonical_human_principal_id TEXT NOT NULL,
        source_identity_credential_id TEXT NOT NULL,
        canonical_identity_credential_id TEXT NOT NULL,
        merged_at TEXT NOT NULL,
        CHECK(source_human_principal_id != canonical_human_principal_id)
      );

      CREATE TABLE IF NOT EXISTS human_principal_aliases (
        alias_human_principal_id TEXT PRIMARY KEY,
        canonical_human_principal_id TEXT NOT NULL REFERENCES human_principals(human_principal_id),
        merge_id TEXT NOT NULL REFERENCES human_principal_merges(merge_id),
        CHECK(alias_human_principal_id != canonical_human_principal_id)
      );
    `);
  }
};

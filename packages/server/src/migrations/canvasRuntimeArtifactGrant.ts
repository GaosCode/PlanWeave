import type { Migration } from "./types.js";

export const canvasRuntimeArtifactGrantMigration: Migration = {
  version: 52,
  sql: `
    CREATE TABLE canvas_runtime_leases (
      runtime_lease_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES agent_hosts(id),
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      attachment_version INTEGER NOT NULL CHECK(attachment_version >= 0),
      source_revision TEXT NOT NULL,
      graph_fingerprint TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','released','revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE canvas_runtime_artifact_grants (
      grant_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      runtime_lease_id TEXT NOT NULL REFERENCES canvas_runtime_leases(runtime_lease_id),
      direction TEXT NOT NULL CHECK(direction IN ('download','upload')),
      artifact_ref TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      expected_size_bytes INTEGER,
      max_size_bytes INTEGER NOT NULL CHECK(max_size_bytes > 0),
      media_type TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_canvas_runtime_leases_scope
      ON canvas_runtime_leases(workspace_id,project_id,canvas_id,status);
    CREATE INDEX idx_canvas_runtime_artifact_grants_lease
      ON canvas_runtime_artifact_grants(runtime_lease_id,direction,expires_at);
  `
};

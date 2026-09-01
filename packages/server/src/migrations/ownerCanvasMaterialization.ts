import type { Migration } from "./types.js";

/**
 * Owner Canvas materialization is an owner-principal authority boundary, not a
 * Workspace grant. Internal runtime workspace identities remain server-only.
 */
export const ownerCanvasMaterializationMigration: Migration = {
  version: 67,
  sql: `
CREATE TABLE IF NOT EXISTS owner_canvas_materialization_scopes (
  owner_human_principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_human_principal_id, project_id, canvas_id)
);
CREATE TABLE IF NOT EXISTS owner_canvas_materialization_receipts (
  owner_human_principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  materialization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
  version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  content_revision TEXT NOT NULL,
  graph_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_human_principal_id, project_id, canvas_id, materialization_id),
  FOREIGN KEY(owner_human_principal_id, project_id, canvas_id)
    REFERENCES owner_canvas_materialization_scopes(owner_human_principal_id, project_id, canvas_id),
  FOREIGN KEY(workspace_id, project_id, canvas_id, version_id)
    REFERENCES canvas_content_versions(workspace_id, project_id, canvas_id, version_id)
);
`
};

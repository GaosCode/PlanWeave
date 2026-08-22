import type { Migration } from "./types.js";

/** Durable idempotency receipts for atomic Workspace canvas initial publish. */
export const workspaceCanvasPublishMigration: Migration = {
  version: 54,
  sql: `
CREATE TABLE canvas_workspace_publish_operations (
  operation_id TEXT PRIMARY KEY,
  recovery_token TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')),
  created_at TEXT NOT NULL,
    UNIQUE(workspace_id, project_id, canvas_id)
);
`
};

/** Persist the local source so retries recover the assigned Server canvasId. */
export const workspaceCanvasPublishLocalSourceMigration: Migration = {
  version: 55,
  sql: `
CREATE TABLE canvas_workspace_publish_operations_v55 (
  operation_id TEXT PRIMARY KEY,
  recovery_token TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  local_project_id TEXT NOT NULL,
  local_canvas_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, project_id, canvas_id),
  UNIQUE(workspace_id, project_id, local_project_id, local_canvas_id)
);
INSERT INTO canvas_workspace_publish_operations_v55(
  operation_id,recovery_token,workspace_id,project_id,canvas_id,
  local_project_id,local_canvas_id,version_id,canonical_digest,revision,visibility,created_at
)
SELECT operation_id,recovery_token,workspace_id,project_id,canvas_id,
       canvas_id,canvas_id,version_id,canonical_digest,revision,visibility,created_at
  FROM canvas_workspace_publish_operations;
DROP TABLE canvas_workspace_publish_operations;
ALTER TABLE canvas_workspace_publish_operations_v55 RENAME TO canvas_workspace_publish_operations;
`
};

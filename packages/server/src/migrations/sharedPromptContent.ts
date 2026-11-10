import type { Migration } from "./types.js";

export const sharedPromptContentMigration: Migration = {
  version: 81,
  sql: `
CREATE TABLE canvas_content_version_members_shared (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  member_path TEXT NOT NULL,
  member_kind TEXT NOT NULL CHECK(member_kind IN ('manifest','task_prompt','block_prompt','shared_prompt','desktop_layout')),
  content TEXT NOT NULL,
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  PRIMARY KEY(workspace_id, project_id, canvas_id, version_id, member_path),
  FOREIGN KEY(workspace_id, project_id, canvas_id, version_id)
    REFERENCES canvas_content_versions(workspace_id, project_id, canvas_id, version_id) ON DELETE RESTRICT
);
INSERT INTO canvas_content_version_members_shared SELECT * FROM canvas_content_version_members;
DROP TABLE canvas_content_version_members;
ALTER TABLE canvas_content_version_members_shared RENAME TO canvas_content_version_members;
`
};

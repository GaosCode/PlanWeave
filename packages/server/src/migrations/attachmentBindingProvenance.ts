import type { Migration } from "./types.js";

export const attachmentBindingProvenanceMigration: Migration = {
  version: 74,
  sql: `
    ALTER TABLE comment_pending_uploads ADD COLUMN binding_provenance_version INTEGER NOT NULL DEFAULT 0
      CHECK(binding_provenance_version IN (0,1));
    ALTER TABLE comment_attachment_bindings ADD COLUMN pending_upload_ids_json TEXT NOT NULL DEFAULT '[]'
      CHECK(json_valid(pending_upload_ids_json) AND json_type(pending_upload_ids_json)='array');
  `
};

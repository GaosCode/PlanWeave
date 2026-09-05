import type { Migration } from "./types.js";
export const acpTaskRestorationsMigration: Migration = {
  version: 70,
  sql: `CREATE TABLE acp_task_restorations (
    source_operation_id TEXT PRIMARY KEY REFERENCES remote_operations(id),
    host_id TEXT NOT NULL, session_id TEXT NOT NULL,
    restored_operation_id TEXT REFERENCES remote_operations(id)
  );`
};

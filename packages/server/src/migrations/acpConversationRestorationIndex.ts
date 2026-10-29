import type { Migration } from "./types.js";

export const acpConversationRestorationIndexMigration: Migration = {
  version: 78,
  sql: `CREATE INDEX acp_task_restoration_session
    ON acp_task_restorations(host_id,session_id,restored_operation_id);`
};

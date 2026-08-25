import type { Migration } from "./types.js";

/**
 * Workspace setup historically minted humanPrincipalId only into
 * workspace_principals. Remote Agent owner, grantor, and access checks
 * require the Server-global human_principals row.
 */
export const humanPrincipalWorkspaceBackfillMigration: Migration = {
  version: 60,
  sql: "",
  after(database) {
    database.exec(`
      INSERT OR IGNORE INTO human_principals(human_principal_id, display_name, created_at)
      SELECT human_principal_id, MIN(display_name), MIN(created_at)
      FROM workspace_principals
      GROUP BY human_principal_id
    `);
  }
};

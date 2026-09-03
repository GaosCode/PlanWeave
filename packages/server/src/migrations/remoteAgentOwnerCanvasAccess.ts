import { columnExists, tableExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";

/**
 * Local (owner-canvas) access is independent of Workspace grants.
 * Existing agents keep local access enabled so current owner fleets stay visible.
 */
export const remoteAgentOwnerCanvasAccessMigration: Migration = {
  version: 68,
  sql: "",
  before(database) {
    if (!tableExists(database, "remote_agents")) {
      throw new Error("remote_agent_owner_canvas_access_source_missing:remote_agents");
    }
    if (!columnExists(database, "remote_agents", "allow_owner_canvas")) {
      database.exec(
        `ALTER TABLE remote_agents
         ADD COLUMN allow_owner_canvas INTEGER NOT NULL DEFAULT 1
         CHECK(allow_owner_canvas IN (0,1))`
      );
    }
  }
};

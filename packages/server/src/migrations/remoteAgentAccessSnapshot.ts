import { columnExists, tableExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";

export const remoteAgentAccessSnapshotMigration: Migration = {
  version: 59,
  sql: "",
  before(database) {
    if (!tableExists(database, "remote_operations")) {
      throw new Error("remote_agent_access_snapshot_source_missing:remote_operations");
    }
    if (!columnExists(database, "remote_operations", "agent_access_json")) {
      database.exec("ALTER TABLE remote_operations ADD COLUMN agent_access_json TEXT");
    }
  }
};

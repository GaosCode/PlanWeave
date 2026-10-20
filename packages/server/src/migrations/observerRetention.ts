import type { Migration } from "./types.js";

export const observerRetentionMigration: Migration = {
  version: 75,
  sql: `
ALTER TABLE human_observer_events ADD COLUMN delivery_token TEXT;

CREATE TABLE human_observer_retention (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  retained_count INTEGER NOT NULL CHECK(retained_count >= 0),
  PRIMARY KEY (workspace_id,project_id)
) WITHOUT ROWID;

INSERT INTO human_observer_retention(workspace_id,project_id,retained_count)
SELECT workspace_id,project_id,COUNT(*) FROM human_observer_events
GROUP BY workspace_id,project_id;

CREATE TRIGGER human_observer_retention_insert
AFTER INSERT ON human_observer_events
BEGIN
  INSERT INTO human_observer_retention(workspace_id,project_id,retained_count)
  VALUES (NEW.workspace_id,NEW.project_id,1)
  ON CONFLICT(workspace_id,project_id)
  DO UPDATE SET retained_count=retained_count+1;
END;

CREATE TRIGGER human_observer_retention_delete
AFTER DELETE ON human_observer_events
BEGIN
  UPDATE human_observer_retention SET retained_count=retained_count-1
  WHERE workspace_id=OLD.workspace_id AND project_id=OLD.project_id;
END;
`
};

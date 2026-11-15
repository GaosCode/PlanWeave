import type { Migration } from "./types.js";

export const remoteResumeActionRejectionMigration: Migration = {
  version: 82,
  sql: `
    CREATE TABLE remote_execution_actions_v82 (
      action_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES remote_operations(id),
      dispatch_id TEXT NOT NULL,
      execution_attempt_id TEXT NOT NULL REFERENCES remote_execution_attempts(execution_attempt_id),
      kind TEXT NOT NULL CHECK(kind IN ('resume_same_session','retry_new_attempt','fail','block','cancel')),
      request_fingerprint TEXT NOT NULL CHECK(
        length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'
      ),
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('recorded','delivered','acknowledged','settled','rejected')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acknowledged_at TEXT,
      settled_at TEXT,
      rejected_at TEXT,
      application_owner_token TEXT,
      application_claimed_at TEXT,
      application_decision_json TEXT,
      rejection_code TEXT CHECK(
        rejection_code IS NULL OR rejection_code IN (
          'work_not_agent_assigned','remote_resume_attempt_conflict','remote_resume_authorization_changed'
        )
      ),
      CHECK(
        (state='recorded' AND delivered_at IS NULL AND acknowledged_at IS NULL
          AND settled_at IS NULL AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='delivered' AND delivered_at IS NOT NULL AND acknowledged_at IS NULL
          AND settled_at IS NULL AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='acknowledged' AND delivered_at IS NOT NULL AND acknowledged_at IS NOT NULL
          AND settled_at IS NULL AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='settled' AND settled_at IS NOT NULL
          AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='rejected' AND delivered_at IS NULL AND acknowledged_at IS NULL
          AND settled_at IS NULL AND rejected_at IS NOT NULL AND rejection_code IS NOT NULL)
      )
    );

    INSERT INTO remote_execution_actions_v82(
      action_id,operation_id,dispatch_id,execution_attempt_id,kind,
      request_fingerprint,request_json,state,created_at,delivered_at,acknowledged_at,settled_at,
      rejected_at,rejection_code,application_owner_token,application_claimed_at,application_decision_json
    )
    SELECT
      action_id,operation_id,dispatch_id,execution_attempt_id,kind,
      request_fingerprint,request_json,state,created_at,delivered_at,acknowledged_at,settled_at,
      rejected_at,rejection_code,application_owner_token,application_claimed_at,application_decision_json
    FROM remote_execution_actions;

    DROP INDEX idx_remote_execution_actions_operation_state;
    DROP TABLE remote_execution_actions;
    ALTER TABLE remote_execution_actions_v82 RENAME TO remote_execution_actions;
    CREATE INDEX idx_remote_execution_actions_operation_state
      ON remote_execution_actions(operation_id,state,created_at);
  `
};

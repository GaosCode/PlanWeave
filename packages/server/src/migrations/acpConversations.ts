import type { Migration } from "./types.js";

export const acpConversationsMigration: Migration = {
  version: 69,
  sql: `
    CREATE TABLE acp_conversation_turns (
      turn_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      host_id TEXT NOT NULL, session_id TEXT NOT NULL, execution_attempt_id TEXT NOT NULL,
      request_json TEXT NOT NULL, status TEXT NOT NULL
        CHECK(status IN ('queued','running','completed','failed','cancelled')),
      error TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0, event_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX acp_conversation_active_session
      ON acp_conversation_turns(host_id,session_id) WHERE status IN ('queued','running');
    CREATE INDEX acp_conversation_operation ON acp_conversation_turns(operation_id,created_at);
    CREATE TABLE acp_conversation_actions (
      action_key TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES acp_conversation_turns(turn_id),
      request_json TEXT NOT NULL
    );
    CREATE TABLE acp_conversation_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES acp_conversation_turns(turn_id),
      sequence INTEGER NOT NULL, event_json TEXT NOT NULL, UNIQUE(turn_id,sequence)
    );
  `
};

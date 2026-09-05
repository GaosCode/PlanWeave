export const acpConversationHostSchema = `
CREATE TABLE IF NOT EXISTS agent_host_conversation_turns (
 turn_id TEXT PRIMARY KEY, command_json TEXT NOT NULL, command_digest TEXT NOT NULL,
 status TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0,
 event_bytes INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_host_conversation_responses (
 turn_id TEXT NOT NULL, request_id TEXT NOT NULL, command_json TEXT NOT NULL,
 PRIMARY KEY(turn_id,request_id)
);`;

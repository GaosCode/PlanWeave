import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  acpConversationPromptCommandSchema,
  agentHostProtocolVersion,
  canonicalizeJson,
  exampleExecutionEnvelopeInput
} from "@planweave-ai/agent-host-protocol";
import { openAgentHostState, type AgentHostState } from "../../state/agentHostState.js";
import { openAgentHostDatabase } from "../../state/sqliteDatabase.js";

const directories: string[] = [];
const states = new Set<AgentHostState>();
afterEach(async () => {
  for (const state of states) state.close();
  states.clear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

export function upgradePrompt(turnId = "legacy-turn", sessionId = "legacy-session") {
  return acpConversationPromptCommandSchema.parse({
    type: "acp_conversation.prompt",
    protocolVersion: agentHostProtocolVersion,
    operationId: "operation-upgrade",
    turnId,
    executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
    sessionId,
    text: "Continue the task",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
  });
}

export async function createProtocolUpgradeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-protocol-upgrade-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const initial = await openAgentHostState(path);
  states.add(initial);
  const reopen = async () => {
    const state = await openAgentHostState(path);
    states.add(state);
    return state;
  };
  const archiveDatabase = async (schemaVersion = 11, wireVersion = 1) => {
    initial.close();
    states.delete(initial);
    const db = await openAgentHostDatabase(path, 5_000);
    for (const table of [
      "agent_host_outbox",
      "agent_host_conversation_turns",
      "canvas_runtime_rpc_receipts"
    ]) {
      if (
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === "protocol_archive_reason")
      ) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN protocol_archive_reason`);
      }
    }
    if (schemaVersion === 10)
      db.exec("ALTER TABLE agent_host_conversation_turns DROP COLUMN cleanup_safe");
    for (const [table, field] of [
      ["agent_host_inbox", "command_json"],
      ["agent_host_conversation_turns", "command_json"],
      ["agent_host_conversation_responses", "command_json"],
      ["canvas_runtime_rpc_receipts", "command_json"],
      ["canvas_runtime_rpc_receipts", "response_json"],
      ["agent_host_outbox", "event_json"]
    ]) {
      db.prepare(
        `UPDATE ${table} SET ${field}=json_set(${field},'$.protocolVersion',?)
         WHERE ${field} IS NOT NULL AND json_type(${field},'$.protocolVersion') IS NOT NULL`
      ).run(wireVersion);
    }
    for (const table of [
      "agent_host_inbox",
      "agent_host_conversation_turns",
      "canvas_runtime_rpc_receipts"
    ]) {
      for (const row of db.prepare(`SELECT rowid,command_json FROM ${table}`).all()) {
        const value = JSON.parse(String(row.command_json));
        const encoded =
          table === "canvas_runtime_rpc_receipts" ? canonicalizeJson(value) : JSON.stringify(value);
        const digest = `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
        db.prepare(`UPDATE ${table} SET command_digest=? WHERE rowid=?`).run(digest, row.rowid);
      }
    }
    db.prepare("UPDATE agent_host_state_schema SET version=? WHERE singleton=1").run(schemaVersion);
    db.close();
  };
  return {
    initial,
    path,
    reopen,
    archiveDatabase,
    closeState(state: AgentHostState) {
      state.close();
      states.delete(state);
    }
  };
}

import { randomUUID } from "node:crypto";
import {
  acpConversationCommandSchema,
  acpConversationEventSchema,
  acpConversationEventPageBytes,
  type AcpConversationCommand,
  type AcpConversationEvent,
  type AcpConversationPromptCommand
} from "@planweave-ai/agent-host-protocol";
import { ACP_CONVERSATION_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { digestJson } from "./agentHostStateMigrations.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqliteDatabase.js";
import type { AgentHostEventOutbox } from "./agentHostEventOutbox.js";

export class AcpConversationRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly outbox: AgentHostEventOutbox
  ) {}

  accept(command: AcpConversationCommand): void {
    const row = this.db
      .prepare("SELECT * FROM agent_host_conversation_turns WHERE turn_id=?")
      .get(command.turnId);
    if (command.type === "acp_conversation.prompt") {
      if (row) {
        if (row.command_digest !== digestJson(command))
          throw new Error("acp_conversation_request_conflict");
        return;
      }
      this.db
        .prepare(`INSERT INTO agent_host_conversation_turns(turn_id,command_json,command_digest,status)
        VALUES(?,?,?,'queued')`)
        .run(command.turnId, JSON.stringify(command), digestJson(command));
      return;
    }
    if (!row) throw new Error("acp_conversation_turn_not_found");
    const prompt = this.command(command.turnId);
    if (
      prompt.operationId !== command.operationId ||
      prompt.sessionId !== command.sessionId ||
      prompt.executionAttemptId !== command.executionAttemptId
    )
      throw new Error("acp_conversation_identity_mismatch");
    if (command.type === "acp_conversation.cancel") {
      this.db
        .prepare("UPDATE agent_host_conversation_turns SET cancelled=1 WHERE turn_id=?")
        .run(command.turnId);
    } else {
      const prior = this.response(command.turnId, command.requestId);
      if (prior && digestJson(prior) !== digestJson(command))
        throw new Error("acp_conversation_response_conflict");
      if (!prior)
        this.db
          .prepare("INSERT INTO agent_host_conversation_responses VALUES(?,?,?)")
          .run(command.turnId, command.requestId, JSON.stringify(command));
    }
  }

  command(turnId: string): AcpConversationPromptCommand {
    const row = this.db
      .prepare("SELECT command_json FROM agent_host_conversation_turns WHERE turn_id=?")
      .get(turnId);
    if (!row) throw new Error("acp_conversation_turn_not_found");
    const command = acpConversationCommandSchema.parse(JSON.parse(String(row.command_json)));
    if (command.type !== "acp_conversation.prompt")
      throw new Error("acp_conversation_prompt_required");
    return command;
  }

  response(turnId: string, requestId: string) {
    const row = this.db
      .prepare(
        "SELECT command_json FROM agent_host_conversation_responses WHERE turn_id=? AND request_id=?"
      )
      .get(turnId, requestId);
    if (!row) return undefined;
    const command = acpConversationCommandSchema.parse(JSON.parse(String(row.command_json)));
    if (command.type !== "acp_conversation.respond")
      throw new Error("acp_conversation_response_required");
    return command;
  }

  cancelled(turnId: string): boolean {
    return (
      this.db
        .prepare("SELECT cancelled FROM agent_host_conversation_turns WHERE turn_id=?")
        .get(turnId)?.cancelled === 1
    );
  }

  isQueued(turnId: string): boolean {
    return (
      this.db
        .prepare("SELECT status FROM agent_host_conversation_turns WHERE turn_id=?")
        .get(turnId)?.status === "queued"
    );
  }

  start(turnId: string): boolean {
    return inWriteTransaction(this.db, () => {
      const row = this.db
        .prepare("SELECT status FROM agent_host_conversation_turns WHERE turn_id=?")
        .get(turnId);
      if (row?.status !== "queued") return false;
      this.appendInTransaction(turnId, { kind: "status", status: "running", error: null });
      return true;
    });
  }

  queued(): string[] {
    return this.db
      .prepare("SELECT turn_id FROM agent_host_conversation_turns WHERE status='queued'")
      .all()
      .map((row) => String(row.turn_id));
  }

  unsafeSessions(): string[] {
    return this.db
      .prepare("SELECT command_json FROM agent_host_conversation_turns WHERE cleanup_safe=0")
      .all()
      .map((row) => acpConversationCommandSchema.parse(JSON.parse(String(row.command_json))))
      .filter(
        (command): command is AcpConversationPromptCommand =>
          command.type === "acp_conversation.prompt"
      )
      .map((command) => command.sessionId);
  }

  markCleanupUnsafe(turnId: string): void {
    this.db
      .prepare("UPDATE agent_host_conversation_turns SET cleanup_safe=0 WHERE turn_id=?")
      .run(turnId);
  }

  recover(activeTurnIds: ReadonlySet<string> = new Set()): string[] {
    for (const row of this.db
      .prepare("SELECT turn_id FROM agent_host_conversation_turns WHERE status='running'")
      .all()) {
      if (activeTurnIds.has(String(row.turn_id))) continue;
      this.markCleanupUnsafe(String(row.turn_id));
      this.append(String(row.turn_id), {
        kind: "status",
        status: "failed",
        error: "acp_conversation_host_interrupted"
      });
    }
    return this.queued();
  }

  append(turnId: string, payload: AcpConversationEvent["payload"]): void {
    inWriteTransaction(this.db, () => this.appendInTransaction(turnId, payload));
  }

  private appendInTransaction(turnId: string, payload: AcpConversationEvent["payload"]): void {
    const row = this.db
      .prepare("SELECT * FROM agent_host_conversation_turns WHERE turn_id=?")
      .get(turnId);
    if (!row || !["queued", "running"].includes(String(row.status)))
      throw new Error("acp_conversation_turn_closed");
    const prompt = this.command(turnId);
    const event = acpConversationEventSchema.parse({
      type: "acp_conversation.event",
      protocolVersion: 1,
      operationId: prompt.operationId,
      turnId,
      executionAttemptId: prompt.executionAttemptId,
      sessionId: prompt.sessionId,
      messageId: randomUUID(),
      sequence: Number(row.last_sequence) + 1,
      timestamp: new Date().toISOString(),
      payload
    });
    if (acpConversationEventPageBytes(event) > ACP_CONVERSATION_RESPONSE_MAX_BYTES)
      throw new Error("acp_conversation_event_too_large");
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (payload.kind !== "status" && Number(row.event_bytes) + bytes > 7 * 1024 * 1024)
      throw new Error("acp_conversation_event_limit");
    this.outbox.queue(`acp-conversation:${turnId}:${event.sequence}`, event);
    this.db
      .prepare(
        "UPDATE agent_host_conversation_turns SET last_sequence=?,event_bytes=event_bytes+?,status=? WHERE turn_id=?"
      )
      .run(event.sequence, bytes, payload.kind === "status" ? payload.status : "running", turnId);
  }
}

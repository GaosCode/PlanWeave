import { createHash } from "node:crypto";
import {
  ACP_CONVERSATION_CAPABILITY,
  acpConversationActionSchema,
  acpConversationEventSchema,
  acpConversationCommandSchema,
  acpConversationPageSchema,
  acpConversationPromptCommandSchema,
  canonicalizeJson,
  executeBlockCommandSchema,
  type AcpConversationAction,
  type AcpConversationEvent,
  type AcpConversationPage
} from "@planweave-ai/agent-host-protocol";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import type { DurableMailbox } from "./mailbox.js";
import { isAgentHostOnline, type AgentHostRepository } from "./hosts.js";
import type { RemoteOperation } from "./remoteOperations.js";

export class AcpConversationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class AcpConversationService {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: {
      hosts: AgentHostRepository;
      mailbox: DurableMailbox;
      hostOfflineAfterMs: number;
      clock?: () => Date;
      authorize(operation: RemoteOperation, actorId: string): void;
    }
  ) {}

  private now() {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }

  private source(operation: RemoteOperation) {
    const stream = this.database
      .prepare(
        "SELECT acp_session_id,host_id FROM remote_acp_event_streams WHERE execution_attempt_id=?"
      )
      .get(operation.executionAttemptId);
    const source = this.database
      .prepare(
        `SELECT command_json FROM mailbox_messages WHERE host_id=?
       AND json_extract(command_json,'$.type')='execute_block'
       AND json_extract(command_json,'$.executionAttemptId')=? ORDER BY sequence LIMIT 1`
      )
      .get(operation.attempt.hostId ?? null, operation.executionAttemptId);
    return {
      sessionId: stream?.acp_session_id ? String(stream.acp_session_id) : null,
      command: source
        ? executeBlockCommandSchema.parse(JSON.parse(String(source.command_json)))
        : null
    };
  }

  private availability(
    operation: RemoteOperation,
    source: ReturnType<AcpConversationService["source"]>
  ) {
    if (operation.state !== "completed" && operation.state !== "cancelled")
      return "acp_conversation_execution_not_completed";
    if (!source.sessionId || !source.command) return "acp_conversation_session_unavailable";
    const host = operation.attempt.hostId
      ? this.options.hosts.get(operation.attempt.hostId)
      : undefined;
    if (!host || host.revokedAt) return "acp_conversation_host_unavailable";
    if (!host.capabilities.includes(ACP_CONVERSATION_CAPABILITY))
      return "acp_conversation_host_upgrade_required";
    if (
      !isAgentHostOnline(host, {
        now: new Date(this.now()),
        hostOfflineAfterMs: this.options.hostOfflineAfterMs
      })
    )
      return "acp_conversation_host_offline";
    return null;
  }

  private expire() {
    this.database
      .prepare(
        "UPDATE acp_conversation_turns SET status='failed',error='acp_conversation_deadline_exceeded' WHERE status IN ('queued','running') AND expires_at<=?"
      )
      .run(this.now());
  }

  page(operation: RemoteOperation, actorId: string, afterCursor = 0): AcpConversationPage {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
      throw new AcpConversationError("acp_conversation_cursor_invalid");
    this.options.authorize(operation, actorId);
    this.expire();
    const source = this.source(operation);
    const reason = this.availability(operation, source);
    const turns = this.database
      .prepare(
        "SELECT * FROM acp_conversation_turns WHERE operation_id=? ORDER BY created_at,turn_id"
      )
      .all(operation.id);
    const rows = this.database
      .prepare(`SELECT e.cursor,e.event_json FROM acp_conversation_events e
      JOIN acp_conversation_turns t ON t.turn_id=e.turn_id WHERE t.operation_id=? AND e.cursor>?
      ORDER BY e.cursor LIMIT 129`)
      .all(operation.id, afterCursor);
    const page = rows.slice(0, 128);
    return acpConversationPageSchema.parse({
      available: reason === null,
      reason,
      executionAttemptId: operation.executionAttemptId,
      sessionId: source.sessionId,
      turns: turns.map((row) => ({
        turnId: row.turn_id,
        executionAttemptId: row.execution_attempt_id,
        sessionId: row.session_id,
        status: row.status,
        createdAt: row.created_at,
        error: row.error
      })),
      events: page.map((row) => JSON.parse(String(row.event_json))),
      cursor: page.length ? Number(page.at(-1)!.cursor) : afterCursor,
      hasMore: rows.length > 128
    });
  }

  act(operation: RemoteOperation, actorId: string, input: unknown): AcpConversationPage {
    const action = acpConversationActionSchema.parse(input);
    this.options.authorize(operation, actorId);
    if (action.executionAttemptId !== operation.executionAttemptId)
      throw new AcpConversationError("acp_conversation_attempt_mismatch");
    const source = this.source(operation);
    if (source.sessionId !== action.sessionId)
      throw new AcpConversationError("acp_conversation_session_mismatch");
    this.expire();
    const now = this.now();
    const message = inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT * FROM acp_conversation_turns WHERE turn_id=?")
        .get(action.turnId);
      if (existing && (existing.operation_id !== operation.id || existing.actor_id !== actorId)) {
        throw new AcpConversationError("acp_conversation_turn_forbidden");
      }
      if (action.kind === "prompt") {
        if (existing) {
          if (existing.request_json !== canonicalizeJson(action))
            throw new AcpConversationError("acp_conversation_request_conflict");
          return null;
        }
        const reason = this.availability(operation, source);
        if (reason) throw new AcpConversationError(reason);
        if (!source.command || !operation.attempt.hostId)
          throw new AcpConversationError("acp_conversation_session_unavailable");
        if (
          this.database
            .prepare(`SELECT turn_id FROM acp_conversation_turns
          WHERE host_id=? AND session_id=? AND status IN ('queued','running')`)
            .get(operation.attempt.hostId, action.sessionId)
        ) {
          throw new AcpConversationError("acp_conversation_turn_in_flight");
        }
        const count = this.database
          .prepare("SELECT COUNT(*) AS count FROM acp_conversation_turns WHERE operation_id=?")
          .get(operation.id);
        if (Number(count?.count) >= 256)
          throw new AcpConversationError("acp_conversation_turn_limit");
        const expiresAt = new Date(Date.parse(now) + 15 * 60_000).toISOString();
        this.database
          .prepare(`INSERT INTO acp_conversation_turns
          (turn_id,operation_id,actor_id,host_id,session_id,execution_attempt_id,request_json,status,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?,'queued',?,?)`)
          .run(
            action.turnId,
            operation.id,
            actorId,
            operation.attempt.hostId,
            action.sessionId,
            action.executionAttemptId,
            canonicalizeJson(action),
            now,
            expiresAt
          );
        const { kind: _kind, ...prompt } = action;
        return this.options.mailbox.enqueueOnce(
          `acp-turn-${createHash("sha256").update(action.turnId).digest("hex")}`,
          operation.attempt.hostId,
          acpConversationPromptCommandSchema.parse({
            type: "acp_conversation.prompt",
            protocolVersion: 1,
            operationId: operation.id,
            ...prompt,
            expiresAt,
            sourceEnvelope: source.command.envelope
          })
        ).message;
      }
      if (!existing) throw new AcpConversationError("acp_conversation_turn_not_found");
      const actionKey = createHash("sha256")
        .update(
          JSON.stringify([
            action.turnId,
            action.kind,
            action.kind === "respond" ? action.requestId : null
          ])
        )
        .digest("hex");
      const receipt = this.database
        .prepare("SELECT request_json FROM acp_conversation_actions WHERE action_key=?")
        .get(actionKey);
      if (receipt) {
        if (receipt.request_json !== canonicalizeJson(action))
          throw new AcpConversationError("acp_conversation_response_conflict");
        return null;
      }
      if (!["queued", "running"].includes(String(existing.status)))
        throw new AcpConversationError("acp_conversation_turn_closed");
      if (action.kind === "respond") this.validateDecision(action);
      const { kind, ...body } = action;
      const command =
        kind === "cancel"
          ? {
              protocolVersion: 1 as const,
              type: "acp_conversation.cancel" as const,
              operationId: operation.id,
              ...body
            }
          : {
              protocolVersion: 1 as const,
              type: "acp_conversation.respond" as const,
              operationId: operation.id,
              ...body
            };
      // The command schema validates the discriminated response before transport.
      this.database
        .prepare("INSERT INTO acp_conversation_actions VALUES(?,?,?)")
        .run(actionKey, action.turnId, canonicalizeJson(action));
      return this.options.mailbox.enqueueOnce(
        `acp-action-${actionKey}`,
        String(existing.host_id),
        acpConversationCommandSchema.parse(command)
      ).message;
    });
    if (message) this.options.mailbox.publish(message);
    return this.page(operation, actorId);
  }

  private validateDecision(action: Extract<AcpConversationAction, { kind: "respond" }>) {
    const rows = this.database
      .prepare("SELECT event_json FROM acp_conversation_events WHERE turn_id=? ORDER BY sequence")
      .all(action.turnId);
    let request:
      | Extract<AcpConversationEvent["payload"], { kind: "interaction" }>["request"]
      | undefined;
    for (const row of rows) {
      const payload = acpConversationEventSchema.parse(JSON.parse(String(row.event_json))).payload;
      if (payload.kind === "interaction" && payload.request.requestId === action.requestId)
        request = payload.request;
      if (payload.kind === "interaction_settled" && payload.requestId === action.requestId)
        request = undefined;
    }
    if (!request || request.deadline <= this.now())
      throw new AcpConversationError("acp_conversation_interaction_expired");
    if (request.kind !== action.decision.kind)
      throw new AcpConversationError("acp_conversation_decision_invalid");
    if (
      request.kind === "permission" &&
      action.decision.kind === "permission" &&
      action.decision.optionId !== null &&
      !request.options.map((option) => option.optionId).includes(action.decision.optionId)
    )
      throw new AcpConversationError("acp_conversation_decision_invalid");
  }

  ingest(hostId: string, input: unknown): void {
    const event = acpConversationEventSchema.parse(input);
    inWriteTransaction(this.database, () => {
      const turn = this.database
        .prepare("SELECT * FROM acp_conversation_turns WHERE turn_id=?")
        .get(event.turnId);
      if (
        !turn ||
        turn.host_id !== hostId ||
        turn.operation_id !== event.operationId ||
        turn.session_id !== event.sessionId ||
        turn.execution_attempt_id !== event.executionAttemptId
      )
        throw new AcpConversationError("acp_conversation_event_identity_mismatch");
      const json = canonicalizeJson(event);
      const prior = this.database
        .prepare("SELECT event_json FROM acp_conversation_events WHERE turn_id=? AND sequence=?")
        .get(event.turnId, event.sequence);
      if (prior) {
        if (prior.event_json !== json)
          throw new AcpConversationError("acp_conversation_event_conflict");
        return;
      }
      if (
        !["queued", "running"].includes(String(turn.status)) ||
        String(turn.expires_at) <= this.now()
      )
        return;
      if (event.sequence !== Number(turn.last_sequence) + 1)
        throw new AcpConversationError("acp_conversation_event_gap");
      const bytes = Number(turn.event_bytes) + Buffer.byteLength(json);
      if (bytes > 8 * 1024 * 1024) throw new AcpConversationError("acp_conversation_event_limit");
      this.database
        .prepare("INSERT INTO acp_conversation_events(turn_id,sequence,event_json) VALUES (?,?,?)")
        .run(event.turnId, event.sequence, json);
      const status = event.payload.kind === "status" ? event.payload.status : "running";
      const error = event.payload.kind === "status" ? event.payload.error : null;
      this.database
        .prepare(
          "UPDATE acp_conversation_turns SET last_sequence=?,event_bytes=?,status=?,error=? WHERE turn_id=?"
        )
        .run(event.sequence, bytes, status, error, event.turnId);
    });
  }
}

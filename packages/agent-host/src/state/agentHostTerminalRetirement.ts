import { normalizedAcpEventBatchSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import {
  parseHistoricalAgentHostEvent,
  parseHistoricalAgentHostMailboxCommand
} from "../protocol.js";
import { AgentHostCancellationRepository } from "./agentHostCancellationRepository.js";
import { digestJson } from "./agentHostStateMigrations.js";
import {
  inboxAttemptIdSql,
  inboxDispatchIdSql,
  outboxAttemptIdSql,
  outboxDispatchIdSql,
  outboxMailboxSequenceSql,
  outboxOriginalMailboxAckSql
} from "./agentHostTerminalMaintenanceSchema.js";
import { toExecutionEvidence } from "./agentHostStateRecords.js";
import type { SqliteDatabase } from "./sqliteDatabase.js";

export const candidateSchema = z.object({
  inbox_sequence: z.number().int().positive(),
  dispatch_id: z.string().min(1),
  lease_id: z.string().min(1),
  execution_attempt_id: z.string().min(1),
  protocol_version: z.number().int().positive(),
  envelope_digest: z.string().min(1),
  envelope_version: z.number().int().positive(),
  workspace_id: z.string().min(1),
  agent_profile_id: z.string().min(1),
  source_revision: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  terminal_kind: z.enum(["completed", "failed", "cancelled"]),
  terminal_payload_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  terminal_event_message_id: z.string().min(1),
  terminal_acknowledged_at: z.string().datetime()
});

type TerminalCandidate = z.infer<typeof candidateSchema>;
const inboxRowSchema = z.object({
  sequence: z.number().int().positive(),
  previous_sequence: z.number().int().nonnegative(),
  message_id: z.string().min(1),
  command_json: z.string(),
  command_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  acknowledged_at: z.string().datetime().nullable(),
  processed_at: z.string().datetime().nullable()
});

const retirementSchema = z.object({
  inbox_sequence: z.number().int().positive(),
  compacted_at: z.string().datetime(),
  retained_mailbox: z.number().int().nonnegative()
});

const outboxPayloadBatchSize = 16;
const dependentKeyBatchSize = 64;

export const inboxIdentitySql = `${inboxDispatchIdSql}=? AND ${inboxAttemptIdSql}=?`;
export const outboxIdentitySql = `${outboxDispatchIdSql}=? AND ${outboxAttemptIdSql}=?`;
const originalMailboxAckSql = `${outboxOriginalMailboxAckSql} AND ${outboxMailboxSequenceSql}=?`;
const inboxFields =
  "sequence,previous_sequence,message_id,command_json,command_digest,acknowledged_at,processed_at";

export function commandIdentity(
  command: ReturnType<typeof parseHistoricalAgentHostMailboxCommand>
): { dispatchId: string; executionAttemptId: string } | undefined {
  return "dispatchId" in command && "executionAttemptId" in command
    ? { dispatchId: command.dispatchId, executionAttemptId: command.executionAttemptId }
    : undefined;
}

function validateAcknowledgedEvent(row: Record<string, unknown>) {
  if (!row.acknowledged_at) {
    throw new Error("agent_host_terminal_compaction_unacknowledged_event");
  }
  const input: unknown = JSON.parse(String(row.event_json));
  if (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    input.type === "acp.events" &&
    (!("eventProtocolVersion" in input) || input.eventProtocolVersion === 1)
  ) {
    return normalizedAcpEventBatchSchema.parse({
      type: "acp.events",
      dispatchId: "dispatchId" in input ? input.dispatchId : undefined,
      leaseId: "leaseId" in input ? input.leaseId : undefined,
      executionAttemptId: "executionAttemptId" in input ? input.executionAttemptId : undefined,
      acpSessionId: "acpSessionId" in input ? input.acpSessionId : undefined,
      afterCursor: "afterCursor" in input ? input.afterCursor : undefined,
      cursor: "cursor" in input ? input.cursor : undefined,
      events: "events" in input ? input.events : undefined
    });
  }
  return parseHistoricalAgentHostEvent(input);
}

export class AgentHostTerminalRetirementRepository {
  constructor(private readonly database: SqliteDatabase) {}

  active() {
    const row = this.database
      .prepare(
        "SELECT inbox_sequence,compacted_at,retained_mailbox FROM agent_host_terminal_retirement WHERE singleton=1"
      )
      .get();
    return row ? retirementSchema.parse(row) : undefined;
  }

  includes(sequence: number): boolean {
    return !!this.database
      .prepare(
        "SELECT 1 FROM agent_host_terminal_retirement WHERE singleton=1 AND inbox_sequence=?"
      )
      .get(sequence);
  }

  start(candidate: TerminalCandidate, compactedAt: string): void {
    this.primary(candidate);
    const execution = this.database
      .prepare("SELECT * FROM agent_host_executions WHERE inbox_sequence=?")
      .get(candidate.inbox_sequence);
    if (!execution) throw new Error("execution_evidence_not_found");
    new AgentHostCancellationRepository(this.database).archive(toExecutionEvidence(execution));
    this.database
      .prepare(
        `INSERT INTO agent_host_terminal_retirement(singleton,inbox_sequence,compacted_at)
         VALUES(1,?,?)`
      )
      .run(candidate.inbox_sequence, compactedAt);
  }

  advance(
    candidate: TerminalCandidate,
    compactedAt: string,
    mailboxBudget: number,
    retainedMailbox: number,
    retainMailbox: number
  ): {
    complete: boolean;
    prunedReceipts: number;
  } {
    const attempt = [candidate.dispatch_id, candidate.execution_attempt_id] as const;
    const sequence = candidate.inbox_sequence;
    const terminalEvent = this.terminalEvent(candidate);
    const outbox = this.database
      .prepare(
        `SELECT sequence,event_json,acknowledged_at
         FROM agent_host_outbox INDEXED BY idx_agent_host_outbox_attempt
         WHERE ${outboxIdentitySql} AND acknowledged_at IS NOT NULL AND sequence<>?
         ORDER BY acknowledged_at,sequence LIMIT ?`
      )
      .all(...attempt, terminalEvent.sequence, outboxPayloadBatchSize + 1);
    const deleteOutbox = this.database.prepare("DELETE FROM agent_host_outbox WHERE sequence=?");
    for (const row of outbox.slice(0, outboxPayloadBatchSize)) {
      validateAcknowledgedEvent(row);
      deleteOutbox.run(row.sequence);
    }

    const mailbox = this.retireMailbox(
      candidate,
      compactedAt,
      mailboxBudget,
      retainMailbox - retainedMailbox
    );
    if (mailbox.minted > 0) {
      this.database
        .prepare(
          "UPDATE agent_host_terminal_retirement SET retained_mailbox=retained_mailbox+? WHERE singleton=1"
        )
        .run(mailbox.minted);
    }
    const trim = () =>
      this.trimMailboxCapacity(candidate, compactedAt, retainMailbox, mailboxBudget);
    const deleteSources = this.database
      .prepare(
        `DELETE FROM agent_host_remote_execution_outbox WHERE sequence IN (
           SELECT sequence FROM agent_host_remote_execution_outbox INDEXED BY idx_agent_host_remote_execution_attempt
           WHERE dispatch_id=? AND execution_attempt_id=? ORDER BY sequence LIMIT ?
         )`
      )
      .run(...attempt, dependentKeyBatchSize);
    let childrenRemain = deleteSources.changes === dependentKeyBatchSize;
    for (const table of [
      "agent_host_execution_actions",
      "agent_host_execution_artifacts",
      "agent_host_execution_transitions"
    ]) {
      const removed = this.database
        .prepare(
          `DELETE FROM ${table} WHERE sequence IN (
             SELECT sequence FROM ${table} WHERE inbox_sequence=? ORDER BY sequence LIMIT ?
           )`
        )
        .run(sequence, dependentKeyBatchSize);
      childrenRemain ||= removed.changes === dependentKeyBatchSize;
    }

    if (
      outbox.length > outboxPayloadBatchSize ||
      mailbox.more ||
      childrenRemain ||
      mailbox.rows === mailboxBudget ||
      !this.retireMailboxRow(
        candidate,
        this.primary(candidate),
        compactedAt,
        retainedMailbox + mailbox.minted < retainMailbox,
        this.ackRowsForMailbox(candidate.inbox_sequence)
      )
    ) {
      return { complete: false, prunedReceipts: trim() };
    }
    const prunedReceipts = trim();
    this.finish(candidate, compactedAt);
    deleteOutbox.run(terminalEvent.sequence);
    this.database.prepare("DELETE FROM agent_host_terminal_retirement WHERE singleton=1").run();
    this.database.prepare("DELETE FROM agent_host_executions WHERE inbox_sequence=?").run(sequence);
    this.database.prepare("DELETE FROM agent_host_inbox WHERE sequence=?").run(sequence);
    return { complete: true, prunedReceipts };
  }

  private trimMailboxCapacity(
    candidate: TerminalCandidate,
    compactedAt: string,
    retained: number,
    budget: number
  ): number {
    const count = this.database
      .prepare("SELECT mailbox_count FROM agent_host_receipt_counts WHERE singleton=1")
      .get();
    const overflow = Math.min(budget, Number(count?.mailbox_count) - retained);
    if (overflow <= 0) return 0;
    const older = this.database
      .prepare(
        `DELETE FROM agent_host_compacted_mailbox_receipts WHERE sequence IN (
         SELECT sequence FROM agent_host_compacted_mailbox_receipts INDEXED BY idx_agent_host_compacted_mailbox_receipts_age
         WHERE compacted_at<? ORDER BY compacted_at,sequence LIMIT ?
       )`
      )
      .run(compactedAt, overflow);
    if (older.changes === overflow) return older.changes;
    const removed = this.database
      .prepare(
        `DELETE FROM agent_host_compacted_mailbox_receipts WHERE sequence IN (
         SELECT sequence FROM agent_host_compacted_mailbox_receipts INDEXED BY idx_agent_host_compacted_mailbox_receipts_age
         WHERE compacted_at=? ORDER BY sequence LIMIT ?
       ) AND NOT (dispatch_id=? AND execution_attempt_id=?)`
      )
      .run(
        compactedAt,
        overflow - older.changes,
        candidate.dispatch_id,
        candidate.execution_attempt_id
      );
    return older.changes + removed.changes;
  }

  private retireMailbox(
    candidate: TerminalCandidate,
    compactedAt: string,
    budget: number,
    retention: number
  ) {
    const attempt = [candidate.dispatch_id, candidate.execution_attempt_id] as const;
    const primarySequence = candidate.inbox_sequence;
    const childRows = this.database
      .prepare(
        `SELECT ${inboxFields} FROM agent_host_inbox INDEXED BY idx_agent_host_inbox_attempt
         WHERE ${inboxIdentitySql} AND sequence<>? ORDER BY sequence DESC LIMIT ?`
      )
      .all(...attempt, primarySequence, budget + 1);
    let rows = 0;
    let minted = 0;
    let ackBudget = budget;
    for (const input of childRows.slice(0, budget)) {
      const row = inboxRowSchema.parse(input);
      const acks = this.ackRowsForMailbox(row.sequence, ackBudget);
      const retain = minted < retention;
      const processed = this.retireMailboxRow(candidate, row, compactedAt, retain, acks, ackBudget);
      if (!processed) return { rows, minted, more: true };
      this.database.prepare("DELETE FROM agent_host_inbox WHERE sequence=?").run(row.sequence);
      rows += 1;
      if (retain) minted += 1;
      ackBudget -= acks.length;
      if (ackBudget === 0) break;
    }
    return { rows, minted, more: childRows.length > rows };
  }

  private ackRowsForMailbox(sequence: number, budget = outboxPayloadBatchSize) {
    return this.database
      .prepare(
        `SELECT sequence,event_json,acknowledged_at
         FROM agent_host_outbox INDEXED BY idx_agent_host_outbox_original_mailbox_ack
         WHERE ${originalMailboxAckSql} ORDER BY acknowledged_at,sequence LIMIT ?`
      )
      .all(sequence, budget + 1);
  }

  private retireMailboxRow(
    candidate: TerminalCandidate,
    row: z.infer<typeof inboxRowSchema>,
    compactedAt: string,
    retain: boolean,
    acks: ReturnType<AgentHostTerminalRetirementRepository["ackRowsForMailbox"]>,
    budget = outboxPayloadBatchSize
  ): boolean {
    const command = parseHistoricalAgentHostMailboxCommand(JSON.parse(row.command_json));
    const identity = commandIdentity(command);
    if (row.command_digest !== digestJson(command)) {
      throw new Error("agent_host_terminal_compaction_command_digest_invalid");
    }
    if (
      !row.acknowledged_at ||
      (row.sequence !== candidate.inbox_sequence && !row.processed_at) ||
      !identity ||
      identity.dispatchId !== candidate.dispatch_id ||
      identity.executionAttemptId !== candidate.execution_attempt_id
    ) {
      throw new Error("agent_host_terminal_compaction_dependency_identity_invalid");
    }
    for (const ack of acks.slice(0, budget)) {
      const event = validateAcknowledgedEvent(ack);
      if (event.type !== "mailbox.ack" || event.sequence !== row.sequence) {
        throw new Error("agent_host_terminal_compaction_outbox_identity_invalid");
      }
      this.database.prepare("DELETE FROM agent_host_outbox WHERE sequence=?").run(ack.sequence);
    }
    if (acks.length > budget) return false;
    if (!retain) return true;
    this.database
      .prepare(
        `INSERT INTO agent_host_compacted_mailbox_receipts(
           sequence,previous_sequence,message_id,command_type,command_digest,
           dispatch_id,execution_attempt_id,compacted_at
         ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        row.sequence,
        row.previous_sequence,
        row.message_id,
        command.type,
        row.command_digest,
        identity.dispatchId,
        identity.executionAttemptId,
        compactedAt
      );
    return true;
  }

  private primary(candidate: TerminalCandidate) {
    if (candidate.status !== candidate.terminal_kind) {
      throw new Error("agent_host_terminal_compaction_evidence_invalid");
    }
    const primary = this.database
      .prepare(`SELECT ${inboxFields} FROM agent_host_inbox WHERE sequence=?`)
      .get(candidate.inbox_sequence);
    if (!primary) throw new Error("agent_host_terminal_compaction_inbox_missing");
    const primaryRow = inboxRowSchema.parse(primary);
    const primaryCommand = parseHistoricalAgentHostMailboxCommand(
      JSON.parse(primaryRow.command_json)
    );
    if (
      primaryCommand.type !== "execute_block" ||
      primaryRow.command_digest !== digestJson(primaryCommand) ||
      primaryCommand.dispatchId !== candidate.dispatch_id ||
      primaryCommand.executionAttemptId !== candidate.execution_attempt_id ||
      primaryCommand.protocolVersion !== candidate.protocol_version ||
      primaryCommand.envelopeDigest !== candidate.envelope_digest ||
      primaryCommand.envelope.protocolVersion !== candidate.envelope_version ||
      primaryCommand.envelope.workspaceId !== candidate.workspace_id ||
      primaryCommand.envelope.agentProfileId !== candidate.agent_profile_id ||
      primaryCommand.envelope.sourceRevision !== candidate.source_revision
    ) {
      throw new Error("agent_host_terminal_compaction_identity_invalid");
    }
    return primaryRow;
  }

  private terminalEvent(candidate: TerminalCandidate) {
    const row = this.database
      .prepare(
        `SELECT sequence,event_json,acknowledged_at FROM agent_host_outbox
         WHERE message_id=? AND ${outboxIdentitySql}`
      )
      .get(
        candidate.terminal_event_message_id,
        candidate.dispatch_id,
        candidate.execution_attempt_id
      );
    if (!row) throw new Error("agent_host_terminal_compaction_terminal_event_missing");
    validateAcknowledgedEvent(row);
    return row;
  }

  private finish(candidate: TerminalCandidate, compactedAt: string): void {
    const primaryRow = this.primary(candidate);
    this.database
      .prepare(
        `INSERT INTO agent_host_terminal_execution_receipts(
          dispatch_id,execution_attempt_id,inbox_sequence,previous_sequence,message_id,
          command_digest,lease_id,protocol_version,envelope_digest,envelope_version,workspace_id,
          agent_profile_id,source_revision,terminal_kind,terminal_payload_digest,
          terminal_event_message_id,terminal_acknowledged_at,compacted_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        candidate.dispatch_id,
        candidate.execution_attempt_id,
        primaryRow.sequence,
        primaryRow.previous_sequence,
        primaryRow.message_id,
        primaryRow.command_digest,
        candidate.lease_id,
        candidate.protocol_version,
        candidate.envelope_digest,
        candidate.envelope_version,
        candidate.workspace_id,
        candidate.agent_profile_id,
        candidate.source_revision,
        candidate.terminal_kind,
        candidate.terminal_payload_digest,
        candidate.terminal_event_message_id,
        candidate.terminal_acknowledged_at,
        compactedAt
      );
  }
}

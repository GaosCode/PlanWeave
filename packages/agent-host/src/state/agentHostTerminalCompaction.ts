import { z } from "zod";
import {
  parseAgentHostEvent,
  parseAgentHostMailboxCommand,
  type ServerEvent
} from "../protocol.js";
import { digestJson } from "./agentHostStateMigrations.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqliteDatabase.js";

type MailboxMessage = Extract<ServerEvent, { type: "mailbox.message" }>;

export type AgentHostTerminalCompactionPolicy = {
  maxReceipts: number;
  maxMailboxReceipts: number;
  maxReceiptAgeDays: number;
  compactionBatchSize: number;
  receiptPruneBatchSize: number;
  mailboxReceiptPruneBatchSize: number;
};

export const DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY: AgentHostTerminalCompactionPolicy = {
  maxReceipts: 4_096,
  maxMailboxReceipts: 16_384,
  maxReceiptAgeDays: 90,
  compactionBatchSize: 32,
  receiptPruneBatchSize: 64,
  mailboxReceiptPruneBatchSize: 256
};

const candidateSchema = z.object({
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

const inboxRowSchema = z.object({
  sequence: z.number().int().positive(),
  previous_sequence: z.number().int().nonnegative(),
  message_id: z.string().min(1),
  command_json: z.string(),
  command_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  acknowledged_at: z.string().datetime().nullable(),
  processed_at: z.string().datetime().nullable()
});

const receiptRowSchema = z.object({
  dispatch_id: z.string().min(1),
  execution_attempt_id: z.string().min(1),
  inbox_sequence: z.number().int().positive(),
  previous_sequence: z.number().int().nonnegative(),
  message_id: z.string().min(1),
  command_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});

const mailboxReceiptRowSchema = z.object({
  sequence: z.number().int().positive(),
  previous_sequence: z.number().int().nonnegative(),
  message_id: z.string().min(1),
  command_type: z.string().min(1),
  command_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  dispatch_id: z.string().min(1),
  execution_attempt_id: z.string().min(1)
});

function parsePolicy(
  input: Partial<AgentHostTerminalCompactionPolicy>
): AgentHostTerminalCompactionPolicy {
  const policy = { ...DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY, ...input };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`agent_host_terminal_compaction_${name}_invalid`);
    }
  }
  return policy;
}

function commandIdentity(
  command: ReturnType<typeof parseAgentHostMailboxCommand>
): { dispatchId: string; executionAttemptId: string } | undefined {
  return "dispatchId" in command && "executionAttemptId" in command
    ? {
        dispatchId: command.dispatchId,
        executionAttemptId: command.executionAttemptId
      }
    : undefined;
}

export class AgentHostTerminalCompactionRepository {
  private readonly policy: AgentHostTerminalCompactionPolicy;

  constructor(
    private readonly database: SqliteDatabase,
    policy: Partial<AgentHostTerminalCompactionPolicy> = {}
  ) {
    this.policy = parsePolicy(policy);
  }

  compact(now = new Date()): { compacted: number; prunedReceipts: number } {
    return inWriteTransaction(this.database, () => this.compactInCurrentTransaction(now));
  }

  compactInCurrentTransaction(now = new Date()): {
    compacted: number;
    prunedReceipts: number;
  } {
    const candidates = this.database
      .prepare(
        `SELECT e.inbox_sequence,e.dispatch_id,e.lease_id,e.execution_attempt_id,e.protocol_version,
                e.envelope_digest,e.envelope_version,e.workspace_id,e.agent_profile_id,
                e.source_revision,e.status,e.terminal_kind,e.terminal_payload_digest,
                e.terminal_event_message_id,e.terminal_acknowledged_at
         FROM agent_host_executions e
         WHERE e.status IN ('completed','failed','cancelled')
           AND e.terminal_acknowledged_at IS NOT NULL
           AND NOT EXISTS(
             SELECT 1 FROM agent_host_execution_actions a
             WHERE a.inbox_sequence=e.inbox_sequence AND a.settled_at IS NULL
           )
           AND NOT EXISTS(
             SELECT 1 FROM agent_host_inbox i
             WHERE (
               i.sequence=e.inbox_sequence OR (
                 json_extract(i.command_json,'$.dispatchId')=e.dispatch_id AND
                 json_extract(i.command_json,'$.executionAttemptId')=e.execution_attempt_id
               )
             ) AND (
               i.acknowledged_at IS NULL OR
               (i.sequence<>e.inbox_sequence AND i.processed_at IS NULL)
             )
           )
           AND NOT EXISTS(
             SELECT 1 FROM agent_host_outbox o
             WHERE o.acknowledged_at IS NULL AND (
               (
                 json_extract(o.event_json,'$.dispatchId')=e.dispatch_id AND
                 json_extract(o.event_json,'$.executionAttemptId')=e.execution_attempt_id
               ) OR (
                 json_extract(o.event_json,'$.type')='mailbox.ack' AND
                 json_extract(o.event_json,'$.sequence') IN (
                   SELECT i.sequence FROM agent_host_inbox i
                   WHERE i.sequence=e.inbox_sequence OR (
                     json_extract(i.command_json,'$.dispatchId')=e.dispatch_id AND
                     json_extract(i.command_json,'$.executionAttemptId')=e.execution_attempt_id
                   )
                 )
               )
             )
           )
         ORDER BY e.terminal_acknowledged_at,e.inbox_sequence
         LIMIT ?`
      )
      .all(this.policy.compactionBatchSize)
      .map((row) => candidateSchema.parse(row));
    let compacted = 0;
    for (const candidate of candidates) {
      if (this.compactCandidate(candidate, now.toISOString())) compacted += 1;
    }
    return { compacted, prunedReceipts: this.pruneReceipts(now) };
  }

  inspectMailboxReplay(event: MailboxMessage, commandDigest: string): "new" | "compacted" {
    const identity = commandIdentity(event.command);
    const mailboxReceiptRaw = this.database
      .prepare(
        `SELECT sequence,previous_sequence,message_id,command_type,command_digest,
                dispatch_id,execution_attempt_id
         FROM agent_host_compacted_mailbox_receipts
         WHERE sequence=? OR message_id=?`
      )
      .get(event.sequence, event.messageId);
    if (mailboxReceiptRaw) {
      const receipt = mailboxReceiptRowSchema.parse(mailboxReceiptRaw);
      if (
        identity &&
        receipt.command_type === "execute_block" &&
        event.command.type === "execute_block" &&
        receipt.dispatch_id === identity.dispatchId &&
        receipt.execution_attempt_id === identity.executionAttemptId &&
        receipt.command_digest !== commandDigest
      ) {
        throw new Error("execution_identity_conflict");
      }
      if (
        !identity ||
        receipt.sequence !== event.sequence ||
        receipt.previous_sequence !== event.previousSequence ||
        receipt.message_id !== event.messageId ||
        receipt.command_type !== event.command.type ||
        receipt.command_digest !== commandDigest ||
        receipt.dispatch_id !== identity.dispatchId ||
        receipt.execution_attempt_id !== identity.executionAttemptId
      ) {
        throw new Error("mailbox_message_conflict");
      }
      return "compacted";
    }
    if (event.sequence <= this.receivedHighWater()) {
      throw new Error("mailbox_message_retention_horizon_exceeded");
    }
    if (!identity) return "new";
    const terminalReceiptRaw = this.database
      .prepare(
        `SELECT dispatch_id,execution_attempt_id,inbox_sequence,previous_sequence,message_id,
                command_digest
         FROM agent_host_terminal_execution_receipts
         WHERE dispatch_id=? AND execution_attempt_id=?`
      )
      .get(identity.dispatchId, identity.executionAttemptId);
    if (terminalReceiptRaw) {
      const receipt = receiptRowSchema.parse(terminalReceiptRaw);
      if (event.command.type === "execute_block" && receipt.command_digest !== commandDigest) {
        throw new Error("execution_identity_conflict");
      }
      throw new Error("mailbox_message_conflict");
    }
    const relatedMailboxReceipt = this.database
      .prepare(
        `SELECT 1 AS present FROM agent_host_compacted_mailbox_receipts
         WHERE dispatch_id=? AND execution_attempt_id=? LIMIT 1`
      )
      .get(identity.dispatchId, identity.executionAttemptId);
    if (relatedMailboxReceipt) {
      throw new Error("mailbox_message_conflict");
    }
    return "new";
  }

  receivedHighWater(): number {
    const row = this.database
      .prepare(
        `SELECT received_high_water_sequence FROM agent_host_mailbox_checkpoint
         WHERE singleton=1`
      )
      .get();
    if (!row) throw new Error("agent_host_mailbox_checkpoint_missing");
    return z.number().int().nonnegative().parse(row.received_high_water_sequence);
  }

  recordReceived(sequence: number): void {
    const updated = this.database
      .prepare(
        `UPDATE agent_host_mailbox_checkpoint SET received_high_water_sequence=?
         WHERE singleton=1 AND received_high_water_sequence<?`
      )
      .run(sequence, sequence);
    if (updated.changes !== 1) throw new Error("agent_host_mailbox_checkpoint_conflict");
  }

  recordAcknowledged(sequence: number): void {
    this.database
      .prepare(
        `UPDATE agent_host_mailbox_checkpoint
         SET acknowledged_high_water_sequence=MAX(acknowledged_high_water_sequence,?)
         WHERE singleton=1`
      )
      .run(sequence);
  }

  lastAcknowledgedSequence(): number {
    const row = this.database
      .prepare(
        `SELECT acknowledged_high_water_sequence FROM agent_host_mailbox_checkpoint
         WHERE singleton=1`
      )
      .get();
    if (!row) throw new Error("agent_host_mailbox_checkpoint_missing");
    return z.number().int().nonnegative().parse(row.acknowledged_high_water_sequence);
  }

  private compactCandidate(
    candidate: z.infer<typeof candidateSchema>,
    compactedAt: string
  ): boolean {
    if (candidate.status !== candidate.terminal_kind) {
      throw new Error("agent_host_terminal_compaction_evidence_invalid");
    }
    const inboxRows = this.database
      .prepare(
        `SELECT sequence,previous_sequence,message_id,command_json,command_digest,
                acknowledged_at,processed_at
         FROM agent_host_inbox
         WHERE sequence=? OR (
           json_extract(command_json,'$.dispatchId')=? AND
           json_extract(command_json,'$.executionAttemptId')=?
         ) ORDER BY sequence`
      )
      .all(candidate.inbox_sequence, candidate.dispatch_id, candidate.execution_attempt_id)
      .map((row) => inboxRowSchema.parse(row));
    const primary = inboxRows.find((row) => row.sequence === candidate.inbox_sequence);
    if (!primary) throw new Error("agent_host_terminal_compaction_inbox_missing");
    const primaryCommand = parseAgentHostMailboxCommand(JSON.parse(primary.command_json));
    if (
      primaryCommand.type !== "execute_block" ||
      primary.command_digest !== digestJson(primaryCommand) ||
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
    for (const row of inboxRows) {
      const command = parseAgentHostMailboxCommand(JSON.parse(row.command_json));
      if (row.command_digest !== digestJson(command)) {
        throw new Error("agent_host_terminal_compaction_command_digest_invalid");
      }
      const identity = commandIdentity(command);
      if (
        !identity ||
        identity.dispatchId !== candidate.dispatch_id ||
        identity.executionAttemptId !== candidate.execution_attempt_id
      ) {
        throw new Error("agent_host_terminal_compaction_dependency_identity_invalid");
      }
      if (!row.acknowledged_at || (row.sequence !== primary.sequence && !row.processed_at)) {
        return false;
      }
    }
    const unsettled = this.database
      .prepare(
        `SELECT 1 AS present FROM agent_host_execution_actions
         WHERE inbox_sequence=? AND settled_at IS NULL LIMIT 1`
      )
      .get(candidate.inbox_sequence);
    if (unsettled) return false;

    const inboxSequences = inboxRows.map((row) => row.sequence);
    const placeholders = inboxSequences.map(() => "?").join(",");
    const outboxRows = this.database
      .prepare(
        `SELECT sequence,message_id,event_json,acknowledged_at FROM agent_host_outbox
         WHERE (
           json_extract(event_json,'$.dispatchId')=? AND
           json_extract(event_json,'$.executionAttemptId')=?
         ) OR (
           json_extract(event_json,'$.type')='mailbox.ack' AND
           json_extract(event_json,'$.sequence') IN (${placeholders})
         ) ORDER BY sequence`
      )
      .all(candidate.dispatch_id, candidate.execution_attempt_id, ...inboxSequences);
    let terminalEventFound = false;
    for (const row of outboxRows) {
      const event = parseAgentHostEvent(JSON.parse(String(row.event_json)));
      if (!row.acknowledged_at) return false;
      if (String(row.message_id) === candidate.terminal_event_message_id) {
        terminalEventFound = true;
      }
      if (event.type === "mailbox.ack" && !inboxSequences.includes(event.sequence)) {
        throw new Error("agent_host_terminal_compaction_outbox_identity_invalid");
      }
    }
    if (!terminalEventFound)
      throw new Error("agent_host_terminal_compaction_terminal_event_missing");

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
        primary.sequence,
        primary.previous_sequence,
        primary.message_id,
        primary.command_digest,
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
    for (const row of inboxRows) {
      const command = parseAgentHostMailboxCommand(JSON.parse(row.command_json));
      const identity = commandIdentity(command);
      if (!identity) throw new Error("agent_host_terminal_compaction_dependency_identity_invalid");
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
    }
    const outboxSequences = outboxRows.map((row) => Number(row.sequence));
    if (outboxSequences.length > 0) {
      this.database
        .prepare(
          `DELETE FROM agent_host_outbox WHERE sequence IN (${outboxSequences.map(() => "?").join(",")})`
        )
        .run(...outboxSequences);
    }
    this.database
      .prepare(
        `DELETE FROM agent_host_remote_execution_outbox
         WHERE dispatch_id=? AND execution_attempt_id=?`
      )
      .run(candidate.dispatch_id, candidate.execution_attempt_id);
    this.database
      .prepare("DELETE FROM agent_host_execution_actions WHERE inbox_sequence=?")
      .run(candidate.inbox_sequence);
    this.database
      .prepare("DELETE FROM agent_host_execution_artifacts WHERE inbox_sequence=?")
      .run(candidate.inbox_sequence);
    this.database
      .prepare("DELETE FROM agent_host_execution_transitions WHERE inbox_sequence=?")
      .run(candidate.inbox_sequence);
    this.database
      .prepare("DELETE FROM agent_host_executions WHERE inbox_sequence=?")
      .run(candidate.inbox_sequence);
    this.database
      .prepare(`DELETE FROM agent_host_inbox WHERE sequence IN (${placeholders})`)
      .run(...inboxSequences);
    return true;
  }

  private pruneReceipts(now: Date): number {
    const cutoff = new Date(
      now.getTime() - this.policy.maxReceiptAgeDays * 24 * 60 * 60 * 1_000
    ).toISOString();
    const rows = this.database
      .prepare(
        `SELECT dispatch_id,execution_attempt_id FROM agent_host_terminal_execution_receipts
         WHERE compacted_at<?
            OR inbox_sequence NOT IN (
              SELECT inbox_sequence FROM agent_host_terminal_execution_receipts
              ORDER BY compacted_at DESC,inbox_sequence DESC LIMIT ?
            )
         ORDER BY compacted_at,inbox_sequence LIMIT ?`
      )
      .all(cutoff, this.policy.maxReceipts, this.policy.receiptPruneBatchSize);
    for (const row of rows) {
      this.database
        .prepare(
          `DELETE FROM agent_host_compacted_mailbox_receipts
           WHERE dispatch_id=? AND execution_attempt_id=?`
        )
        .run(String(row.dispatch_id), String(row.execution_attempt_id));
      this.database
        .prepare(
          `DELETE FROM agent_host_terminal_execution_receipts
           WHERE dispatch_id=? AND execution_attempt_id=?`
        )
        .run(String(row.dispatch_id), String(row.execution_attempt_id));
    }
    const terminalPruned = rows.length;
    const mailboxRows = this.database
      .prepare(
        `SELECT sequence FROM agent_host_compacted_mailbox_receipts
         WHERE compacted_at<?
            OR sequence NOT IN (
              SELECT sequence FROM agent_host_compacted_mailbox_receipts
              ORDER BY compacted_at DESC,sequence DESC LIMIT ?
            )
         ORDER BY compacted_at,sequence LIMIT ?`
      )
      .all(cutoff, this.policy.maxMailboxReceipts, this.policy.mailboxReceiptPruneBatchSize);
    for (const row of mailboxRows) {
      this.database
        .prepare("DELETE FROM agent_host_compacted_mailbox_receipts WHERE sequence=?")
        .run(Number(row.sequence));
    }
    return terminalPruned + mailboxRows.length;
  }
}

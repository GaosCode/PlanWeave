import { z } from "zod";
import { type ServerEvent, type HistoricalMailboxCommand } from "../protocol.js";
import {
  acknowledgedReplayAckSql,
  acknowledgedTerminalExecutionSql,
  inboxAttemptIdSql,
  inboxDispatchIdSql
} from "./agentHostTerminalMaintenanceSchema.js";
import {
  AgentHostTerminalRetirementRepository,
  candidateSchema,
  commandIdentity,
  inboxIdentitySql,
  outboxIdentitySql
} from "./agentHostTerminalRetirement.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqliteDatabase.js";

type MailboxMessage = Pick<
  Extract<ServerEvent, { type: "mailbox.message" }>,
  "sequence" | "previousSequence" | "messageId"
> & { command: HistoricalMailboxCommand };

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

export const TERMINAL_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type TerminalCompactionCursor = { acknowledgedAt: string; sequence: number };
type TerminalCompactionBatch = {
  compacted: number;
  prunedReceipts: number;
  needsPruning: boolean;
  nextCandidate?: TerminalCompactionCursor;
};

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

export class AgentHostTerminalCompactionRepository {
  private readonly policy: AgentHostTerminalCompactionPolicy;
  private readonly retirement: AgentHostTerminalRetirementRepository;

  constructor(
    private readonly database: SqliteDatabase,
    policy: Partial<AgentHostTerminalCompactionPolicy> = {}
  ) {
    this.policy = parsePolicy(policy);
    this.retirement = new AgentHostTerminalRetirementRepository(database);
  }

  compact(now = new Date(), after?: TerminalCompactionCursor): TerminalCompactionBatch {
    return inWriteTransaction(this.database, () => {
      const active = this.retirement.active();
      const pruning = this.pruneReceipts(now, active?.inbox_sequence);
      if (pruning.needsPruning && !active) {
        return { compacted: 0, ...pruning, nextCandidate: after };
      }
      const candidates = active
        ? [
            this.database
              .prepare(`SELECT * FROM agent_host_executions WHERE inbox_sequence=?`)
              .get(active.inbox_sequence)
          ]
        : this.terminalCandidates(after);
      let nextCandidate = after;
      let visited = 0;
      const rowBudget = Math.min(64, this.policy.mailboxReceiptPruneBatchSize);
      for (const row of candidates.slice(0, this.policy.compactionBatchSize)) {
        const candidate = candidateSchema.parse(row);
        const cursor = {
          acknowledgedAt: candidate.terminal_acknowledged_at,
          sequence: candidate.inbox_sequence
        };
        const attempt = [candidate.dispatch_id, candidate.execution_attempt_id] as const;
        visited += 1;
        if (active || this.hasNoPendingDependencies(candidate.inbox_sequence, ...attempt)) {
          const compactedAt = active?.compacted_at ?? now.toISOString();
          if (!active) this.retirement.start(candidate, compactedAt);
          const result = this.retirement.advance(
            candidate,
            compactedAt,
            rowBudget,
            active?.retained_mailbox ?? 0,
            this.policy.maxMailboxReceipts
          );
          return {
            compacted: result.complete ? 1 : 0,
            prunedReceipts: pruning.prunedReceipts + result.prunedReceipts,
            needsPruning: true,
            nextCandidate: result.complete ? cursor : nextCandidate
          };
        }
        nextCandidate = cursor;
      }
      return {
        compacted: 0,
        ...pruning,
        ...(candidates.length > visited ? { nextCandidate } : {})
      };
    });
  }

  private terminalCandidates(after?: TerminalCompactionCursor) {
    const query = `SELECT inbox_sequence,dispatch_id,lease_id,execution_attempt_id,protocol_version,
                          envelope_digest,envelope_version,workspace_id,agent_profile_id,
                          source_revision,status,terminal_kind,terminal_payload_digest,
                          terminal_event_message_id,terminal_acknowledged_at
                   FROM agent_host_executions INDEXED BY idx_agent_host_terminal_maintenance
                   WHERE ${acknowledgedTerminalExecutionSql}`;
    const order = "ORDER BY terminal_acknowledged_at,inbox_sequence LIMIT ?";
    const limit = this.policy.compactionBatchSize + 1;
    if (!after) return this.database.prepare(`${query} ${order}`).all(limit);
    const tied = this.database
      .prepare(`${query} AND terminal_acknowledged_at=? AND inbox_sequence>? ${order}`)
      .all(after.acknowledgedAt, after.sequence, limit);
    if (tied.length === limit) return tied;
    const later = this.database
      .prepare(`${query} AND terminal_acknowledged_at>? ${order}`)
      .all(after.acknowledgedAt, limit - tied.length);
    return tied.concat(later);
  }

  nextReceiptExpiryMs(): number | undefined {
    const terminal = this.database
      .prepare(
        `SELECT compacted_at FROM agent_host_terminal_execution_receipts
         ORDER BY compacted_at,inbox_sequence LIMIT 1`
      )
      .get();
    const mailbox = this.database
      .prepare(
        `SELECT compacted_at FROM agent_host_compacted_mailbox_receipts
         ORDER BY compacted_at,sequence LIMIT 1`
      )
      .get();
    const oldest = Math.min(
      terminal
        ? z.string().datetime().transform(Date.parse).parse(terminal.compacted_at)
        : Infinity,
      mailbox ? z.string().datetime().transform(Date.parse).parse(mailbox.compacted_at) : Infinity
    );
    return Number.isFinite(oldest)
      ? oldest + this.policy.maxReceiptAgeDays * TERMINAL_MAINTENANCE_INTERVAL_MS + 1
      : undefined;
  }

  hasAcknowledgedTerminalAttempt(dispatchId: string, executionAttemptId: string): boolean {
    return this.acknowledgedTerminalAttempt(dispatchId, executionAttemptId) !== undefined;
  }

  hasAcknowledgedTerminalForMailbox(sequence: number): boolean {
    const row = this.database
      .prepare(
        `SELECT ${inboxDispatchIdSql} AS dispatchId,${inboxAttemptIdSql} AS attemptId
         FROM agent_host_inbox WHERE sequence=?`
      )
      .get(sequence);
    return (
      typeof row?.dispatchId === "string" &&
      typeof row.attemptId === "string" &&
      this.hasAcknowledgedTerminalAttempt(row.dispatchId, row.attemptId)
    );
  }

  isRetiringAttempt(dispatchId: string, executionAttemptId: string): boolean {
    const attempt = this.acknowledgedTerminalAttempt(dispatchId, executionAttemptId);
    return attempt !== undefined && this.retirement.includes(Number(attempt.inbox_sequence));
  }

  isRetiringSequence(sequence: number): boolean {
    return this.retirement.includes(sequence);
  }

  isReadyToCompact(dispatchId: string, executionAttemptId: string): boolean {
    const attempt = this.acknowledgedTerminalAttempt(dispatchId, executionAttemptId);
    return (
      attempt !== undefined &&
      (this.retirement.includes(Number(attempt.inbox_sequence)) ||
        this.hasNoPendingDependencies(
          Number(attempt.inbox_sequence),
          dispatchId,
          executionAttemptId
        ))
    );
  }

  private acknowledgedTerminalAttempt(dispatchId: string, executionAttemptId: string) {
    return this.database
      .prepare(
        `SELECT inbox_sequence FROM agent_host_executions
         WHERE dispatch_id=? AND execution_attempt_id=? AND ${acknowledgedTerminalExecutionSql}`
      )
      .get(dispatchId, executionAttemptId);
  }

  private hasNoPendingDependencies(
    sequence: number,
    dispatchId: string,
    executionAttemptId: string
  ): boolean {
    const attempt = [dispatchId, executionAttemptId] as const;
    return !this.database
      .prepare(
        `SELECT 1 WHERE
         EXISTS(
           SELECT 1 FROM agent_host_execution_actions
           WHERE inbox_sequence=? AND settled_at IS NULL
         ) OR EXISTS(
           SELECT 1 FROM agent_host_inbox WHERE sequence=? AND acknowledged_at IS NULL
         ) OR EXISTS(
           SELECT 1 FROM agent_host_inbox INDEXED BY idx_agent_host_inbox_attempt_unacknowledged
           WHERE ${inboxIdentitySql} AND acknowledged_at IS NULL
         ) OR EXISTS(
           SELECT 1 FROM agent_host_inbox INDEXED BY idx_agent_host_inbox_attempt_unprocessed
           WHERE ${inboxIdentitySql} AND processed_at IS NULL AND sequence<>?
         ) OR EXISTS(
           SELECT 1 FROM agent_host_outbox INDEXED BY idx_agent_host_outbox_attempt
           WHERE ${outboxIdentitySql} AND acknowledged_at IS NULL
         ) OR EXISTS(
           SELECT 1 FROM agent_host_pending_mailbox_acks WHERE mailbox_sequence=?
         ) OR EXISTS(
           SELECT 1 FROM agent_host_pending_mailbox_acks WHERE dispatch_id=? AND execution_attempt_id=?
         )`
      )
      .get(sequence, sequence, ...attempt, ...attempt, sequence, ...attempt, sequence, ...attempt);
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
    const pending = this.acknowledgedTerminalAttempt(
      identity.dispatchId,
      identity.executionAttemptId
    );
    if (pending && this.isReadyToCompact(identity.dispatchId, identity.executionAttemptId)) {
      const primary = this.database
        .prepare("SELECT command_digest FROM agent_host_inbox WHERE sequence=?")
        .get(Number(pending.inbox_sequence));
      if (!primary) throw new Error("agent_host_terminal_compaction_inbox_missing");
      if (event.command.type === "execute_block" && primary.command_digest !== commandDigest) {
        throw new Error("execution_identity_conflict");
      }
      throw new Error("mailbox_message_conflict");
    }
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

  private pruneReceipts(
    now: Date,
    retiringSequence?: number
  ): { prunedReceipts: number; needsPruning: boolean } {
    const cutoff = new Date(
      now.getTime() - this.policy.maxReceiptAgeDays * TERMINAL_MAINTENANCE_INTERVAL_MS
    ).toISOString();
    const rows = this.receiptPruneCandidates(
      "terminal_execution",
      cutoff,
      this.policy.maxReceipts,
      this.policy.receiptPruneBatchSize
    );
    let terminalPruned = 0;
    let cascadeBudget = this.policy.mailboxReceiptPruneBatchSize;
    for (const row of rows.slice(0, this.policy.receiptPruneBatchSize)) {
      const attempt = [row.dispatch_id, row.execution_attempt_id] as const;
      const cancellation = this.database
        .prepare(
          `DELETE FROM agent_host_execution_cancellation_history WHERE rowid IN (
             SELECT rowid FROM agent_host_execution_cancellation_history INDEXED BY idx_agent_host_cancellation_attempt
             WHERE dispatch_id=? AND execution_attempt_id=? LIMIT ?
           )`
        )
        .run(...attempt, cascadeBudget);
      cascadeBudget -= cancellation.changes;
      const mailbox = this.database
        .prepare(
          `DELETE FROM agent_host_compacted_mailbox_receipts WHERE sequence IN (
             SELECT sequence FROM agent_host_compacted_mailbox_receipts
             INDEXED BY idx_agent_host_compacted_mailbox_attempt_sequence
             WHERE dispatch_id=? AND execution_attempt_id=? ORDER BY sequence LIMIT ?
           )`
        )
        .run(...attempt, cascadeBudget);
      cascadeBudget -= mailbox.changes;
      if (
        cascadeBudget === 0 &&
        this.database
          .prepare(
            `SELECT 1 WHERE EXISTS (
             SELECT 1 FROM agent_host_execution_cancellation_history WHERE dispatch_id=? AND execution_attempt_id=?
           ) OR EXISTS (
             SELECT 1 FROM agent_host_compacted_mailbox_receipts WHERE dispatch_id=? AND execution_attempt_id=?
           )`
          )
          .get(...attempt, ...attempt)
      )
        break;
      this.database
        .prepare(
          `DELETE FROM agent_host_terminal_execution_receipts WHERE dispatch_id=? AND execution_attempt_id=?`
        )
        .run(...attempt);
      terminalPruned += 1;
      if (cascadeBudget === 0) break;
    }
    const mailboxRows =
      retiringSequence === undefined
        ? this.receiptPruneCandidates(
            "compacted_mailbox",
            cutoff,
            this.policy.maxMailboxReceipts,
            cascadeBudget
          )
        : [];
    const mailboxPruned = Math.min(mailboxRows.length, cascadeBudget);
    const deleteMailboxReceipt = this.database.prepare(
      "DELETE FROM agent_host_compacted_mailbox_receipts WHERE sequence=?"
    );
    for (const row of mailboxRows.slice(0, mailboxPruned)) {
      deleteMailboxReceipt.run(row.sequence);
    }
    const replayPruneBudget = cascadeBudget - mailboxPruned;
    const replayAcks = this.database
      .prepare(
        `SELECT sequence FROM agent_host_outbox INDEXED BY idx_agent_host_acknowledged_replay_ack
         WHERE ${acknowledgedReplayAckSql} ORDER BY sequence LIMIT ?`
      )
      .all(replayPruneBudget + 1);
    const replayPruned = Math.min(replayAcks.length, replayPruneBudget);
    const deleteReplayAck = this.database.prepare("DELETE FROM agent_host_outbox WHERE sequence=?");
    for (const row of replayAcks.slice(0, replayPruned)) deleteReplayAck.run(row.sequence);
    return {
      prunedReceipts: terminalPruned + mailboxPruned,
      needsPruning:
        rows.length > terminalPruned ||
        mailboxRows.length > mailboxPruned ||
        replayAcks.length > replayPruned
    };
  }
  private receiptPruneCandidates(
    type: "terminal_execution" | "compacted_mailbox",
    cutoff: string,
    retained: number,
    batchSize: number
  ) {
    const terminal = type === "terminal_execution";
    const table = `agent_host_${type}_receipts`;
    const sequence = terminal ? "inbox_sequence" : "sequence";
    const fields = terminal ? "dispatch_id,execution_attempt_id" : sequence;
    const order = `compacted_at,${sequence}`;
    const index = terminal
      ? "idx_agent_host_terminal_receipts_age"
      : "idx_agent_host_compacted_mailbox_receipts_age";
    const threshold = this.database
      .prepare(
        `SELECT compacted_at,${sequence} AS sequence FROM ${table} INDEXED BY ${index}
         ORDER BY compacted_at DESC,${sequence} DESC LIMIT 1 OFFSET ?`
      )
      .get(retained - 1);
    const thresholdAt =
      typeof threshold?.compacted_at === "string" ? threshold.compacted_at : cutoff;
    const upperTime = thresholdAt > cutoff ? thresholdAt : cutoff;
    const limit = batchSize + 1;
    const older = this.database
      .prepare(
        `SELECT ${fields} FROM ${table} INDEXED BY ${index}
         WHERE compacted_at<? ORDER BY ${order} LIMIT ?`
      )
      .all(upperTime, limit);
    if (older.length === limit || !threshold || thresholdAt < cutoff) return older;
    const tied = this.database
      .prepare(
        `SELECT ${fields} FROM ${table} INDEXED BY ${index}
         WHERE compacted_at=? AND ${sequence}<?
         ORDER BY ${sequence} LIMIT ?`
      )
      .all(thresholdAt, threshold.sequence, limit - older.length);
    return older.concat(tied);
  }
}

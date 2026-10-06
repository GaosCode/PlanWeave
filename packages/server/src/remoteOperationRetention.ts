import { z } from "zod";
import { dispatchFailureSchema, dispatchResultSchema } from "./protocol.js";
import { RemoteOperationRetentionCandidates } from "./remoteOperationRetentionCandidates.js";
import { auditRemoteOperationCompaction } from "./remoteOperationRetentionAudit.js";
import {
  parseRetentionSummary,
  retentionDigest,
  retentionReceiptRowSchema,
  serializeRetentionSummary,
  type RemoteOperationRetentionSummary
} from "./remoteOperationRetentionReceipt.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

export const REMOTE_OPERATION_RETENTION_FULL_PER_SCOPE = 100 as const;
export const REMOTE_OPERATION_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const REMOTE_OPERATION_RETENTION_BATCH_SIZE = 25 as const;

const terminalOperationStateSchema = z.enum(["completed", "failed", "cancelled"]);
const terminalAttemptStatusSchema = z.enum(["superseded", "completed", "failed", "cancelled"]);
const terminalDispatchStatusSchema = z.enum(["completed", "failed", "cancelled"]);
const timestampSchema = z.iso.datetime();

export type RemoteOperationRetentionReceipt = {
  operationId: string;
  receiptDigest: string;
  summary: RemoteOperationRetentionSummary;
  compactedAt: string;
};

export type RemoteOperationRetentionResult = {
  selected: number;
  compacted: number;
  skipped: number;
};

type OperationRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  block_ref: string;
  state: string;
  dispatch_id: string;
  execution_attempt_id: string;
  envelope_digest: string | null;
  terminal_at: string;
};

type AttemptRow = {
  execution_attempt_id: string;
  operation_id: string;
  dispatch_id: string;
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  block_ref: string;
  status: string;
  terminal_at: string | null;
};

type DispatchRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  block_ref: string;
  execution_attempt_id: string;
  status: string;
  result_json: string | null;
  failure_json: string | null;
  finished_at: string | null;
};

function payloadDigest(value: string | null): string | null {
  return value === null ? null : retentionDigest(value);
}

function resultReferences(value: string | null) {
  if (value === null) return null;
  const result = dispatchResultSchema.parse(JSON.parse(value));
  return {
    reportArtifactRef: result.reportArtifactRef,
    artifactRefs: result.artifactRefs
  };
}

function failureReference(value: string | null) {
  if (value === null) return null;
  const failure = dispatchFailureSchema.parse(JSON.parse(value));
  return { code: failure.code };
}

export class RemoteOperationRetention {
  private readonly candidates: RemoteOperationRetentionCandidates;
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
    fullPerScope = REMOTE_OPERATION_RETENTION_FULL_PER_SCOPE,
    private readonly maxAgeMs = REMOTE_OPERATION_RETENTION_MAX_AGE_MS,
    batchSize = REMOTE_OPERATION_RETENTION_BATCH_SIZE
  ) {
    z.number().int().nonnegative().parse(fullPerScope);
    z.number().int().positive().parse(maxAgeMs);
    z.number().int().positive().parse(batchSize);
    this.candidates = new RemoteOperationRetentionCandidates(database, fullPerScope, batchSize);
  }

  compactBatch(): RemoteOperationRetentionResult {
    const cutoff = new Date(this.clock().getTime() - this.maxAgeMs).toISOString();
    const page = this.candidates.read(cutoff);
    if (!page) return { selected: 0, compacted: 0, skipped: 0 };
    if (page.ids.length === 0) {
      this.candidates.advance(page);
      return { selected: 0, compacted: 0, skipped: 0 };
    }
    const result = inWriteTransaction(this.database, () => {
      const eligible = this.candidates.revalidate(page, cutoff);
      let compacted = 0;
      for (const id of eligible) {
        if (this.compactEligible(id)) compacted += 1;
      }
      // Keep complete integrity diagnostics on actual compaction transactions.
      // Empty read passes never acquire the write lock or scan all foreign keys.
      const violations = this.database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0)
        throw new Error("remote_operation_retention_foreign_key_violation");
      return {
        selected: page.ids.length,
        compacted,
        skipped: page.ids.length - compacted
      };
    });
    this.candidates.advance(page);
    return result;
  }

  getReceipt(operationId: string): RemoteOperationRetentionReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT operation_id,receipt_digest,summary_json,compacted_at
         FROM remote_operation_retention_receipts WHERE operation_id=?`
      )
      .get(operationId);
    if (!row) return undefined;
    const parsed = retentionReceiptRowSchema.parse(row);
    if (retentionDigest(parsed.summary_json) !== parsed.receipt_digest) {
      throw new Error("remote_operation_retention_receipt_digest_mismatch");
    }
    const summary = parseRetentionSummary(parsed.summary_json);
    if (summary.operation.operationId !== parsed.operation_id) {
      throw new Error("remote_operation_retention_receipt_identity_mismatch");
    }
    return {
      operationId: parsed.operation_id,
      receiptDigest: parsed.receipt_digest,
      summary,
      compactedAt: parsed.compacted_at
    };
  }

  private compactEligible(operationId: string): boolean {
    const operation = this.database
      .prepare(
        `SELECT id,workspace_id,project_id,canvas_id,block_ref,state,dispatch_id,execution_attempt_id,
           envelope_digest,terminal_at FROM remote_operations WHERE id=?`
      )
      .get(operationId) as OperationRow | undefined;
    if (!operation || !terminalOperationStateSchema.safeParse(operation.state).success)
      return false;
    if (!timestampSchema.safeParse(operation.terminal_at).success) return false;

    const attempts = this.database
      .prepare(
        `SELECT execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,
           block_ref,status,terminal_at
         FROM remote_execution_attempts WHERE operation_id=? ORDER BY created_at,execution_attempt_id`
      )
      .all(operation.id) as AttemptRow[];
    if (
      attempts.length === 0 ||
      attempts.some(
        (attempt) =>
          !terminalAttemptStatusSchema.safeParse(attempt.status).success ||
          !timestampSchema.safeParse(attempt.terminal_at).success ||
          attempt.operation_id !== operation.id ||
          attempt.workspace_id !== operation.workspace_id ||
          attempt.project_id !== operation.project_id ||
          attempt.canvas_id !== operation.canvas_id ||
          attempt.block_ref !== operation.block_ref
      ) ||
      !attempts.some(
        (attempt) =>
          attempt.execution_attempt_id === operation.execution_attempt_id &&
          attempt.dispatch_id === operation.dispatch_id
      )
    ) {
      return false;
    }
    const attemptIds = attempts.map((attempt) => attempt.execution_attempt_id);
    if (this.hasUnsafeChildren(operation.id, attemptIds)) return false;

    const dispatches = attempts.map(
      (attempt) =>
        this.database
          .prepare(
            `SELECT id,workspace_id,project_id,block_ref,execution_attempt_id,status,
               result_json,failure_json,finished_at FROM dispatches WHERE id=?`
          )
          .get(attempt.dispatch_id) as DispatchRow | undefined
    );
    if (
      dispatches.some((dispatch, index) => {
        const attempt = attempts[index]!;
        return (
          !dispatch ||
          dispatch.id !== attempt.dispatch_id ||
          dispatch.execution_attempt_id !== attempt.execution_attempt_id ||
          dispatch.workspace_id !== operation.workspace_id ||
          dispatch.project_id !== operation.project_id ||
          dispatch.block_ref !== operation.block_ref ||
          !terminalDispatchStatusSchema.safeParse(dispatch.status).success
        );
      }) ||
      dispatches.length !== attempts.length
    ) {
      return false;
    }
    const currentIndex = attempts.findIndex(
      (attempt) => attempt.execution_attempt_id === operation.execution_attempt_id
    );
    if (
      currentIndex < 0 ||
      dispatches[currentIndex]?.id !== operation.dispatch_id ||
      dispatches[currentIndex]?.execution_attempt_id !== operation.execution_attempt_id
    ) {
      return false;
    }

    const audit = auditRemoteOperationCompaction(
      this.database,
      operation.id,
      operation.execution_attempt_id,
      attempts.map((attempt) => ({
        executionAttemptId: attempt.execution_attempt_id,
        dispatchId: attempt.dispatch_id
      }))
    );
    const serialized = serializeRetentionSummary({
      version: "remote-operation-retention-receipt/v1",
      scope: {
        workspaceId: operation.workspace_id,
        projectId: operation.project_id,
        canvasId: operation.canvas_id
      },
      operation: {
        operationId: operation.id,
        terminalState: terminalOperationStateSchema.parse(operation.state),
        terminalAt: operation.terminal_at,
        executionAttemptId: operation.execution_attempt_id,
        dispatchId: operation.dispatch_id,
        envelopeDigest: operation.envelope_digest
      },
      attempts: attempts.map((attempt, index) => {
        const dispatch = dispatches[index]!;
        return {
          executionAttemptId: attempt.execution_attempt_id,
          dispatchId: attempt.dispatch_id,
          status: terminalAttemptStatusSchema.parse(attempt.status),
          terminalAt: timestampSchema.parse(attempt.terminal_at),
          dispatchStatus: terminalDispatchStatusSchema.parse(dispatch.status),
          finishedAt: dispatch.finished_at,
          resultReferences: resultReferences(dispatch.result_json),
          resultDigest: payloadDigest(dispatch.result_json),
          failureCode: failureReference(dispatch.failure_json)?.code ?? null,
          failureDigest: payloadDigest(dispatch.failure_json)
        };
      }),
      streams: audit.streams,
      historicalArtifactProvenance: audit.historicalArtifactProvenance
    });
    const compactedAt = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO remote_operation_retention_receipts(
          operation_id,workspace_id,project_id,canvas_id,terminal_state,terminal_at,
          execution_attempt_id,dispatch_id,receipt_digest,summary_json,compacted_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        operation.id,
        operation.workspace_id,
        operation.project_id,
        operation.canvas_id,
        operation.state,
        operation.terminal_at,
        operation.execution_attempt_id,
        operation.dispatch_id,
        serialized.digest,
        serialized.json,
        compactedAt
      );
    const receipt = this.getReceipt(operation.id);
    if (!receipt || receipt.receiptDigest !== serialized.digest) {
      throw new Error("remote_operation_retention_receipt_write_failed");
    }

    this.compactChildren(operation, attempts);
    return true;
  }

  private hasUnsafeChildren(operationId: string, attemptIds: readonly string[]): boolean {
    const placeholders = attemptIds.map(() => "?").join(",");
    const activeReservation = this.database
      .prepare(
        `SELECT 1 FROM host_capacity_reservations
         WHERE execution_attempt_id IN (${placeholders}) AND status='active' LIMIT 1`
      )
      .get(...attemptIds);
    const unsettledAction = this.database
      .prepare(
        `SELECT 1 FROM remote_execution_actions
         WHERE operation_id=? AND state NOT IN ('settled','rejected') LIMIT 1`
      )
      .get(operationId);
    const pendingInteraction = this.database
      .prepare(
        "SELECT 1 FROM remote_interactions WHERE operation_id=? AND status='pending' LIMIT 1"
      )
      .get(operationId);
    return Boolean(activeReservation || unsettledAction || pendingInteraction);
  }

  private compactChildren(operation: OperationRow, attempts: readonly AttemptRow[]): void {
    const historical = attempts.filter(
      (attempt) => attempt.execution_attempt_id !== operation.execution_attempt_id
    );
    const historicalAttemptIds = historical.map((attempt) => attempt.execution_attempt_id);
    const historicalDispatchIds = historical.map((attempt) => attempt.dispatch_id);
    this.deleteWhereIn("remote_acp_events", "execution_attempt_id", historicalAttemptIds);
    this.deleteWhereIn("remote_acp_event_streams", "execution_attempt_id", historicalAttemptIds);

    const currentStream = this.database
      .prepare(
        `SELECT latest_cursor,retained_count FROM remote_acp_event_streams
         WHERE execution_attempt_id=?`
      )
      .get(operation.execution_attempt_id);
    if (currentStream) {
      this.database
        .prepare("DELETE FROM remote_acp_events WHERE execution_attempt_id=?")
        .run(operation.execution_attempt_id);
      this.database
        .prepare(
          `UPDATE remote_acp_event_streams
           SET retained_from_cursor=latest_cursor+1,retained_count=0,retained_bytes=0,
             dropped_count=dropped_count+?,updated_at=? WHERE execution_attempt_id=?`
        )
        .run(
          Number(currentStream.retained_count),
          this.clock().toISOString(),
          operation.execution_attempt_id
        );
    }

    this.database
      .prepare("DELETE FROM remote_operation_events WHERE operation_id=?")
      .run(operation.id);
    this.database
      .prepare("DELETE FROM remote_operation_candidates WHERE operation_id=?")
      .run(operation.id);
    this.database
      .prepare("DELETE FROM remote_execution_actions WHERE operation_id=?")
      .run(operation.id);
    this.database.prepare("DELETE FROM remote_interactions WHERE operation_id=?").run(operation.id);
    this.deleteWhereIn("host_capacity_reservations", "execution_attempt_id", [
      ...historicalAttemptIds,
      operation.execution_attempt_id
    ]);

    this.deleteWhereIn("dispatch_artifact_links", "dispatch_id", historicalDispatchIds);
    this.deleteWhereIn("artifact_grants", "dispatch_id", historicalDispatchIds);
    this.deleteWhereIn("dispatch_events", "dispatch_id", historicalDispatchIds);
    this.deleteWhereIn("dispatch_execution_envelopes", "dispatch_id", historicalDispatchIds);
    this.deleteWhereIn("dispatches", "id", historicalDispatchIds);
    this.deleteWhereIn("remote_execution_attempts", "execution_attempt_id", historicalAttemptIds);
  }

  private deleteWhereIn(table: string, column: string, values: readonly string[]): void {
    if (values.length === 0) return;
    const placeholders = values.map(() => "?").join(",");
    this.database
      .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`)
      .run(...values);
  }
}

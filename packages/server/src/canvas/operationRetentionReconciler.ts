import {
  canvasStoredRevisionSchema,
  type CanvasCommandOutcome
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  opaqueIdentifierSchema,
  timestampSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { CANVAS_COMMAND_OPERATION_RECONCILE_BATCH_SIZE } from "./limits.js";
import {
  canonicalCanvasOperationOutcome,
  CanvasOperationRetentionCorruptionError,
  digestCanvasIntent,
  insertCanvasOperationReceiptInCallerTransaction,
  parseCanvasPendingRow,
  parseCanonicalCanvasIntent,
  validateCanvasOperationReceiptWindow,
  validCanvasOperationDigest,
  validateCanvasOperationOutcomeIdentity
} from "./operationReceipt.js";
import type { CanvasScopeKey } from "./repository.js";

type RetentionStatus = "reconciling" | "ready" | "repair_required";

type ScopeState = {
  highWaterSequence: number;
  retainedFromSequence: number;
  status: RetentionStatus;
  failureCode: string | null;
};

export type CanvasOperationReconciliationResult = {
  processed: number;
  consumed: number;
  scope?: CanvasScopeKey;
  status?: RetentionStatus;
};

function scopeValues(scope: CanvasScopeKey): [string, string, string] {
  return [scope.workspaceId, scope.projectId, scope.canvasId];
}

function scopeFromRow(row: Record<string, unknown>): CanvasScopeKey {
  return {
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    canvasId: String(row.canvas_id)
  };
}

export class CanvasOperationRetentionReconciler {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date
  ) {}

  reconcileBatch(
    limit: number = CANVAS_COMMAND_OPERATION_RECONCILE_BATCH_SIZE
  ): CanvasOperationReconciliationResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("canvas_operation_reconcile_batch_invalid");
    }
    const candidate = this.nextScope();
    if (!candidate) return { processed: 0, consumed: 0 };
    try {
      return inWriteTransaction(this.database, () => this.reconcileScope(candidate, limit));
    } catch (error) {
      if (!(error instanceof CanvasOperationRetentionCorruptionError)) throw error;
      inWriteTransaction(this.database, () =>
        this.setRepairRequiredInCallerTransaction(error.scope, error.failureCode)
      );
      return { processed: 0, consumed: 1, scope: error.scope, status: "repair_required" };
    }
  }

  private reconcileScope(
    scope: CanvasScopeKey,
    limit: number
  ): CanvasOperationReconciliationResult {
    const existingState = this.scopeState(scope);
    if (existingState?.status === "repair_required") {
      return { processed: 0, consumed: 0, scope, status: "repair_required" };
    }
    if (existingState?.status === "ready") {
      throw new CanvasOperationRetentionCorruptionError(
        scope,
        "canvas_operation_legacy_after_ready"
      );
    }
    if (!existingState) this.insertScopeState(scope);

    const pendingRows = this.database
      .prepare(
        `SELECT * FROM canvas_command_pending
          WHERE workspace_id=? AND project_id=? AND canvas_id=?
          ORDER BY reserved_at ASC,rowid ASC LIMIT 2`
      )
      .all(...scopeValues(scope));
    if (pendingRows.length > 1) {
      throw new CanvasOperationRetentionCorruptionError(scope, "canvas_operation_multiple_pending");
    }

    let processed = 0;
    try {
      if (pendingRows[0] && processed < limit) {
        this.migratePending(scope, pendingRows[0]);
        processed += 1;
      }
      const legacyRows = this.database
        .prepare(
          `SELECT rowid AS legacy_rowid,* FROM canvas_command_operations
            WHERE workspace_id=? AND project_id=? AND canvas_id=?
            ORDER BY created_at ASC,rowid ASC LIMIT ?`
        )
        .all(...scopeValues(scope), limit - processed);
      for (const row of legacyRows) {
        this.migrateOperation(scope, row);
        processed += 1;
      }
    } catch (cause) {
      if (cause instanceof CanvasOperationRetentionCorruptionError) throw cause;
      throw new CanvasOperationRetentionCorruptionError(scope, "canvas_operation_legacy_corrupt", {
        cause
      });
    }

    if (!this.hasLegacyRows(scope)) {
      const completedState = this.scopeState(scope);
      if (!completedState) {
        throw new CanvasOperationRetentionCorruptionError(
          scope,
          "canvas_operation_retention_scope_state_missing"
        );
      }
      try {
        validateCanvasOperationReceiptWindow(this.database, scope, completedState);
      } catch (cause) {
        throw new CanvasOperationRetentionCorruptionError(
          scope,
          "canvas_operation_retention_invariant",
          { cause }
        );
      }
      this.database
        .prepare(
          `UPDATE canvas_command_operation_retention_scopes
              SET status='ready',failure_code=NULL,updated_at=?
            WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .run(this.clock().toISOString(), ...scopeValues(scope));
      return { processed, consumed: processed, scope, status: "ready" };
    }
    return { processed, consumed: processed, scope, status: "reconciling" };
  }

  private migratePending(scope: CanvasScopeKey, row: Record<string, unknown>): void {
    const pending = parseCanvasPendingRow(scope, row, { requireCanonicalIntent: false });
    const existing = this.database
      .prepare(
        `SELECT * FROM canvas_command_pending_scopes
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(...scopeValues(scope));
    if (existing) {
      const current = parseCanvasPendingRow(scope, existing);
      if (
        current.operationId !== pending.operationId ||
        current.expectedRevision !== pending.expectedRevision ||
        current.intentJson !== pending.intentJson ||
        current.intentDigest !== pending.intentDigest ||
        current.actor.kind !== pending.actor.kind ||
        current.actor.id !== pending.actor.id ||
        (current.actor.displayName ?? null) !== (pending.actor.displayName ?? null) ||
        current.reservedAt !== pending.reservedAt ||
        current.status !== pending.status
      ) {
        throw new Error("canvas_operation_pending_migration_conflict");
      }
    } else {
      this.database
        .prepare(
          `INSERT INTO canvas_command_pending_scopes(
             workspace_id,project_id,canvas_id,operation_id,expected_revision,intent_json,
             intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          ...scopeValues(scope),
          pending.operationId,
          pending.expectedRevision,
          pending.intentJson,
          pending.intentDigest,
          pending.actor.kind,
          pending.actor.id,
          pending.actor.displayName ?? null,
          pending.reservedAt,
          pending.status
        );
    }
    this.database
      .prepare(
        `DELETE FROM canvas_command_pending
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .run(...scopeValues(scope), pending.operationId);
  }

  private migrateOperation(scope: CanvasScopeKey, row: Record<string, unknown>): void {
    const operationId = opaqueIdentifierSchema.parse(row.operation_id);
    const createdAt = timestampSchema.parse(row.created_at);
    const { intent } = parseCanonicalCanvasIntent(JSON.parse(String(row.intent_json)));
    const intentDigest = String(row.intent_digest);
    if (!validCanvasOperationDigest(intentDigest) || digestCanvasIntent(intent) !== intentDigest) {
      throw new Error("canvas_operation_legacy_digest_invalid");
    }
    const canonical = canonicalCanvasOperationOutcome(JSON.parse(String(row.outcome_json)));
    validateCanvasOperationOutcomeIdentity(scope, operationId, canonical.outcome);
    this.validateLegacyOutcomeColumns(row, canonical.outcome);

    const existing = this.database
      .prepare(
        `SELECT operation_id,intent_digest,outcome_json,terminal_sequence,created_at
           FROM canvas_command_operation_receipts
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .get(...scopeValues(scope), operationId);
    if (existing) {
      this.validateExistingReceipt(scope, existing, intentDigest, canonical.json);
    } else {
      const state = this.scopeState(scope);
      if (!state) throw new Error("canvas_operation_scope_state_missing");
      insertCanvasOperationReceiptInCallerTransaction(
        this.database,
        this.clock,
        { scope, operationId, intentDigest, outcome: canonical.outcome, createdAt },
        state.highWaterSequence + 1
      );
    }
    this.database
      .prepare("DELETE FROM canvas_command_operations WHERE rowid=?")
      .run(Number(row.legacy_rowid));
  }

  private validateLegacyOutcomeColumns(
    row: Record<string, unknown>,
    outcome: CanvasCommandOutcome
  ): void {
    if (row.accepted !== 0 && row.accepted !== 1) {
      throw new Error("canvas_operation_legacy_accepted_invalid");
    }
    if (outcome.type === "canvas.command.accepted") {
      if (
        row.accepted !== 1 ||
        canvasStoredRevisionSchema.parse(row.revision) !== outcome.revision ||
        row.journal_entry_id !== outcome.journalEntryId
      ) {
        throw new Error("canvas_operation_legacy_outcome_mismatch");
      }
    } else if (row.accepted !== 0 || row.revision != null || row.journal_entry_id != null) {
      throw new Error("canvas_operation_legacy_outcome_mismatch");
    }
  }

  private validateExistingReceipt(
    scope: CanvasScopeKey,
    row: Record<string, unknown>,
    intentDigest: string,
    outcomeJson: string
  ): void {
    const operationId = opaqueIdentifierSchema.parse(row.operation_id);
    const sequence = Number(row.terminal_sequence);
    const canonical = canonicalCanvasOperationOutcome(JSON.parse(String(row.outcome_json)));
    timestampSchema.parse(row.created_at);
    validateCanvasOperationOutcomeIdentity(scope, operationId, canonical.outcome);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      row.intent_digest !== intentDigest ||
      row.outcome_json !== outcomeJson ||
      canonical.json !== outcomeJson
    ) {
      throw new Error("canvas_operation_legacy_receipt_conflict");
    }
  }

  private scopeState(scope: CanvasScopeKey): ScopeState | undefined {
    const row = this.database
      .prepare(
        `SELECT high_water_sequence,retained_from_sequence,status,failure_code
           FROM canvas_command_operation_retention_scopes
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(...scopeValues(scope));
    if (!row) return undefined;
    const status = String(row.status) as RetentionStatus;
    const highWaterSequence = Number(row.high_water_sequence);
    const retainedFromSequence = Number(row.retained_from_sequence);
    const failureCode = row.failure_code == null ? null : String(row.failure_code);
    if (
      !["reconciling", "ready", "repair_required"].includes(status) ||
      !Number.isSafeInteger(highWaterSequence) ||
      highWaterSequence < 0 ||
      !Number.isSafeInteger(retainedFromSequence) ||
      retainedFromSequence < 1 ||
      retainedFromSequence > highWaterSequence + 1 ||
      (status === "repair_required") !== (failureCode !== null)
    ) {
      throw new CanvasOperationRetentionCorruptionError(
        scope,
        "canvas_operation_retention_scope_state_invalid"
      );
    }
    return { highWaterSequence, retainedFromSequence, status, failureCode };
  }

  private insertScopeState(scope: CanvasScopeKey): void {
    this.database
      .prepare(
        `INSERT INTO canvas_command_operation_retention_scopes(
           workspace_id,project_id,canvas_id,high_water_sequence,retained_from_sequence,
           status,failure_code,updated_at
         ) VALUES(?,?,?,0,1,'reconciling',NULL,?)`
      )
      .run(...scopeValues(scope), this.clock().toISOString());
  }

  private setRepairRequiredInCallerTransaction(scope: CanvasScopeKey, failureCode: string): void {
    this.database
      .prepare(
        `INSERT INTO canvas_command_operation_retention_scopes(
           workspace_id,project_id,canvas_id,high_water_sequence,retained_from_sequence,
           status,failure_code,updated_at
         ) VALUES(?,?,?,0,1,'repair_required',?,?)
         ON CONFLICT(workspace_id,project_id,canvas_id) DO UPDATE SET
           status='repair_required',failure_code=excluded.failure_code,updated_at=excluded.updated_at`
      )
      .run(...scopeValues(scope), failureCode, this.clock().toISOString());
  }

  private hasLegacyRows(scope: CanvasScopeKey): boolean {
    return ["canvas_command_operations", "canvas_command_pending"].some((table) =>
      Boolean(
        this.database
          .prepare(
            `SELECT 1 AS present FROM ${table}
              WHERE workspace_id=? AND project_id=? AND canvas_id=? LIMIT 1`
          )
          .get(...scopeValues(scope))
      )
    );
  }

  private nextScope(): CanvasScopeKey | undefined {
    const row = this.database
      .prepare(
        `SELECT candidate.workspace_id,candidate.project_id,candidate.canvas_id FROM (
           SELECT workspace_id,project_id,canvas_id FROM canvas_command_operation_retention_scopes
            WHERE status='reconciling'
           UNION
           SELECT workspace_id,project_id,canvas_id FROM canvas_command_operations
           UNION
           SELECT workspace_id,project_id,canvas_id FROM canvas_command_pending
         ) AS candidate
         LEFT JOIN canvas_command_operation_retention_scopes AS state
           ON state.workspace_id=candidate.workspace_id
          AND state.project_id=candidate.project_id
          AND state.canvas_id=candidate.canvas_id
         WHERE state.status IS NULL OR state.status IN ('reconciling','ready')
         ORDER BY candidate.workspace_id,candidate.project_id,candidate.canvas_id LIMIT 1`
      )
      .get();
    return row ? scopeFromRow(row) : undefined;
  }
}

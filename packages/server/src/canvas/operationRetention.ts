import { type CanvasCommandOutcome } from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  opaqueIdentifierSchema,
  timestampSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { validateCanvasOperationRetentionSchema } from "../migrations/canvasOperationRetention.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { CanvasOperationRetentionReconciler } from "./operationRetentionReconciler.js";
import { CANVAS_COMMAND_OPERATION_RECEIPT_MAX_OUTCOME_BYTES } from "./limits.js";
import {
  canonicalCanvasOperationOutcome,
  CanvasOperationRetentionCorruptionError,
  CanvasOperationRetentionUnavailableError,
  insertCanvasOperationReceiptInCallerTransaction,
  validateCanvasOperationReceiptWindow,
  validCanvasOperationDigest,
  validateCanvasOperationOutcomeIdentity
} from "./operationReceipt.js";
import type { CanvasScopeKey } from "./repository.js";

export {
  canonicalCanvasOperationOutcome,
  CanvasOperationRetentionCorruptionError,
  CanvasOperationRetentionUnavailableError,
  digestCanvasIntent
} from "./operationReceipt.js";

type RetentionStatus = "reconciling" | "ready" | "repair_required";

type ScopeState = {
  highWaterSequence: number;
  retainedFromSequence: number;
  status: RetentionStatus;
  failureCode: string | null;
};

export type CanvasOperationReceipt = {
  operationId: string;
  intentDigest: string;
  outcome: CanvasCommandOutcome;
  terminalSequence: number;
  createdAt: string;
};

function scopeValues(scope: CanvasScopeKey): [string, string, string] {
  return [scope.workspaceId, scope.projectId, scope.canvasId];
}

export class CanvasOperationRetention {
  private readonly reconciler: CanvasOperationRetentionReconciler;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {
    validateCanvasOperationRetentionSchema(database);
    this.reconciler = new CanvasOperationRetentionReconciler(database, this.clock);
  }

  assertScopeWritable(scope: CanvasScopeKey): void {
    let state = this.scopeState(scope);
    if (!state) {
      state = inWriteTransaction(this.database, () => {
        const current = this.scopeState(scope);
        if (current) return current;
        if (this.hasUnownedNewScopeData(scope)) {
          throw new CanvasOperationRetentionCorruptionError(
            scope,
            "canvas_operation_retention_marker_missing"
          );
        }
        const hasLegacy = this.hasLegacyRows(scope);
        const status = hasLegacy ? "reconciling" : "ready";
        this.insertScopeState(scope, status, 0, 1, null);
        return { highWaterSequence: 0, retainedFromSequence: 1, status, failureCode: null };
      });
    }
    if (state.status !== "ready") {
      throw new CanvasOperationRetentionUnavailableError(
        state.status === "repair_required" ? "repair_required" : "reconciling"
      );
    }
    try {
      this.validateReadyScope(scope, state);
    } catch (cause) {
      throw new CanvasOperationRetentionCorruptionError(
        scope,
        "canvas_operation_retention_invariant",
        { cause }
      );
    }
  }

  getReceipt(scope: CanvasScopeKey, operationId: string): CanvasOperationReceipt | undefined {
    this.assertScopeWritable(scope);
    const row = this.database
      .prepare(
        `SELECT operation_id,intent_digest,outcome_json,terminal_sequence,created_at
           FROM canvas_command_operation_receipts
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .get(...scopeValues(scope), operationId);
    if (!row) return undefined;
    try {
      return this.receiptFromRow(scope, row);
    } catch (cause) {
      throw new CanvasOperationRetentionCorruptionError(scope, "canvas_operation_receipt_corrupt", {
        cause
      });
    }
  }

  corruption(scope: CanvasScopeKey, failureCode: string, cause?: unknown): never {
    throw new CanvasOperationRetentionCorruptionError(scope, failureCode, { cause });
  }

  markRepairRequired(scope: CanvasScopeKey, failureCode: string): void {
    inWriteTransaction(this.database, () =>
      this.setRepairRequiredInCallerTransaction(scope, failureCode)
    );
  }

  recordTerminalInCallerTransaction(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intentDigest: string;
    outcome: CanvasCommandOutcome;
    createdAt: string;
  }): void {
    let state = this.scopeState(input.scope);
    if (!state && this.hasUnownedNewScopeData(input.scope)) {
      throw new CanvasOperationRetentionCorruptionError(
        input.scope,
        "canvas_operation_retention_marker_missing"
      );
    }
    if (!state && !this.hasLegacyRows(input.scope)) {
      this.insertScopeState(input.scope, "ready", 0, 1, null);
      state = {
        highWaterSequence: 0,
        retainedFromSequence: 1,
        status: "ready",
        failureCode: null
      };
    }
    if (!state || state.status !== "ready") {
      throw new CanvasOperationRetentionUnavailableError(
        state?.status === "repair_required" ? "repair_required" : "reconciling"
      );
    }
    this.insertReceiptInCallerTransaction(input, state.highWaterSequence + 1);
  }

  recordBaselineResetInCallerTransaction(scope: CanvasScopeKey): void {
    const state = this.scopeState(scope);
    if (state?.status === "repair_required") {
      throw new CanvasOperationRetentionUnavailableError("repair_required");
    }
    if (!state) {
      this.insertScopeState(scope, "ready", 0, 1, null);
      return;
    }
    this.database
      .prepare(
        `UPDATE canvas_command_operation_retention_scopes
            SET retained_from_sequence=high_water_sequence+1,status='ready',failure_code=NULL,
                updated_at=?
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .run(this.clock().toISOString(), ...scopeValues(scope));
  }

  reconcileBatch(limit?: number) {
    return this.reconciler.reconcileBatch(limit);
  }

  private insertReceiptInCallerTransaction(
    input: {
      scope: CanvasScopeKey;
      operationId: string;
      intentDigest: string;
      outcome: CanvasCommandOutcome;
      createdAt: string;
    },
    sequence: number
  ): void {
    insertCanvasOperationReceiptInCallerTransaction(this.database, this.clock, input, sequence);
  }

  private receiptFromRow(
    scope: CanvasScopeKey,
    row: Record<string, unknown>
  ): CanvasOperationReceipt {
    const operationId = opaqueIdentifierSchema.parse(row.operation_id);
    const intentDigest = String(row.intent_digest);
    const sequence = Number(row.terminal_sequence);
    if (
      !validCanvasOperationDigest(intentDigest) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      throw new Error("canvas_operation_receipt_metadata_invalid");
    }
    const outcomeJson = String(row.outcome_json);
    if (
      Buffer.byteLength(outcomeJson, "utf8") > CANVAS_COMMAND_OPERATION_RECEIPT_MAX_OUTCOME_BYTES
    ) {
      throw new Error("canvas_operation_receipt_outcome_too_large");
    }
    const canonical = canonicalCanvasOperationOutcome(JSON.parse(outcomeJson));
    if (canonical.json !== outcomeJson) {
      throw new Error("canvas_operation_receipt_not_canonical");
    }
    if (
      canonical.outcome.type === "canvas.command.accepted" &&
      canonical.outcome.idempotentReplay
    ) {
      throw new Error("canvas_operation_receipt_replay_flag_invalid");
    }
    validateCanvasOperationOutcomeIdentity(scope, operationId, canonical.outcome);
    return {
      operationId,
      intentDigest,
      outcome: canonical.outcome,
      terminalSequence: sequence,
      createdAt: timestampSchema.parse(row.created_at)
    };
  }

  private validateReadyScope(scope: CanvasScopeKey, state: ScopeState): void {
    if (this.hasLegacyRows(scope)) throw new Error("canvas_operation_legacy_after_ready");
    validateCanvasOperationReceiptWindow(this.database, scope, state);
  }

  private hasUnownedNewScopeData(scope: CanvasScopeKey): boolean {
    return ["canvas_command_operation_receipts", "canvas_command_pending_scopes"].some((table) =>
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
    return {
      highWaterSequence,
      retainedFromSequence,
      status,
      failureCode
    };
  }

  private insertScopeState(
    scope: CanvasScopeKey,
    status: RetentionStatus,
    highWaterSequence: number,
    retainedFromSequence: number,
    failureCode: string | null
  ): void {
    this.database
      .prepare(
        `INSERT INTO canvas_command_operation_retention_scopes(
           workspace_id,project_id,canvas_id,high_water_sequence,retained_from_sequence,
           status,failure_code,updated_at
         ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        ...scopeValues(scope),
        highWaterSequence,
        retainedFromSequence,
        status,
        failureCode,
        this.clock().toISOString()
      );
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
}

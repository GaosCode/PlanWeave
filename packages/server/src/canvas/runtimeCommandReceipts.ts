import { createHash } from "node:crypto";
import {
  canvasRuntimeResetOutcomeSchema,
  canvasRuntimeResetRequestSchema,
  type CanvasRuntimeResetOutcome,
  type CanvasRuntimeResetRequest
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import {
  canvasScopeRefSchema,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { canvasRuntimeStatusProjectionSchema } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { CanvasRuntimeResetHostResult } from "./executionRuntimePort.js";
import { canonicalizeJson } from "@planweave-ai/agent-host-protocol";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";

export type CanvasRuntimeResetReceipt =
  | { kind: "accepted" }
  | {
      kind: "recover";
      status: "applying" | "unknown";
      hostResult?: CanvasRuntimeResetHostResult;
    }
  | { kind: "busy" }
  | { kind: "completed"; outcome: CanvasRuntimeResetOutcome };

function digestResetIntent(request: CanvasRuntimeResetRequest): string {
  return createHash("sha256")
    .update(
      canonicalizeJson({
        expectedContentRevision: request.expectedContentRevision,
        expectedSourceRevision: request.expectedSourceRevision,
        expectedGraphFingerprint: request.expectedGraphFingerprint,
        reason: request.reason ?? null
      })
    )
    .digest("hex");
}

/** Durable reset operation receipts keyed by canvas scope and operation ID. */
export class CanvasRuntimeResetReceiptRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  begin(scopeInput: CanvasScopeRef, request: CanvasRuntimeResetRequest): CanvasRuntimeResetReceipt {
    const scope = canvasScopeRefSchema.parse(scopeInput);
    const parsed = canvasRuntimeResetRequestSchema.parse(request);
    const intentDigest = digestResetIntent(parsed);
    return inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT intent_digest,status,outcome_json,host_result_json
             FROM canvas_runtime_reset_operations
            WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
        )
        .get(scope.workspaceId, scope.projectId, scope.canvasId, parsed.operationId);
      if (existing) {
        if (String(existing.intent_digest) !== intentDigest) {
          throw new Error("canvas_runtime_reset_conflict");
        }
        if (existing.status === "completed") {
          if (existing.outcome_json == null) {
            throw new Error("canvas_runtime_reset_receipt_corrupt");
          }
          return {
            kind: "completed",
            outcome: canvasRuntimeResetOutcomeSchema.parse(
              JSON.parse(String(existing.outcome_json))
            )
          };
        }
        const hostResult = existing.host_result_json
          ? parseHostResult(JSON.parse(String(existing.host_result_json)))
          : undefined;
        return {
          kind: "recover",
          status: existing.status === "unknown" ? "unknown" : "applying",
          ...(hostResult ? { hostResult } : {})
        };
      }
      const applying = this.database
        .prepare(
          `SELECT operation_id
             FROM canvas_runtime_reset_operations
            WHERE workspace_id=? AND project_id=? AND canvas_id=?
              AND status IN ('applying','unknown')
            LIMIT 1`
        )
        .get(scope.workspaceId, scope.projectId, scope.canvasId);
      if (applying) return { kind: "busy" };
      const now = this.clock().toISOString();
      this.database
        .prepare(
          `INSERT INTO canvas_runtime_reset_operations(
             workspace_id,project_id,canvas_id,operation_id,intent_digest,status,request_json,
             host_result_json,runtime_revision,outcome_json,created_at,updated_at
           ) VALUES(?,?,?,?,?,'applying',?,NULL,NULL,NULL,?,?)`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          parsed.operationId,
          intentDigest,
          JSON.stringify(parsed),
          now,
          now
        );
      return { kind: "accepted" };
    });
  }

  markUnknown(scopeInput: CanvasScopeRef, operationId: string): void {
    const scope = canvasScopeRefSchema.parse(scopeInput);
    const updated = this.database
      .prepare(
        `UPDATE canvas_runtime_reset_operations SET status='unknown',updated_at=?
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?
           AND status IN ('applying','unknown')`
      )
      .run(
        this.clock().toISOString(),
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        operationId
      );
    if (updated.changes !== 1) throw new Error("canvas_runtime_reset_receipt_conflict");
  }

  recordHostResult(
    scopeInput: CanvasScopeRef,
    operationId: string,
    hostResultInput: CanvasRuntimeResetHostResult
  ): CanvasRuntimeResetHostResult {
    const scope = canvasScopeRefSchema.parse(scopeInput);
    const hostResult = parseHostResult(hostResultInput);
    if (hostResult.operationId !== operationId) {
      throw new Error("canvas_runtime_reset_host_result_id_mismatch");
    }
    return inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT host_result_json FROM canvas_runtime_reset_operations
           WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?
             AND status IN ('applying','unknown')`
        )
        .get(scope.workspaceId, scope.projectId, scope.canvasId, operationId);
      if (!existing) throw new Error("canvas_runtime_reset_receipt_conflict");
      if (existing.host_result_json) {
        const stored = parseHostResult(JSON.parse(String(existing.host_result_json)));
        if (canonicalizeJson(stored) !== canonicalizeJson(hostResult)) {
          throw new Error("canvas_runtime_reset_host_result_conflict");
        }
        return stored;
      }
      this.database
        .prepare(
          `UPDATE canvas_runtime_reset_operations
           SET status='unknown',host_result_json=?,updated_at=?
           WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?
             AND status IN ('applying','unknown')`
        )
        .run(
          JSON.stringify(hostResult),
          this.clock().toISOString(),
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          operationId
        );
      return hostResult;
    });
  }

  complete(
    scopeInput: CanvasScopeRef,
    operationId: string,
    outcome: CanvasRuntimeResetOutcome
  ): CanvasRuntimeResetOutcome {
    const scope = canvasScopeRefSchema.parse(scopeInput);
    const completed = canvasRuntimeResetOutcomeSchema.parse(outcome);
    if (completed.operationId !== operationId) {
      throw new Error("canvas_runtime_reset_outcome_id_mismatch");
    }
    return inWriteTransaction(this.database, () => {
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE canvas_runtime_reset_operations
              SET status='completed',runtime_revision=?,outcome_json=?,updated_at=?
            WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?
              AND status IN ('applying','unknown')`
        )
        .run(
          completed.type === "canvas.runtime.reset.accepted" ? completed.runtimeRevision : null,
          JSON.stringify(completed),
          now,
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          operationId
        );
      if (updated.changes !== 1) {
        throw new Error("canvas_runtime_reset_receipt_conflict");
      }
      return completed;
    });
  }
}

function parseHostResult(input: unknown): CanvasRuntimeResetHostResult {
  if (!input || typeof input !== "object") {
    throw new Error("canvas_runtime_reset_host_result_invalid");
  }
  const candidate = input as Record<string, unknown>;
  const operationId = canvasRuntimeResetRequestSchema.shape.operationId.parse(
    candidate.operationId
  );
  const sourceRevision = canvasRuntimeResetRequestSchema.shape.expectedSourceRevision.parse(
    candidate.sourceRevision
  );
  const graphFingerprint = canvasRuntimeResetRequestSchema.shape.expectedGraphFingerprint.parse(
    candidate.graphFingerprint
  );
  return {
    operationId,
    sourceRevision,
    graphFingerprint,
    status: canvasRuntimeStatusProjectionSchema.parse(candidate.status)
  };
}

import { createHash } from "node:crypto";
import { CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandIntentSchema,
  canvasCommandOutcomeSchema,
  canvasRevisionSchema,
  type CanvasCommandIntent,
  type CanvasCommandOutcome
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  actorRefSchema,
  canvasScopeRefSchema,
  opaqueIdentifierSchema,
  timestampSchema,
  type ActorRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { CANVAS_COMMAND_OPERATION_RECEIPT_MAX_OUTCOME_BYTES } from "./limits.js";
import type { CanvasScopeKey } from "./repository.js";
import type { SqliteDatabase } from "../sqlite.js";

export class CanvasOperationRetentionUnavailableError extends Error {
  constructor(readonly reason: "reconciling" | "repair_required") {
    super(`canvas_operation_retention_${reason}`);
  }
}

export class CanvasOperationRetentionCorruptionError extends Error {
  constructor(
    readonly scope: CanvasScopeKey,
    readonly failureCode: string,
    options?: { cause?: unknown }
  ) {
    super(failureCode, options);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function digestCanvasIntent(intent: CanvasCommandIntent): string {
  return createHash("sha256").update(stableStringify(intent)).digest("hex");
}

export function parseCanonicalCanvasIntent(value: unknown): {
  intent: CanvasCommandIntent;
  json: string;
} {
  const intent = canvasCommandIntentSchema.parse(value);
  return { intent, json: JSON.stringify(intent) };
}

export function canonicalCanvasOperationOutcome(outcome: unknown): {
  outcome: CanvasCommandOutcome;
  json: string;
} {
  const parsed = canvasCommandOutcomeSchema.parse(outcome);
  const json = JSON.stringify(parsed);
  if (Buffer.byteLength(json, "utf8") > CANVAS_COMMAND_OPERATION_RECEIPT_MAX_OUTCOME_BYTES) {
    throw new Error("canvas_operation_receipt_outcome_too_large");
  }
  return { outcome: parsed, json };
}

export function validCanvasOperationDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export type ParsedCanvasPending = {
  scope: CanvasScopeKey;
  operationId: string;
  expectedRevision: number;
  intent: CanvasCommandIntent;
  intentJson: string;
  intentDigest: string;
  actor: ActorRef;
  reservedAt: string;
  status: "applying" | "needs_recovery";
};

export type CanvasOperationReceiptWindowState = {
  highWaterSequence: number;
  retainedFromSequence: number;
};

export function validateCanvasOperationReceiptWindow(
  database: SqliteDatabase,
  scope: CanvasScopeKey,
  state: CanvasOperationReceiptWindowState
): void {
  const summary = database
    .prepare(
      `SELECT COUNT(*) AS count,MIN(terminal_sequence) AS min_sequence,
              MAX(terminal_sequence) AS max_sequence
         FROM canvas_command_operation_receipts
        WHERE workspace_id=? AND project_id=? AND canvas_id=?`
    )
    .get(scope.workspaceId, scope.projectId, scope.canvasId);
  const count = Number(summary?.count ?? 0);
  const minSequence = Number(summary?.min_sequence ?? 0);
  const maxSequence = Number(summary?.max_sequence ?? 0);
  const expectedCount = state.highWaterSequence - state.retainedFromSequence + 1;
  if (
    expectedCount < 0 ||
    expectedCount > CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW ||
    count !== expectedCount ||
    (expectedCount === 0
      ? minSequence !== 0 || maxSequence !== 0
      : minSequence !== state.retainedFromSequence || maxSequence !== state.highWaterSequence)
  ) {
    throw new Error("canvas_operation_receipt_window_invalid");
  }
}

export function parseCanvasPendingRow(
  scope: CanvasScopeKey,
  row: Record<string, unknown>,
  options: { requireCanonicalIntent?: boolean } = {}
): ParsedCanvasPending {
  const parsedScope = canvasScopeRefSchema.parse(scope);
  const operationId = opaqueIdentifierSchema.parse(row.operation_id);
  const expectedRevision = canvasRevisionSchema.parse(row.expected_revision);
  const { intent, json: intentJson } = parseCanonicalCanvasIntent(
    JSON.parse(String(row.intent_json))
  );
  const intentDigest = String(row.intent_digest);
  if (
    (options.requireCanonicalIntent !== false && String(row.intent_json) !== intentJson) ||
    !validCanvasOperationDigest(intentDigest) ||
    digestCanvasIntent(intent) !== intentDigest
  ) {
    throw new Error("canvas_command_pending_intent_invalid");
  }
  const actor = actorRefSchema.parse({
    kind: row.actor_kind,
    id: row.actor_id,
    ...(row.actor_display_name == null ? {} : { displayName: row.actor_display_name })
  });
  const reservedAt = timestampSchema.parse(row.reserved_at);
  if (row.status !== "applying" && row.status !== "needs_recovery") {
    throw new Error("canvas_command_pending_status_invalid");
  }
  return {
    scope: parsedScope,
    operationId,
    expectedRevision,
    intent,
    intentJson,
    intentDigest,
    actor,
    reservedAt,
    status: row.status
  };
}

export function validateCanvasOperationOutcomeIdentity(
  scope: CanvasScopeKey,
  operationId: string,
  outcome: CanvasCommandOutcome
): void {
  if (outcome.operationId !== operationId) {
    throw new Error("canvas_operation_outcome_id_mismatch");
  }
  if (outcome.type === "canvas.command.accepted") {
    if (
      outcome.scope.workspaceId !== scope.workspaceId ||
      outcome.scope.projectId !== scope.projectId ||
      outcome.scope.canvasId !== scope.canvasId
    ) {
      throw new Error("canvas_operation_outcome_scope_mismatch");
    }
    return;
  }
  if (outcome.projectId !== scope.projectId || outcome.canvasId !== scope.canvasId) {
    throw new Error("canvas_operation_outcome_scope_mismatch");
  }
}

export function insertCanvasOperationReceiptInCallerTransaction(
  database: SqliteDatabase,
  clock: () => Date,
  input: {
    scope: CanvasScopeKey;
    operationId: string;
    intentDigest: string;
    outcome: CanvasCommandOutcome;
    createdAt: string;
  },
  sequence: number
): void {
  let canonical: ReturnType<typeof canonicalCanvasOperationOutcome>;
  try {
    if (!validCanvasOperationDigest(input.intentDigest)) {
      throw new Error("canvas_operation_digest_invalid");
    }
    canonical = canonicalCanvasOperationOutcome(input.outcome);
    validateCanvasOperationOutcomeIdentity(input.scope, input.operationId, canonical.outcome);
    if (
      canonical.outcome.type === "canvas.command.accepted" &&
      canonical.outcome.idempotentReplay
    ) {
      throw new Error("canvas_operation_replay_outcome_not_persistable");
    }
  } catch (cause) {
    throw new CanvasOperationRetentionCorruptionError(
      input.scope,
      "canvas_operation_terminal_corrupt",
      { cause }
    );
  }
  database
    .prepare(
      `INSERT INTO canvas_command_operation_receipts(
         workspace_id,project_id,canvas_id,operation_id,intent_digest,outcome_json,
         terminal_sequence,created_at
       ) VALUES(?,?,?,?,?,?,?,?)`
    )
    .run(
      input.scope.workspaceId,
      input.scope.projectId,
      input.scope.canvasId,
      input.operationId,
      input.intentDigest,
      canonical.json,
      sequence,
      input.createdAt
    );
  const scopeWrite = database
    .prepare(
      `UPDATE canvas_command_operation_retention_scopes
          SET high_water_sequence=?,retained_from_sequence=MAX(retained_from_sequence,?),
              updated_at=?
        WHERE workspace_id=? AND project_id=? AND canvas_id=?
          AND high_water_sequence=? AND status IN ('ready','reconciling')`
    )
    .run(
      sequence,
      Math.max(1, sequence - CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW + 1),
      clock().toISOString(),
      input.scope.workspaceId,
      input.scope.projectId,
      input.scope.canvasId,
      sequence - 1
    );
  if (scopeWrite.changes !== 1) {
    throw new CanvasOperationRetentionCorruptionError(
      input.scope,
      "canvas_operation_retention_sequence_conflict"
    );
  }
  if (sequence > CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW) {
    database
      .prepare(
        `DELETE FROM canvas_command_operation_receipts
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND terminal_sequence=?`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        sequence - CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW
      );
  }
}

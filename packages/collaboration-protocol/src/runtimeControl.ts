import { z } from "zod";
import { COLLABORATION_REASON_MAX_LENGTH, COLLABORATION_REVISION_MAX } from "./limits.js";
import { packageSnapshotSourceRevisionSchema } from "./packageSnapshot.js";
import { opaqueIdentifierSchema } from "./primitives.js";
import {
  canvasRuntimePackageFingerprintSchema,
  canvasRuntimeRevisionSchema,
  canvasRuntimeStatusProjectionSchema
} from "./runtimeStatus.js";

export const canvasRuntimeResetFailureCodeSchema = z.enum([
  "forbidden",
  "host_offline",
  "active_lease",
  "source_drift",
  "persist_failed",
  "reconcile_required",
  "unavailable",
  "conflict",
  "invalid_request"
]);
export type CanvasRuntimeResetFailureCode = z.infer<typeof canvasRuntimeResetFailureCodeSchema>;

export const canvasRuntimeResetRequestSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    expectedContentRevision: z.number().int().positive().max(COLLABORATION_REVISION_MAX),
    expectedSourceRevision: packageSnapshotSourceRevisionSchema,
    expectedGraphFingerprint: canvasRuntimePackageFingerprintSchema,
    reason: z.string().trim().min(1).max(COLLABORATION_REASON_MAX_LENGTH).optional()
  })
  .strict();
export type CanvasRuntimeResetRequest = z.infer<typeof canvasRuntimeResetRequestSchema>;

export const canvasRuntimeResetAcceptedSchema = z
  .object({
    type: z.literal("canvas.runtime.reset.accepted"),
    operationId: opaqueIdentifierSchema,
    runtimeRevision: canvasRuntimeRevisionSchema,
    sourceRevision: packageSnapshotSourceRevisionSchema,
    graphFingerprint: canvasRuntimePackageFingerprintSchema,
    status: canvasRuntimeStatusProjectionSchema
  })
  .strict();
export type CanvasRuntimeResetAccepted = z.infer<typeof canvasRuntimeResetAcceptedSchema>;

export const canvasRuntimeResetRejectedSchema = z
  .object({
    type: z.literal("canvas.runtime.reset.rejected"),
    operationId: opaqueIdentifierSchema,
    code: canvasRuntimeResetFailureCodeSchema
  })
  .strict();
export type CanvasRuntimeResetRejected = z.infer<typeof canvasRuntimeResetRejectedSchema>;

export const canvasRuntimeResetOutcomeSchema = z.discriminatedUnion("type", [
  canvasRuntimeResetAcceptedSchema,
  canvasRuntimeResetRejectedSchema
]);
export type CanvasRuntimeResetOutcome = z.infer<typeof canvasRuntimeResetOutcomeSchema>;

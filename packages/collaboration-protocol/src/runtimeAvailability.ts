import { z } from "zod";
import { packageSnapshotSourceRevisionSchema } from "./packageSnapshot.js";
import { agentHostIdSchema, timestampSchema } from "./primitives.js";
import {
  canvasRuntimePackageFingerprintSchema,
  canvasRuntimeStatusProjectionSchema
} from "./runtimeStatus.js";

export const canvasRuntimeAvailabilitySchemaVersion = "canvas-runtime-availability/v1" as const;
export const canvasRuntimeAvailabilitySchemaVersionSchema = z.literal(
  canvasRuntimeAvailabilitySchemaVersion
);

export const canvasRuntimeUnavailableReasonSchema = z.enum([
  "runtime_not_attached",
  "host_offline",
  "content_out_of_sync"
]);
export type CanvasRuntimeUnavailableReason = z.infer<typeof canvasRuntimeUnavailableReasonSchema>;

export const canvasRuntimeAvailabilitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: canvasRuntimeAvailabilitySchemaVersionSchema,
      kind: z.literal("available"),
      status: canvasRuntimeStatusProjectionSchema,
      sourceRevision: packageSnapshotSourceRevisionSchema,
      graphFingerprint: canvasRuntimePackageFingerprintSchema,
      hostId: agentHostIdSchema.optional()
    })
    .strict(),
  z
    .object({
      schemaVersion: canvasRuntimeAvailabilitySchemaVersionSchema,
      kind: z.literal("unavailable"),
      reason: canvasRuntimeUnavailableReasonSchema,
      hostId: agentHostIdSchema.optional(),
      lastSeenAt: timestampSchema.optional()
    })
    .strict()
]);
export type CanvasRuntimeAvailability = z.infer<typeof canvasRuntimeAvailabilitySchema>;

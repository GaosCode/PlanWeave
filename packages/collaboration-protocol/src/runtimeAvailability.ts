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

/** Execution-device observation. This is never the authority for shared Runtime State. */
export const canvasRuntimeExecutionAvailabilitySchema = z.discriminatedUnion("kind", [
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
export type CanvasRuntimeExecutionAvailability = z.infer<
  typeof canvasRuntimeExecutionAvailabilitySchema
>;

export const canvasRuntimeStateAvailabilitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("initialized"),
      status: canvasRuntimeStatusProjectionSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("uninitialized")
    })
    .strict()
]);
export type CanvasRuntimeStateAvailability = z.infer<typeof canvasRuntimeStateAvailabilitySchema>;

export const canvasRuntimeViewSchemaVersion = "canvas-runtime-view/v1" as const;

/**
 * Shared-canvas Runtime read model. State remains readable when no execution device is online.
 */
export const canvasRuntimeAvailabilitySchema = z
  .object({
    schemaVersion: z.literal(canvasRuntimeViewSchemaVersion),
    state: canvasRuntimeStateAvailabilitySchema,
    execution: canvasRuntimeExecutionAvailabilitySchema
  })
  .strict();
export type CanvasRuntimeAvailability = z.infer<typeof canvasRuntimeAvailabilitySchema>;

export const importCanvasRuntimeStatusRequestSchema = z
  .object({ status: canvasRuntimeStatusProjectionSchema })
  .strict();
export type ImportCanvasRuntimeStatusRequest = z.infer<
  typeof importCanvasRuntimeStatusRequestSchema
>;

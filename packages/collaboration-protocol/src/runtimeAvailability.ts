import { z } from "zod";
import { contentVersionRevisionSchema } from "./contentVersion.js";
import { packageSnapshotSourceRevisionSchema } from "./packageSnapshot.js";
import { agentHostIdSchema, timestampSchema } from "./primitives.js";
import {
  canvasRuntimePackageFingerprintSchema,
  canvasRuntimeRevisionSchema,
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
      runtimeRevision: canvasRuntimeRevisionSchema,
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

/** Server content authority used by commands even when no execution device is available. */
export const canvasRuntimeContentAuthoritySchema = z
  .object({
    revision: contentVersionRevisionSchema,
    sourceRevision: packageSnapshotSourceRevisionSchema,
    graphFingerprint: canvasRuntimePackageFingerprintSchema
  })
  .strict();
export type CanvasRuntimeContentAuthority = z.infer<typeof canvasRuntimeContentAuthoritySchema>;

export const canvasRuntimeViewSchemaVersion = "canvas-runtime-view/v1" as const;
export const canvasRuntimeViewSchemaVersionV2 = "canvas-runtime-view/v2" as const;

/**
 * Legacy shared-canvas Runtime read model. Kept exact so older strict clients can keep reading it.
 */
export const canvasRuntimeAvailabilityV1Schema = z
  .object({
    schemaVersion: z.literal(canvasRuntimeViewSchemaVersion),
    state: canvasRuntimeStateAvailabilitySchema,
    execution: canvasRuntimeExecutionAvailabilitySchema
  })
  .strict();

/** Shared-canvas Runtime read model with Server content authority for control operations. */
export const canvasRuntimeAvailabilityV2Schema = z
  .object({
    schemaVersion: z.literal(canvasRuntimeViewSchemaVersionV2),
    authority: canvasRuntimeContentAuthoritySchema,
    state: canvasRuntimeStateAvailabilitySchema,
    execution: canvasRuntimeExecutionAvailabilitySchema
  })
  .strict();

export const canvasRuntimeAvailabilitySchema = z.discriminatedUnion("schemaVersion", [
  canvasRuntimeAvailabilityV1Schema,
  canvasRuntimeAvailabilityV2Schema
]);
export type CanvasRuntimeAvailability = z.infer<typeof canvasRuntimeAvailabilitySchema>;
export type CanvasRuntimeAvailabilityV1 = z.infer<typeof canvasRuntimeAvailabilityV1Schema>;
export type CanvasRuntimeAvailabilityV2 = z.infer<typeof canvasRuntimeAvailabilityV2Schema>;

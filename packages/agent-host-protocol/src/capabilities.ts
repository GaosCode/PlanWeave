import { z } from "zod";

/** Maximum UTF-16 code units allowed in one capability token. */
export const CAPABILITY_MAX_LENGTH = 128 as const;

/** Maximum number of capability tokens in one list. */
export const CAPABILITIES_MAX_COUNT = 128 as const;

/** Capability gate for the version-one Canvas Runtime control plane. */
export const CANVAS_RUNTIME_CAPABILITY = "canvas-runtime.v1" as const;

/**
 * Portable Host capability token (plan intent / scheduling).
 * Lowercase logical identifiers only; never a path, command, or credential.
 */
export const capabilitySchema = z
  .string()
  .min(1)
  .max(CAPABILITY_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

export type Capability = z.infer<typeof capabilitySchema>;

/** Bounded capability list. Duplicate intent is rejected instead of coerced. */
export const capabilitiesSchema = z
  .array(capabilitySchema)
  .max(CAPABILITIES_MAX_COUNT)
  .refine((values) => new Set(values).size === values.length, {
    message: "Capability values must be unique."
  });

export type Capabilities = z.infer<typeof capabilitiesSchema>;

export function hasCanvasRuntimeCapability(capabilities: readonly string[]): boolean {
  return capabilitiesSchema.parse(capabilities).includes(CANVAS_RUNTIME_CAPABILITY);
}

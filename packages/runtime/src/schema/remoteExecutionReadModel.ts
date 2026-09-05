import { z } from "zod";
import { remoteExecutionControlPlaneSchema } from "./remoteExecutionControlPlane.js";

// The durable source state is already validated by agent-host-protocol. This browser-safe
// public projection independently rejects paths, URLs, whitespace, and unbounded labels.
const publicLogicalIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const remoteExecutionIdentitySchema = z
  .object({
    operationId: publicLogicalIdentifierSchema
  })
  .strict();

const remoteExecutionSourceSchema = z
  .object({
    revision: publicLogicalIdentifierSchema,
    graphFingerprint: publicLogicalIdentifierSchema
  })
  .strict();

const remoteExecutionDispatchAttemptSchema = z
  .object({
    dispatchId: publicLogicalIdentifierSchema,
    executionAttemptId: publicLogicalIdentifierSchema
  })
  .strict();

/** Safe, transport-neutral projection for public Runtime/CLI/Desktop read models. */
export const remoteBlockExecutionReadModelSchema = z
  .object({
    identity: remoteExecutionIdentitySchema,
    controlPlane: remoteExecutionControlPlaneSchema,
    phase: z.enum(["preparing", "active", "terminal"]),
    status: z.enum(["owned", "interrupted", "source_drift", "completed", "failed", "stopped"]),
    actionRequired: z.boolean(),
    source: remoteExecutionSourceSchema,
    dispatchAttempt: remoteExecutionDispatchAttemptSchema.nullable()
  })
  .strict();

export type RemoteBlockExecutionReadModel = z.infer<typeof remoteBlockExecutionReadModelSchema>;

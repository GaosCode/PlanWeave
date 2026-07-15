import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentFamilySchema, runnerTransportSchema } from "../types/executor.js";
import { safeRunnerEventTextSchema, utf8ByteLength } from "./runnerEventRedaction.js";

export const runnerContractVersionSchema = z.literal("planweave.runner/v1");
export type RunnerContractVersion = z.infer<typeof runnerContractVersionSchema>;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const projectIdSchema = identifierSchema.brand("ProjectId");
export const canvasIdSchema = identifierSchema.brand("CanvasId");
export const taskIdSchema = z.string().min(1).max(256).brand("TaskId");
export const blockIdSchema = z.string().min(1).max(256).brand("BlockId");
export const claimRefSchema = z
  .string()
  .min(3)
  .max(513)
  .regex(/^[^#\s]+#[^#\s]+$/)
  .brand("ClaimRef");
export const runnerRunIdSchema = identifierSchema.brand("RunnerRunId");
export const runSessionIdSchema = identifierSchema.brand("RunSessionId");
export const desktopRunIdSchema = identifierSchema.brand("DesktopRunId");
export const executorRunIdSchema = identifierSchema.brand("ExecutorRunId");
export const executionWaveIdSchema = z
  .string()
  .regex(
    /^WAVE-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Execution wave id must use the WAVE-<UUIDv4> format."
  )
  .brand("ExecutionWaveId");
export type ExecutionWaveId = z.infer<typeof executionWaveIdSchema>;

export function createExecutionWaveId(): ExecutionWaveId {
  return executionWaveIdSchema.parse(`WAVE-${randomUUID()}`);
}
export const acpSessionIdSchema = identifierSchema.brand("AcpSessionId");
export const acpRequestIdSchema = identifierSchema.brand("AcpRequestId");
export const jsonRpcCorrelationIdSchema = z
  .union([z.string().min(1).max(256), z.number().int().safe()])
  .brand("JsonRpcCorrelationId");

export const runnerIdentitySchema = z
  .object({
    version: runnerContractVersionSchema,
    runnerKind: runnerTransportSchema,
    agentId: agentFamilySchema
  })
  .strict();
export type RunnerIdentity = z.infer<typeof runnerIdentitySchema>;

export const runnerRunIdentitySchema = z
  .object({
    projectId: projectIdSchema,
    canvasId: canvasIdSchema,
    taskId: taskIdSchema,
    blockId: blockIdSchema,
    claimRef: claimRefSchema,
    runId: runnerRunIdSchema,
    runOwner: z.enum(["executor", "desktop", "run-session"]),
    runSessionId: runSessionIdSchema.nullable(),
    desktopRunId: desktopRunIdSchema.nullable(),
    executorRunId: executorRunIdSchema.nullable()
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.claimRef !== `${identity.taskId}#${identity.blockId}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claimRef"],
        message: "claimRef must equal taskId#blockId."
      });
    }
    const ownerId =
      identity.runOwner === "executor"
        ? identity.executorRunId
        : identity.runOwner === "desktop"
          ? identity.desktopRunId
          : identity.runSessionId;
    if (ownerId === null || String(identity.runId) !== String(ownerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runId"],
        message: `runId must equal the non-null ${identity.runOwner} owner id.`
      });
    }
  });
export type RunnerRunIdentity = z.infer<typeof runnerRunIdentitySchema>;

export const acpCorrelationSchema = z
  .object({
    sessionId: acpSessionIdSchema,
    requestId: acpRequestIdSchema.optional(),
    jsonRpcId: jsonRpcCorrelationIdSchema.optional()
  })
  .strict();
export type AcpCorrelation = z.infer<typeof acpCorrelationSchema>;

export const runnerCapabilitySchema = z.enum([
  "session",
  "prompt",
  "cancel",
  "permission",
  "authentication",
  "elicitation",
  "event-replay",
  "streaming",
  "tool-updates",
  "image",
  "embedded-context",
  "session-close",
  "history-load"
]);
export type RunnerCapability = z.infer<typeof runnerCapabilitySchema>;

export const negotiatedCapabilitiesSchema = z
  .object({
    version: runnerContractVersionSchema,
    required: z.array(runnerCapabilitySchema).max(32),
    available: z.array(runnerCapabilitySchema).max(32),
    negotiated: z.array(runnerCapabilitySchema).max(32)
  })
  .strict()
  .superRefine((value, context) => {
    const available = new Set(value.available);
    const negotiated = new Set(value.negotiated);
    for (const capability of value.required) {
      if (!negotiated.has(capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["negotiated"],
          message: `Required capability '${capability}' was not negotiated.`
        });
      }
    }
    for (const capability of value.negotiated) {
      if (!available.has(capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["negotiated"],
          message: `Negotiated capability '${capability}' is not available.`
        });
      }
    }
    for (const [field, capabilities] of Object.entries({
      required: value.required,
      available: value.available,
      negotiated: value.negotiated
    })) {
      if (new Set(capabilities).size !== capabilities.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} capabilities must be unique.`
        });
      }
    }
  });
export type NegotiatedCapabilities = z.infer<typeof negotiatedCapabilitiesSchema>;

export const runnerNonterminalStateSchema = z.enum([
  "created",
  "initializing",
  "ready",
  "running",
  "waiting_interaction",
  "cancelling"
]);
export const runnerTerminalStateSchema = z.enum(["succeeded", "failed", "cancelled"]);
export const runnerLifecycleStateSchema = z.union([
  runnerNonterminalStateSchema,
  runnerTerminalStateSchema
]);
export type RunnerLifecycleState = z.infer<typeof runnerLifecycleStateSchema>;
export type RunnerTerminalState = z.infer<typeof runnerTerminalStateSchema>;

export const pendingInteractionKindSchema = z.enum(["permission", "authentication", "elicitation"]);
export const persistedPendingInteractionSchema = z
  .object({
    version: runnerContractVersionSchema,
    interactionId: identifierSchema,
    requestId: acpRequestIdSchema,
    kind: pendingInteractionKindSchema,
    requestedAt: z.string().datetime(),
    summary: safeRunnerEventTextSchema(4_096, "Persisted interaction summary").refine(
      (value) => value.length > 0,
      "Persisted interaction summary must not be empty."
    ),
    status: z.enum(["pending", "approved", "denied", "cancelled", "expired"]),
    actionable: z.literal(false),
    nonActionableReason: z.enum(["persisted_history", "ownership_lost", "terminal_cleanup"])
  })
  .strict();
export type PersistedPendingInteraction = z.infer<typeof persistedPendingInteractionSchema>;

export const runnerSessionActionIdentitySchema = z
  .object({
    scope: z.string().min(1).max(4_096),
    executorRunId: executorRunIdSchema,
    desktopRunId: desktopRunIdSchema,
    runSessionId: runSessionIdSchema,
    claimRef: claimRefSchema,
    sessionId: acpSessionIdSchema
  })
  .strict();
export type RunnerSessionActionIdentity = z.infer<typeof runnerSessionActionIdentitySchema>;

export const runnerRequestActionIdentitySchema = runnerSessionActionIdentitySchema
  .extend({ requestId: acpRequestIdSchema })
  .strict();
export type RunnerRequestActionIdentity = z.infer<typeof runnerRequestActionIdentitySchema>;

export const terminalOutcomeSchema = z
  .object({
    version: runnerContractVersionSchema,
    state: runnerTerminalStateSchema,
    reason: z.enum(["completed", "failed", "cancelled", "timed_out"]).optional(),
    cleanup: z
      .object({ status: z.enum(["succeeded", "failed"]) })
      .strict()
      .optional(),
    exitCode: z.number().int().nullable(),
    finishedAt: z.string().datetime(),
    diagnostic: safeRunnerEventTextSchema(8_192, "Terminal diagnostic").nullable(),
    artifactValidated: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "succeeded" && !value.artifactValidated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactValidated"],
        message: "A succeeded outcome requires a validated artifact."
      });
    }
    if (value.state === "succeeded" && value.cleanup?.status === "failed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cleanup", "status"],
        message: "A succeeded outcome cannot report failed cleanup."
      });
    }
    if (value.reason !== undefined && value.state === "succeeded" && value.reason !== "completed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A succeeded outcome requires the completed reason."
      });
    }
    if (value.reason !== undefined && value.state === "cancelled" && value.reason !== "cancelled") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A cancelled outcome requires the cancelled reason."
      });
    }
    if (
      value.reason !== undefined &&
      value.state === "failed" &&
      !["failed", "timed_out"].includes(value.reason)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A failed outcome requires the failed or timed_out reason."
      });
    }
  });
export type TerminalOutcome = z.infer<typeof terminalOutcomeSchema>;

export const artifactRelativePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > 1_024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Artifact relative path exceeds 1024 UTF-8 bytes."
      });
    }
    if (
      value.startsWith("/") ||
      value.includes("/") ||
      value.includes("\\") ||
      /^[A-Za-z]:/.test(value) ||
      value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Artifact path must be one normalized file name inside its materialization root."
      });
    }
  });
export const artifactKindSchema = z.enum(["implementation", "review", "feedback"]);
const artifactReferenceBase = {
  version: runnerContractVersionSchema,
  relativePath: artifactRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative()
};
export const artifactReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...artifactReferenceBase,
      kind: z.literal("implementation"),
      mediaType: z.literal("text/markdown")
    })
    .strict(),
  z
    .object({
      ...artifactReferenceBase,
      kind: z.literal("review"),
      mediaType: z.literal("application/json")
    })
    .strict(),
  z
    .object({
      ...artifactReferenceBase,
      kind: z.literal("feedback"),
      mediaType: z.literal("text/markdown")
    })
    .strict()
]);
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

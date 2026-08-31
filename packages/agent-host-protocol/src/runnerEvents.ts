import { z } from "zod";
import { dispatchLifecycleIdentitySchema, acpRecoveryIdentitySchema } from "./lifecycle.js";
import {
  containsUnredactedRunnerEventSecret,
  runnerEventRedactionClassSchema,
  runnerEventUtf8ByteLength,
  safeRunnerEventTextSchema
} from "./runnerEventRedaction.js";

export const REMOTE_RUNNER_EVENT_PROTOCOL_VERSIONS = [1, 2] as const;
export const remoteRunnerEventProtocolVersionSchema = z.union([z.literal(1), z.literal(2)]);
const remoteRunnerEventCountersSchema = z
  .object({
    v1Accepted: z.number().int().nonnegative().safe(),
    v2Accepted: z.number().int().nonnegative().safe(),
    v1Degraded: z.number().int().nonnegative().safe(),
    usageSnapshotsAccepted: z.number().int().nonnegative().safe(),
    usageSnapshotRegressions: z.number().int().nonnegative().safe()
  })
  .strict();
export const remoteRunnerEventServerCapabilitySchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  remoteRunnerEventCountersSchema.extend({
    available: z.literal(true),
    acceptedVersions: z.tuple([z.literal(2)]),
    preferredVersion: z.literal(2)
  })
]);
export const REMOTE_RUNNER_EVENT_V2_MAX_COUNT = 128 as const;
export const REMOTE_RUNNER_EVENT_V2_MAX_BYTES = 240 * 1_024;
export const REMOTE_RUNNER_EVENT_TEXT_MAX_BYTES = 64 * 1_024;

export const remoteRunnerEventCursorSchema = z.number().int().nonnegative().safe();
const deliveredRemoteRunnerEventCursorSchema = z.number().int().positive().safe();
const sourceSequenceSchema = z.number().int().positive().safe();
const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const acpRequestIdLeafSchema = identifierSchema.brand<"AcpRequestId">();
const safeMessageSchema = safeRunnerEventTextSchema(
  REMOTE_RUNNER_EVENT_TEXT_MAX_BYTES,
  "Runner event text"
);

export const runnerEventRedactionMetadataSchema = z
  .object({
    classes: z.array(runnerEventRedactionClassSchema).max(2),
    replaced: z.number().int().nonnegative().safe()
  })
  .strict();

export const runnerRedactedContentSchema = z
  .object({ content: safeMessageSchema, redaction: runnerEventRedactionMetadataSchema })
  .strict();

export const runnerLifecycleStateLeafSchema = z.enum([
  "created",
  "initializing",
  "ready",
  "running",
  "waiting_interaction",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled"
]);

export const runnerDiagnosticCodeLeafSchema = z.enum([
  "event_limit_reached",
  "retention_limit_reached",
  "retention_boundary",
  "partial_line_recovered",
  "corrupt_line",
  "initial_sequence_gap",
  "sequence_gap",
  "duplicate_sequence",
  "out_of_order_sequence",
  "terminal_cleanup",
  "missing_log",
  "oversized_log",
  "retention_truncation",
  "subscriber_backpressure",
  "subscriber_callback_failed",
  "conversation_projection_failed",
  "publisher_failed",
  "interaction_persistence_failed",
  "interaction_response_invalid",
  "interaction_observer_failed",
  "protocol_error",
  "remote_acp_event_contract_degraded",
  "remote_engine_capability",
  "remote_engine_cleanup",
  "remote_engine_interaction",
  "remote_engine_terminal",
  "remote_session_identity",
  "remote_usage_snapshot",
  "remote_usage_snapshot_regressed"
]);

const acpSessionTextSchema = safeRunnerEventTextSchema(4_096, "ACP session text");
const acpSessionDescriptionSchema = acpSessionTextSchema.nullable();

export const runnerSessionModeLeafSchema = z
  .object({
    id: acpSessionTextSchema,
    name: acpSessionTextSchema,
    description: acpSessionDescriptionSchema
  })
  .strict();

export const runnerSessionModeStateLeafSchema = z
  .object({
    currentModeId: acpSessionTextSchema,
    availableModes: z.array(runnerSessionModeLeafSchema).max(256)
  })
  .strict();

export const runnerSessionConfigOptionLeafSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: acpSessionTextSchema,
      type: z.literal("select"),
      name: acpSessionTextSchema,
      description: acpSessionDescriptionSchema,
      category: acpSessionTextSchema.nullable(),
      currentValue: acpSessionTextSchema,
      options: z
        .array(
          z
            .object({
              value: acpSessionTextSchema,
              name: acpSessionTextSchema,
              description: acpSessionDescriptionSchema,
              group: acpSessionTextSchema.nullable()
            })
            .strict()
        )
        .max(512)
    })
    .strict(),
  z
    .object({
      id: acpSessionTextSchema,
      type: z.literal("boolean"),
      name: acpSessionTextSchema,
      description: acpSessionDescriptionSchema,
      category: acpSessionTextSchema.nullable(),
      currentValue: z.boolean()
    })
    .strict()
]);

export const runnerSessionConfigurationLeafSchema = z
  .object({
    modes: runnerSessionModeStateLeafSchema.nullable(),
    configOptions: z.array(runnerSessionConfigOptionLeafSchema).max(256)
  })
  .strict();

export const runnerPersistedInteractionLeafSchema = z
  .object({
    version: z.literal("planweave.runner/v1"),
    interactionId: identifierSchema,
    requestId: acpRequestIdLeafSchema,
    kind: z.enum(["permission", "authentication", "elicitation"]),
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

const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]);

export const runnerBodyFragmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("lifecycle"),
      state: runnerLifecycleStateLeafSchema,
      message: safeMessageSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("output"),
      stream: z.enum(["stdout", "stderr"]),
      content: safeMessageSchema,
      redaction: runnerEventRedactionMetadataSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      role: z.enum(["assistant", "user"]),
      messageId: z.string().min(1).max(256).nullable(),
      chunk: z.boolean(),
      content: safeMessageSchema,
      redaction: runnerEventRedactionMetadataSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_call"),
      callId: z.string().min(1).max(256),
      status: toolStatusSchema.nullable(),
      title: safeMessageSchema,
      toolKind: safeMessageSchema.nullable().optional(),
      content: runnerRedactedContentSchema.nullable(),
      rawInput: runnerRedactedContentSchema.nullable().optional(),
      rawOutput: runnerRedactedContentSchema.nullable().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_update"),
      callId: z.string().min(1).max(256),
      status: toolStatusSchema.nullable().optional(),
      title: safeMessageSchema.nullable().optional(),
      toolKind: safeMessageSchema.nullable().optional(),
      content: runnerRedactedContentSchema.nullable().optional(),
      rawInput: runnerRedactedContentSchema.optional(),
      rawOutput: runnerRedactedContentSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan_update"),
      content: safeMessageSchema,
      redaction: runnerEventRedactionMetadataSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("usage_update"),
      usedTokens: z.number().int().nonnegative().safe(),
      contextWindowTokens: z.number().int().positive().safe(),
      cost: z
        .object({ amount: z.number().nonnegative(), currency: z.string().length(3) })
        .strict()
        .nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("session_configuration_snapshot"),
      phase: z.enum(["initial", "defaults_applied"]),
      configuration: runnerSessionConfigurationLeafSchema
    })
    .strict(),
  z
    .object({ kind: z.literal("session_mode_update"), currentModeId: acpSessionTextSchema })
    .strict(),
  z
    .object({
      kind: z.literal("session_config_options_update"),
      configOptions: z.array(runnerSessionConfigOptionLeafSchema).max(256)
    })
    .strict(),
  z
    .object({
      kind: z.literal("terminal_output"),
      terminalId: z.string().min(1).max(256),
      content: safeMessageSchema,
      redaction: runnerEventRedactionMetadataSchema
    })
    .strict(),
  z
    .object({ kind: z.literal("interaction"), interaction: runnerPersistedInteractionLeafSchema })
    .strict(),
  z
    .object({
      kind: z.literal("interaction_result"),
      requestId: acpRequestIdLeafSchema,
      interactionId: z.string().min(1).max(256),
      interactionKind: z.enum(["permission", "authentication", "elicitation"]),
      outcome: z.enum(["approved", "denied", "submitted", "cancelled", "expired"]),
      message: safeMessageSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("diagnostic"),
      code: runnerDiagnosticCodeLeafSchema,
      message: safeMessageSchema
    })
    .strict()
]);

export const engineUsageSnapshotLeafSchema = z
  .object({
    semantics: z.literal("cumulative_session_total"),
    totalTokens: z.number().int().nonnegative().safe(),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    thoughtTokens: z.number().int().nonnegative().safe().nullable(),
    cachedReadTokens: z.number().int().nonnegative().safe().nullable(),
    cachedWriteTokens: z.number().int().nonnegative().safe().nullable()
  })
  .strict();

const engineCapabilitySchema = z.enum([
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

const uniqueEngineCapabilitiesSchema = z
  .array(engineCapabilitySchema)
  .max(32)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Engine capabilities must be unique." });
    }
  });

export const engineEvidenceLeafSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("lifecycle"), state: z.enum(["connecting", "running", "cleanup"]) })
    .strict(),
  z
    .object({
      kind: z.literal("capability_snapshot"),
      required: uniqueEngineCapabilitiesSchema,
      negotiated: uniqueEngineCapabilitiesSchema,
      missing: uniqueEngineCapabilitiesSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("capabilities"),
      capabilities: z
        .object({
          loadSession: z.boolean(),
          closeSession: z.boolean(),
          prompt: z
            .object({ image: z.boolean(), audio: z.boolean(), embeddedContext: z.boolean() })
            .strict(),
          mcp: z.object({ http: z.boolean(), sse: z.boolean() }).strict(),
          client: z.object({ permission: z.literal(true), elicitation: z.boolean() }).strict()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal("session_started"),
      sessionId: acpRecoveryIdentitySchema.shape.acpSessionId,
      loaded: z.boolean()
    })
    .strict(),
  z.object({ kind: z.literal("usage_snapshot"), usage: engineUsageSnapshotLeafSchema }).strict(),
  z
    .object({
      kind: z.literal("interaction"),
      requestId: acpRequestIdLeafSchema,
      interaction: z.enum(["permission", "elicitation"]),
      state: z.enum(["requested", "resolved"]),
      outcome: z.enum(["selected", "cancelled", "accepted", "declined"]).optional()
    })
    .strict()
]);

export const engineTerminalLeafSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("succeeded"), stopReason: safeMessageSchema }).strict(),
  z.object({ state: z.literal("cancelled"), message: safeMessageSchema }).strict(),
  z
    .object({
      state: z.literal("failed"),
      reason: z.enum([
        "authentication_required",
        "capability_missing",
        "interaction_failed",
        "interaction_timeout",
        "limit_exceeded",
        "operation_timeout",
        "process_error",
        "protocol_error",
        "event_sink_failed",
        "incomplete_response",
        "cleanup_failed",
        "unknown_error"
      ]),
      message: safeMessageSchema
    })
    .strict()
]);

export const remoteRunnerEventFragmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runner_body"), body: runnerBodyFragmentSchema }).strict(),
  z.object({ kind: z.literal("engine_evidence"), evidence: engineEvidenceLeafSchema }).strict(),
  z.object({ kind: z.literal("engine_terminal"), terminal: engineTerminalLeafSchema }).strict()
]);

export const remoteRunnerEventV2Schema = z
  .object({
    eventVersion: z.literal(2),
    cursor: deliveredRemoteRunnerEventCursorSchema,
    sourceSequence: sourceSequenceSchema,
    timestamp: z.string().datetime(),
    fragment: remoteRunnerEventFragmentSchema
  })
  .strict()
  .superRefine((event, context) => {
    const encoded = JSON.stringify(event);
    if (containsUnredactedRunnerEventSecret(encoded)) {
      context.addIssue({ code: "custom", message: "Remote runner event contains a secret." });
    }
    if (runnerEventUtf8ByteLength(encoded) > REMOTE_RUNNER_EVENT_V2_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "Remote runner event exceeds its byte limit." });
    }
  });

export const remoteRunnerEventBatchV2Schema = dispatchLifecycleIdentitySchema
  .extend({
    type: z.literal("acp.events"),
    eventProtocolVersion: z.literal(2),
    acpSessionId: acpRecoveryIdentitySchema.shape.acpSessionId,
    afterCursor: remoteRunnerEventCursorSchema,
    cursor: remoteRunnerEventCursorSchema,
    events: z.array(remoteRunnerEventV2Schema).min(1).max(REMOTE_RUNNER_EVENT_V2_MAX_COUNT)
  })
  .superRefine((batch, context) => {
    let expected = batch.afterCursor + 1;
    for (const event of batch.events) {
      if (event.cursor !== expected) {
        context.addIssue({
          code: "custom",
          message: "Remote runner event cursors must be contiguous and monotonic.",
          path: ["events"]
        });
        return;
      }
      expected += 1;
    }
    if (batch.cursor !== expected - 1) {
      context.addIssue({
        code: "custom",
        message: "Batch cursor must equal the final event cursor.",
        path: ["cursor"]
      });
    }
    if (runnerEventUtf8ByteLength(JSON.stringify(batch)) > REMOTE_RUNNER_EVENT_V2_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Remote runner event batch exceeds its byte limit."
      });
    }
  });

export type RunnerBodyFragment = z.infer<typeof runnerBodyFragmentSchema>;
export type EngineEvidenceLeaf = z.infer<typeof engineEvidenceLeafSchema>;
export type EngineUsageSnapshotLeaf = z.infer<typeof engineUsageSnapshotLeafSchema>;
export type EngineTerminalLeaf = z.infer<typeof engineTerminalLeafSchema>;
export type RemoteRunnerEventFragment = z.infer<typeof remoteRunnerEventFragmentSchema>;
export type RemoteRunnerEventV2 = z.infer<typeof remoteRunnerEventV2Schema>;
export type RemoteRunnerEventBatchV2 = z.infer<typeof remoteRunnerEventBatchV2Schema>;
export type RemoteRunnerEventProtocolVersion = z.infer<
  typeof remoteRunnerEventProtocolVersionSchema
>;
export type RemoteRunnerEventServerCapability = z.infer<
  typeof remoteRunnerEventServerCapabilitySchema
>;

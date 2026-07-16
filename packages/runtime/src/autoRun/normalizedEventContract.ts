import { z } from "zod";
import {
  acpRequestIdSchema,
  acpCorrelationSchema,
  artifactReferenceSchema,
  pendingInteractionKindSchema,
  persistedPendingInteractionSchema,
  runnerIdentitySchema,
  runnerLifecycleStateSchema,
  runnerRunIdentitySchema,
  terminalOutcomeSchema
} from "./runnerContractSchemas.js";
import {
  containsUnredactedRunnerSecret,
  redactRunnerEventText,
  redactionClassSchema,
  safeRunnerEventTextSchema,
  utf8ByteLength,
  type RedactionClass
} from "./runnerEventRedaction.js";
import {
  acpSessionConfigOptionSchema,
  acpSessionConfigurationSchema
} from "./acpSessionConfiguration.js";

export const RUNNER_EVENT_MAX_LINE_BYTES = 256 * 1_024;
const RUNNER_EVENT_RECORD_DELIMITER = "\n";
export const RUNNER_EVENT_MAX_ENCODED_BYTES =
  RUNNER_EVENT_MAX_LINE_BYTES + utf8ByteLength(RUNNER_EVENT_RECORD_DELIMITER);
export const RUNNER_EVENT_MAX_MESSAGE_BYTES = 64 * 1_024;
export const RUNNER_EVENT_RETENTION_MAX_BYTES = 32 * 1_024 * 1_024;
export const RUNNER_EVENT_RETENTION_MAX_EVENTS = 100_000;

const redactionSchema = z
  .object({
    classes: z.array(redactionClassSchema).max(2),
    replaced: z.number().int().nonnegative()
  })
  .strict();

const persistedMessageSchema = safeRunnerEventTextSchema(
  RUNNER_EVENT_MAX_MESSAGE_BYTES,
  "Runner event message"
);

const lifecycleEventBodySchema = z
  .object({
    kind: z.literal("lifecycle"),
    state: runnerLifecycleStateSchema,
    message: persistedMessageSchema
  })
  .strict();
const outputEventBodySchema = z
  .object({
    kind: z.literal("output"),
    stream: z.enum(["stdout", "stderr"]),
    content: persistedMessageSchema,
    redaction: redactionSchema
  })
  .strict();
const redactedContentSchema = z
  .object({ content: persistedMessageSchema, redaction: redactionSchema })
  .strict();
const messageEventBodySchema = z
  .object({
    kind: z.literal("message"),
    role: z.enum(["assistant", "user"]),
    messageId: z.string().min(1).max(256).nullable(),
    chunk: z.boolean(),
    content: persistedMessageSchema,
    redaction: redactionSchema
  })
  .strict();
const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]);
const toolCallEventBodySchema = z
  .object({
    kind: z.literal("tool_call"),
    callId: z.string().min(1).max(256),
    status: toolStatusSchema.nullable(),
    title: persistedMessageSchema,
    toolKind: persistedMessageSchema.nullable().optional(),
    content: redactedContentSchema.nullable(),
    rawInput: redactedContentSchema.nullable().optional(),
    rawOutput: redactedContentSchema.nullable().optional()
  })
  .strict();
const toolUpdateEventBodySchema = z
  .object({
    kind: z.literal("tool_update"),
    callId: z.string().min(1).max(256),
    status: toolStatusSchema.nullable().optional(),
    title: persistedMessageSchema.nullable().optional(),
    toolKind: persistedMessageSchema.nullable().optional(),
    content: redactedContentSchema.nullable().optional(),
    rawInput: redactedContentSchema.optional(),
    rawOutput: redactedContentSchema.optional()
  })
  .strict();
const planUpdateEventBodySchema = z
  .object({
    kind: z.literal("plan_update"),
    content: persistedMessageSchema,
    redaction: redactionSchema
  })
  .strict();
const usageUpdateEventBodySchema = z
  .object({
    kind: z.literal("usage_update"),
    usedTokens: z.number().int().nonnegative(),
    contextWindowTokens: z.number().int().positive(),
    cost: z
      .object({ amount: z.number().nonnegative(), currency: z.string().length(3) })
      .strict()
      .nullable()
  })
  .strict();
const sessionConfigurationSnapshotEventBodySchema = z
  .object({
    kind: z.literal("session_configuration_snapshot"),
    phase: z.enum(["initial", "defaults_applied"]),
    configuration: acpSessionConfigurationSchema
  })
  .strict();
const sessionModeUpdateEventBodySchema = z
  .object({
    kind: z.literal("session_mode_update"),
    currentModeId: z.string().max(4_096)
  })
  .strict();
const sessionConfigOptionsUpdateEventBodySchema = z
  .object({
    kind: z.literal("session_config_options_update"),
    configOptions: z.array(acpSessionConfigOptionSchema).max(256)
  })
  .strict();
const terminalOutputEventBodySchema = z
  .object({
    kind: z.literal("terminal_output"),
    terminalId: z.string().min(1).max(256),
    content: persistedMessageSchema,
    redaction: redactionSchema
  })
  .strict();
const interactionEventBodySchema = z
  .object({ kind: z.literal("interaction"), interaction: persistedPendingInteractionSchema })
  .strict();
const interactionResultEventBodySchema = z
  .object({
    kind: z.literal("interaction_result"),
    requestId: acpRequestIdSchema,
    interactionId: z.string().min(1).max(256),
    interactionKind: pendingInteractionKindSchema,
    outcome: z.enum(["approved", "denied", "submitted", "cancelled"]),
    message: persistedMessageSchema
  })
  .strict();
const artifactEventBodySchema = z
  .object({ kind: z.literal("artifact"), artifact: artifactReferenceSchema })
  .strict();
const terminalEventBodySchema = z
  .object({ kind: z.literal("terminal"), outcome: terminalOutcomeSchema })
  .strict();
export const runnerDiagnosticCodeSchema = z.enum([
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
  "protocol_error"
]);
const diagnosticEventBodySchema = z
  .object({
    kind: z.literal("diagnostic"),
    code: runnerDiagnosticCodeSchema,
    message: persistedMessageSchema
  })
  .strict();

export const normalizedRunnerEventSchema = z
  .object({
    version: z.literal("planweave.runner-event/v1"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    identity: runnerRunIdentitySchema,
    runner: runnerIdentitySchema,
    correlation: acpCorrelationSchema.optional(),
    body: z.discriminatedUnion("kind", [
      lifecycleEventBodySchema,
      outputEventBodySchema,
      messageEventBodySchema,
      toolCallEventBodySchema,
      toolUpdateEventBodySchema,
      planUpdateEventBodySchema,
      usageUpdateEventBodySchema,
      sessionConfigurationSnapshotEventBodySchema,
      sessionModeUpdateEventBodySchema,
      sessionConfigOptionsUpdateEventBodySchema,
      terminalOutputEventBodySchema,
      interactionEventBodySchema,
      interactionResultEventBodySchema,
      artifactEventBodySchema,
      terminalEventBodySchema,
      diagnosticEventBodySchema
    ])
  })
  .strict()
  .superRefine((event, context) => {
    if (event.runner.runnerKind === "cli" && event.correlation !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correlation"],
        message: "ACP correlation ids are only valid for ACP runner events."
      });
    }
    if (
      (event.body.kind === "session_configuration_snapshot" ||
        event.body.kind === "session_mode_update" ||
        event.body.kind === "session_config_options_update") &&
      event.correlation?.sessionId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["correlation", "sessionId"],
        message: "ACP session configuration events require a sessionId correlation."
      });
    }
  });
export type NormalizedRunnerEvent = z.infer<typeof normalizedRunnerEventSchema>;

export type NormalizedOutputBody = z.infer<typeof outputEventBodySchema>;
export type NormalizedDiagnosticBody = z.infer<typeof diagnosticEventBodySchema>;

export function normalizedRedactedContent(content: string) {
  const redacted = redactRunnerEventText(content);
  return redactedContentSchema.parse({
    content: redacted.text,
    redaction: { classes: redacted.classes, replaced: redacted.replaced }
  });
}

export function normalizedOutputBody(
  stream: "stdout" | "stderr",
  content: string
): NormalizedOutputBody {
  const redacted = redactRunnerEventText(content);
  return outputEventBodySchema.parse({
    kind: "output",
    stream,
    content: redacted.text,
    redaction: { classes: redacted.classes, replaced: redacted.replaced }
  });
}

export function normalizedDiagnosticBody(
  code: z.infer<typeof runnerDiagnosticCodeSchema>,
  message: string
): NormalizedDiagnosticBody {
  const redacted = redactRunnerEventText(message);
  return diagnosticEventBodySchema.parse({ kind: "diagnostic", code, message: redacted.text });
}

export function encodeNormalizedRunnerEvent(event: NormalizedRunnerEvent): string {
  const parsed = normalizedRunnerEventSchema.parse(event);
  const line = JSON.stringify(parsed);
  if (containsUnredactedRunnerSecret(line)) {
    throw new Error("Normalized runner event contains unredacted credential material.");
  }
  if (utf8ByteLength(line) > RUNNER_EVENT_MAX_LINE_BYTES) {
    throw new Error(
      `Normalized runner event exceeds the ${RUNNER_EVENT_MAX_LINE_BYTES}-byte UTF-8 line limit.`
    );
  }
  return `${line}${RUNNER_EVENT_RECORD_DELIMITER}`;
}

export {
  containsUnredactedRunnerSecret,
  redactRunnerEventText,
  redactionClassSchema,
  safeRunnerEventTextSchema,
  utf8ByteLength
};
export type { RedactionClass };

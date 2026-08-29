import { z } from "zod";
import {
  runnerBodyFragmentSchema,
  runnerDiagnosticCodeLeafSchema,
  runnerRedactedContentSchema
} from "@planweave-ai/agent-host-protocol/browser";
import {
  acpCorrelationSchema,
  artifactReferenceSchema,
  runnerIdentitySchema,
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

export const RUNNER_EVENT_MAX_LINE_BYTES = 256 * 1_024;
const RUNNER_EVENT_RECORD_DELIMITER = "\n";
export const RUNNER_EVENT_MAX_ENCODED_BYTES =
  RUNNER_EVENT_MAX_LINE_BYTES + utf8ByteLength(RUNNER_EVENT_RECORD_DELIMITER);
export const RUNNER_EVENT_MAX_MESSAGE_BYTES = 64 * 1_024;
export const RUNNER_EVENT_RETENTION_MAX_BYTES = 32 * 1_024 * 1_024;
export const RUNNER_EVENT_RETENTION_MAX_EVENTS = 100_000;

const redactedContentSchema = runnerRedactedContentSchema;
const outputEventBodySchema = runnerBodyFragmentSchema.options[1];
const diagnosticEventBodySchema = runnerBodyFragmentSchema.options[13];
const artifactEventBodySchema = z
  .object({ kind: z.literal("artifact"), artifact: artifactReferenceSchema })
  .strict();
const terminalEventBodySchema = z
  .object({ kind: z.literal("terminal"), outcome: terminalOutcomeSchema })
  .strict();
export const runnerDiagnosticCodeSchema = runnerDiagnosticCodeLeafSchema;

export const normalizedRunnerEventSchema = z
  .object({
    version: z.literal("planweave.runner-event/v1"),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    identity: runnerRunIdentitySchema,
    runner: runnerIdentitySchema,
    correlation: acpCorrelationSchema.optional(),
    body: z.discriminatedUnion("kind", [
      ...runnerBodyFragmentSchema.options,
      artifactEventBodySchema,
      terminalEventBodySchema
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

export type NormalizedOutputBody = Extract<NormalizedRunnerEvent["body"], { kind: "output" }>;
export type NormalizedDiagnosticBody = Extract<
  NormalizedRunnerEvent["body"],
  { kind: "diagnostic" }
>;

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

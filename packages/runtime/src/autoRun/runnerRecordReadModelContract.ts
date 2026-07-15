import { z } from "zod";
import { acpConversationItemSchema, acpTimelineItemSchema } from "./acpConversationProjection.js";
import { normalizedRunnerEventSchema } from "./normalizedEventContract.js";
import { safeRunnerEventTextSchema } from "./runnerEventRedaction.js";
import { runnerEventCursorSchema, runnerEventReplayDiagnosticSchema } from "./runnerEventReplay.js";
import {
  acpSessionIdSchema,
  claimRefSchema,
  executorRunIdSchema,
  runnerRequestActionIdentitySchema,
  runnerSessionActionIdentitySchema
} from "./runnerContractSchemas.js";
import { acpActualSessionConfigurationSchema } from "./acpSessionConfiguration.js";

const runnerActionAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().min(1).max(512).nullable()
  })
  .strict();

export const desktopAgentPromptIdentitySchema = z
  .object({
    ref: z
      .object({
        projectRoot: z.string().min(1),
        canvasId: z.string().min(1).nullable().optional()
      })
      .strict(),
    recordId: z.string().min(1),
    executorRunId: executorRunIdSchema,
    claimRef: claimRefSchema,
    sessionId: acpSessionIdSchema
  })
  .strict();
export type DesktopAgentPromptIdentity = z.infer<typeof desktopAgentPromptIdentitySchema>;

const runnerRecordActiveInteractionBaseSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    interactionId: z.string().min(1).max(256),
    requestedAt: z.string().datetime(),
    summary: safeRunnerEventTextSchema(4_096, "Active interaction summary").refine(
      (value) => value.length > 0,
      "Active interaction summary must not be empty."
    ),
    identity: runnerRequestActionIdentitySchema,
    availability: runnerActionAvailabilitySchema
  })
  .strict();

const runnerRecordActiveInteractionSchema = z.discriminatedUnion("kind", [
  runnerRecordActiveInteractionBaseSchema
    .extend({
      kind: z.literal("permission"),
      permissionOptions: z
        .array(
          z
            .object({
              optionId: z.string().min(1).max(256),
              label: safeRunnerEventTextSchema(512, "Permission option label"),
              decision: z.enum(["approve", "deny"])
            })
            .strict()
        )
        .min(1)
    })
    .strict(),
  runnerRecordActiveInteractionBaseSchema
    .extend({
      kind: z.literal("elicitation"),
      elicitationSchema: z.json()
    })
    .strict(),
  runnerRecordActiveInteractionBaseSchema
    .extend({
      kind: z.literal("authentication")
    })
    .strict()
]);

export const runnerRecordReadModelSchema = z
  .object({
    events: z.array(normalizedRunnerEventSchema),
    conversation: z.array(acpConversationItemSchema),
    timeline: z.array(acpTimelineItemSchema),
    diagnostics: z.array(runnerEventReplayDiagnosticSchema),
    cursor: runnerEventCursorSchema,
    terminal: z.boolean(),
    actualConfiguration: acpActualSessionConfigurationSchema,
    intervention: z
      .object({
        prompt: runnerActionAvailabilitySchema
          .extend({
            identity: desktopAgentPromptIdentitySchema.nullable(),
            inFlight: z.boolean()
          })
          .strict(),
        cancel: runnerActionAvailabilitySchema
          .extend({
            identity: runnerSessionActionIdentitySchema.nullable()
          })
          .strict()
      })
      .strict(),
    interaction: z
      .object({
        persisted: z.boolean(),
        active: z.boolean(),
        stale: z.boolean(),
        activeRequests: z.array(runnerRecordActiveInteractionSchema)
      })
      .strict()
  })
  .strict();
export type RunnerRecordReadModel = z.infer<typeof runnerRecordReadModelSchema>;

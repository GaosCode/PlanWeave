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
import {
  runnerInteractionIdentitySchema,
  runnerPermissionOptionSchema
} from "./runnerInteractionContract.js";
import {
  runnerInteractionAvailabilityReasonSchema,
  runnerInteractionContractDiagnosticSchema
} from "./runnerInteractionAvailabilityContract.js";

const runnerLiveActionAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().min(1).max(512).nullable()
  })
  .strict();

export const runnerPersistedInteractionAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: runnerInteractionAvailabilityReasonSchema.nullable()
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
export type RunnerRecordLiveActionIdentity = z.infer<typeof runnerRequestActionIdentitySchema>;

export function isRunnerRecordLiveActionIdentity(
  identity: unknown
): identity is RunnerRecordLiveActionIdentity {
  return runnerRequestActionIdentitySchema.safeParse(identity).success;
}

const runnerRecordActiveInteractionBaseSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    interactionId: z.string().min(1).max(256),
    requestedAt: z.string().datetime(),
    summary: safeRunnerEventTextSchema(4096, "Active interaction summary").refine(
      (value) => value.length > 0,
      "Active interaction summary must not be empty."
    )
  })
  .strict();

const runnerRecordActiveInteractionSchema = z.union([
  z.union([
    runnerRecordActiveInteractionBaseSchema
      .extend({
        kind: z.literal("permission"),
        identity: runnerInteractionIdentitySchema,
        permissionOptions: z.array(runnerPermissionOptionSchema).min(1),
        availability: runnerPersistedInteractionAvailabilitySchema
      })
      .strict(),
    runnerRecordActiveInteractionBaseSchema
      .extend({
        kind: z.literal("permission"),
        identity: runnerRequestActionIdentitySchema,
        permissionOptions: z.array(runnerPermissionOptionSchema).min(1),
        availability: runnerLiveActionAvailabilitySchema
      })
      .strict()
  ]),
  runnerRecordActiveInteractionBaseSchema
    .extend({
      kind: z.literal("elicitation"),
      identity: runnerRequestActionIdentitySchema,
      elicitationSchema: z.json(),
      availability: runnerLiveActionAvailabilitySchema
    })
    .strict(),
  runnerRecordActiveInteractionBaseSchema
    .extend({
      kind: z.literal("authentication"),
      identity: runnerRequestActionIdentitySchema,
      availability: runnerLiveActionAvailabilitySchema
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
        prompt: runnerLiveActionAvailabilitySchema
          .extend({
            identity: desktopAgentPromptIdentitySchema.nullable(),
            inFlight: z.boolean()
          })
          .strict(),
        cancel: runnerLiveActionAvailabilitySchema
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
        activeRequests: z.array(runnerRecordActiveInteractionSchema),
        diagnostic: runnerInteractionContractDiagnosticSchema.optional()
      })
      .strict()
  })
  .strict();
export type RunnerRecordReadModel = z.infer<typeof runnerRecordReadModelSchema>;

import { z } from "zod";
import { executionEnvelopeSchema } from "./executionEnvelope.js";
import { remoteRunnerEventFragmentSchema } from "./runnerEvents.js";
import { safeRunnerEventTextSchema } from "./runnerEventRedaction.js";

export const ACP_TASK_RESTORE_CAPABILITY = "acp-task-restore.v1";
export const ACP_CONVERSATION_CAPABILITY = "acp-conversation.v1";
const identifier = z.string().min(1).max(256);
const sessionId = z.string().min(1).max(1024);
const text = safeRunnerEventTextSchema(64 * 1024, "Conversation text");
const identity = { turnId: identifier, executionAttemptId: identifier, sessionId };

export const acpConversationDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), optionId: identifier.nullable() }).strict(),
  z
    .object({
      kind: z.literal("elicitation"),
      action: z.enum(["accept", "decline", "cancel"]),
      content: z.record(z.string(), z.unknown()).optional()
    })
    .strict()
]);

export const acpConversationActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("restore_task"), ...identity }).strict(),
  z
    .object({
      kind: z.literal("prompt"),
      ...identity,
      text: z
        .string()
        .trim()
        .min(1)
        .max(32 * 1024)
    })
    .strict(),
  z.object({ kind: z.literal("cancel"), ...identity }).strict(),
  z
    .object({
      kind: z.literal("respond"),
      ...identity,
      requestId: identifier,
      decision: acpConversationDecisionSchema
    })
    .strict()
]);
export type AcpConversationAction = z.infer<typeof acpConversationActionSchema>;

const commandIdentity = { protocolVersion: z.literal(1), operationId: identifier, ...identity };
export const acpConversationPromptCommandSchema = z
  .object({
    ...commandIdentity,
    type: z.literal("acp_conversation.prompt"),
    text: z
      .string()
      .trim()
      .min(1)
      .max(32 * 1024),
    expiresAt: z.string().datetime(),
    sourceEnvelope: executionEnvelopeSchema
  })
  .strict()
  .superRefine((command, context) => {
    if (command.executionAttemptId !== command.sourceEnvelope.execution.attemptId) {
      context.addIssue({
        code: "custom",
        message: "Conversation must reference its source execution attempt."
      });
    }
  });
export const acpConversationCancelCommandSchema = z
  .object({
    ...commandIdentity,
    type: z.literal("acp_conversation.cancel")
  })
  .strict();
export const acpConversationRespondCommandSchema = z
  .object({
    ...commandIdentity,
    type: z.literal("acp_conversation.respond"),
    requestId: identifier,
    decision: acpConversationDecisionSchema
  })
  .strict();
export const acpConversationCommandSchema = z.discriminatedUnion("type", [
  acpConversationPromptCommandSchema,
  acpConversationCancelCommandSchema,
  acpConversationRespondCommandSchema
]);
export type AcpConversationCommand = z.infer<typeof acpConversationCommandSchema>;
export type AcpConversationPromptCommand = z.infer<typeof acpConversationPromptCommandSchema>;

export const acpConversationInteractionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("permission"),
      requestId: identifier,
      summary: text,
      deadline: z.string().datetime(),
      options: z
        .array(
          z
            .object({ optionId: identifier, label: text, decision: z.enum(["approve", "deny"]) })
            .strict()
        )
        .min(1)
        .max(64)
    })
    .strict(),
  z
    .object({
      kind: z.literal("elicitation"),
      requestId: identifier,
      message: text,
      requestedSchema: z.record(z.string(), z.unknown()),
      deadline: z.string().datetime()
    })
    .strict()
]);
export type AcpConversationInteraction = z.infer<typeof acpConversationInteractionSchema>;
export const acpConversationTurnStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);
export const acpConversationPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runner"), fragment: remoteRunnerEventFragmentSchema }).strict(),
  z.object({ kind: z.literal("interaction"), request: acpConversationInteractionSchema }).strict(),
  z.object({ kind: z.literal("interaction_settled"), requestId: identifier }).strict(),
  z
    .object({
      kind: z.literal("status"),
      status: acpConversationTurnStatusSchema.exclude(["queued"]),
      error: text.nullable()
    })
    .strict()
]);
export const acpConversationEventSchema = z
  .object({
    ...commandIdentity,
    type: z.literal("acp_conversation.event"),
    messageId: identifier,
    sequence: z.number().int().positive().safe(),
    timestamp: z.string().datetime(),
    payload: acpConversationPayloadSchema
  })
  .strict();
export type AcpConversationEvent = z.infer<typeof acpConversationEventSchema>;
export const acpConversationTurnSchema = z
  .object({
    ...identity,
    status: acpConversationTurnStatusSchema,
    createdAt: z.string().datetime(),
    error: text.nullable()
  })
  .strict();
export const acpConversationPageSchema = z
  .object({
    available: z.boolean(),
    canRestoreTask: z.boolean().default(false),
    restoredOperationId: identifier.nullable().default(null),
    reason: z.string().max(256).nullable(),
    executionAttemptId: identifier,
    sessionId: sessionId.nullable(),
    turns: z.array(acpConversationTurnSchema),
    events: z.array(acpConversationEventSchema),
    cursor: z.number().int().nonnegative().safe(),
    hasMore: z.boolean(),
    turnCursor: identifier.nullable().default(null),
    hasMoreTurns: z.boolean().default(false),
    retention: z
      .object({
        compactedTurnIds: z.array(identifier).min(1).max(256)
      })
      .strict()
      .optional()
  })
  .strict();
export type AcpConversationPage = z.infer<typeof acpConversationPageSchema>;
export const acpConversationPaginatedPageSchema = acpConversationPageSchema.extend({
  turnCursor: acpConversationPageSchema.shape.turnCursor.removeDefault(),
  hasMoreTurns: acpConversationPageSchema.shape.hasMoreTurns.removeDefault()
});
export const acpConversationLegacyPageSchema = acpConversationPageSchema.omit({
  turnCursor: true,
  hasMoreTurns: true
});
export const acpConversationOrderedTurnSchema = acpConversationTurnSchema.extend({
  turnOrder: z.number().int().positive().safe()
});
export const acpConversationOrderedPageSchema = acpConversationPageSchema.extend({
  turns: z.array(acpConversationOrderedTurnSchema)
});
export const acpConversationOrderedPaginatedPageSchema = acpConversationOrderedPageSchema.extend({
  turnCursor: acpConversationPaginatedPageSchema.shape.turnCursor,
  hasMoreTurns: acpConversationPaginatedPageSchema.shape.hasMoreTurns
});
export type AcpConversationOrderedPage = z.infer<typeof acpConversationOrderedPageSchema>;
export type AcpConversationPageVersion = 1 | 2 | 3;

export function acpConversationEventPageBytes(event: AcpConversationEvent): number {
  return new TextEncoder().encode(
    JSON.stringify({
      available: false,
      canRestoreTask: false,
      restoredOperationId: "\u0000".repeat(256),
      reason: "\u0000".repeat(256),
      executionAttemptId: event.executionAttemptId,
      sessionId: event.sessionId,
      turns: [],
      events: [event],
      cursor: Number.MAX_SAFE_INTEGER,
      hasMore: false,
      turnCursor: "\u0000".repeat(256),
      hasMoreTurns: false
    })
  ).byteLength;
}

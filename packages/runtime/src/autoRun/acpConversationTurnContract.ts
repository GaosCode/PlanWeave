import { z } from "zod";
import { desktopAgentPromptIdentitySchema } from "./runnerRecordReadModelContract.js";

export const acpConversationTurnIdentitySchema = desktopAgentPromptIdentitySchema
  .extend({
    version: z.literal("planweave.agent-prompt-turn/v1"),
    turnId: z.uuid()
  })
  .strict();
export type AcpConversationTurnIdentity = z.infer<typeof acpConversationTurnIdentitySchema>;

export const acpConversationTurnPhaseSchema = z.enum([
  "starting",
  "initializing",
  "authenticating",
  "loading",
  "prompting",
  "cancelling",
  "cleaning",
  "terminal"
]);
export type AcpConversationTurnPhase = z.infer<typeof acpConversationTurnPhaseSchema>;

export const acpConversationTurnStateSchema = z
  .object({
    identity: acpConversationTurnIdentitySchema,
    phase: acpConversationTurnPhaseSchema,
    terminal: z.enum(["succeeded", "failed", "cancelled"]).nullable(),
    cancellationRequested: z.boolean(),
    cancellable: z.boolean()
  })
  .strict();
export type AcpConversationTurnState = z.infer<typeof acpConversationTurnStateSchema>;

export const acpConversationTurnQueryResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), state: acpConversationTurnStateSchema }).strict(),
  z
    .object({
      found: z.literal(false),
      reason: z.enum(["not_found", "identity_mismatch"])
    })
    .strict()
]);
export type AcpConversationTurnQueryResult = z.infer<typeof acpConversationTurnQueryResultSchema>;

export const acpConversationTurnCancelResultSchema = z
  .object({
    outcome: z.enum([
      "cancel_requested",
      "already_cancelling",
      "not_cancellable",
      "already_terminal",
      "not_found",
      "identity_mismatch"
    ]),
    state: acpConversationTurnStateSchema.nullable()
  })
  .strict();
export type AcpConversationTurnCancelResult = z.infer<typeof acpConversationTurnCancelResultSchema>;

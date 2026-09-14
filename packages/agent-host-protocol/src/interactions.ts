import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";
import {
  INTERACTION_TEXT_MAX_LENGTH,
  interactionActionIdSchema,
  interactionIdentitySchema,
  exactPermissionRequestSchema,
  historicalPermissionRequestSchema,
  exactPermissionSettlementSchema,
  historicalPermissionSettlementSchema,
  parseExactPermissionSettlementForRequest,
  assertInteractionIdentityMatches
} from "./acpPermissionInteractions.js";

export {
  INTERACTION_TEXT_MAX_LENGTH,
  interactionActionIdSchema
} from "./acpPermissionInteractions.js";
export const INTERACTION_OPTION_MAX_COUNT = 64 as const;

const interactionRequestIdentitySchema = interactionIdentitySchema.extend({
  expiresAt: z.string().datetime()
});

export const interactionRequestSchema = z.discriminatedUnion("type", [
  exactPermissionRequestSchema,
  interactionRequestIdentitySchema.extend({
    type: z.literal("interaction.elicitation_requested"),
    prompt: z.string().min(1).max(INTERACTION_TEXT_MAX_LENGTH),
    options: z.array(z.string().min(1).max(512)).max(INTERACTION_OPTION_MAX_COUNT)
  }),
  interactionRequestIdentitySchema.extend({
    type: z.literal("interaction.authentication_required"),
    agentProfileId: opaqueIdentifierSchema,
    hostInstruction: z.string().min(1).max(INTERACTION_TEXT_MAX_LENGTH)
  })
]);

export const interactionSettlementSchema = z.discriminatedUnion("type", [
  exactPermissionSettlementSchema,
  interactionIdentitySchema
    .extend({
      type: z.literal("interaction.elicitation_response"),
      outcome: z.enum(["accepted", "cancelled"]),
      response: z.string().max(INTERACTION_TEXT_MAX_LENGTH).optional()
    })
    .superRefine((settlement, context) => {
      if (settlement.outcome === "accepted" && settlement.response === undefined) {
        context.addIssue({
          code: "custom",
          path: ["response"],
          message: "Accepted elicitation requires a response."
        });
      }
      if (settlement.outcome === "cancelled" && settlement.response !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["response"],
          message: "Cancelled elicitation must not include a response."
        });
      }
    }),
  interactionIdentitySchema.extend({
    type: z.literal("interaction.authentication_action"),
    action: z.enum(["retry_after_host_login", "cancel"])
  })
]);

/** Read boundary for persisted requests and observations from unupgraded Hosts. */
export const historicalInteractionRequestSchema = z.union([
  historicalPermissionRequestSchema,
  interactionRequestSchema.options[1],
  interactionRequestSchema.options[2]
]);
export const historicalInteractionSettlementSchema = z.union([
  historicalPermissionSettlementSchema,
  interactionSettlementSchema.options[1],
  interactionSettlementSchema.options[2]
]);
export type HistoricalInteractionRequest = z.infer<typeof historicalInteractionRequestSchema>;
export type HistoricalInteractionSettlement = z.infer<typeof historicalInteractionSettlementSchema>;

export type InteractionActionId = z.infer<typeof interactionActionIdSchema>;
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;
export type InteractionSettlement = z.infer<typeof interactionSettlementSchema>;

const settlementTypeByRequestType = {
  "interaction.permission_requested": "interaction.permission_response",
  "interaction.elicitation_requested": "interaction.elicitation_response",
  "interaction.authentication_required": "interaction.authentication_action"
} as const;

export function parseInteractionSettlementForRequest(
  requestInput: unknown,
  settlementInput: unknown
): InteractionSettlement {
  const request = historicalInteractionRequestSchema.parse(requestInput);
  const settlement = interactionSettlementSchema.parse(settlementInput);
  assertInteractionIdentityMatches(request, settlement);
  if (settlement.type !== settlementTypeByRequestType[request.type]) {
    throw new Error("interaction_response_type_mismatch");
  }
  if (request.type === "interaction.permission_requested") {
    return parseExactPermissionSettlementForRequest(request, settlement);
  }
  return settlement;
}

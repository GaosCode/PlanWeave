import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";
import { acpRecoveryIdentitySchema, dispatchLifecycleIdentitySchema } from "./lifecycle.js";
import {
  acpPermissionOptionsSchema,
  exactPermissionSelectionSchema,
  selectedAcpPermissionOptionId
} from "./acpPermissionOptions.js";

export const INTERACTION_TEXT_MAX_LENGTH = 16_384 as const;
export const interactionActionIdSchema = opaqueIdentifierSchema.brand("InteractionActionId");
export const interactionIdentitySchema = dispatchLifecycleIdentitySchema.extend({
  actionId: interactionActionIdSchema,
  acpSessionId: acpRecoveryIdentitySchema.shape.acpSessionId
});

export const legacyPermissionRequestSchema = interactionIdentitySchema.extend({
  expiresAt: z.string().datetime(),
  type: z.literal("interaction.permission_requested"),
  title: z.string().min(1).max(512),
  description: z.string().max(INTERACTION_TEXT_MAX_LENGTH)
});

export const exactPermissionRequestSchema = legacyPermissionRequestSchema.extend({
  options: acpPermissionOptionsSchema
});

export const legacyPermissionSettlementSchema = interactionIdentitySchema.extend({
  type: z.literal("interaction.permission_response"),
  decision: z.enum(["allow_once", "deny"])
});

export const exactPermissionSettlementSchema = z.discriminatedUnion("decision", [
  interactionIdentitySchema.extend({
    type: z.literal("interaction.permission_response"),
    ...exactPermissionSelectionSchema.options[0].shape
  }),
  interactionIdentitySchema.extend({
    type: z.literal("interaction.permission_response"),
    ...exactPermissionSelectionSchema.options[1].shape
  })
]);

export const historicalPermissionRequestSchema = z.union([
  exactPermissionRequestSchema,
  legacyPermissionRequestSchema
]);
export const historicalPermissionSettlementSchema = z.union([
  exactPermissionSettlementSchema,
  legacyPermissionSettlementSchema
]);
export type ExactPermissionRequest = z.infer<typeof exactPermissionRequestSchema>;
export type ExactPermissionSettlement = z.infer<typeof exactPermissionSettlementSchema>;
export type HistoricalPermissionRequest = z.infer<typeof historicalPermissionRequestSchema>;
export type HistoricalPermissionSettlement = z.infer<typeof historicalPermissionSettlementSchema>;

/** Compatibility is derived separately so historical payloads and fingerprints stay unchanged. */
export function permissionRequestCompatibility(
  requestInput: unknown
): "exact" | "legacy_missing_options" {
  const request = historicalPermissionRequestSchema.parse(requestInput);
  return "options" in request ? "exact" : "legacy_missing_options";
}

export function assertInteractionIdentityMatches(
  request: z.infer<typeof interactionIdentitySchema>,
  settlement: z.infer<typeof interactionIdentitySchema>
): void {
  if (
    request.dispatchId !== settlement.dispatchId ||
    request.leaseId !== settlement.leaseId ||
    request.executionAttemptId !== settlement.executionAttemptId ||
    request.actionId !== settlement.actionId ||
    request.acpSessionId !== settlement.acpSessionId
  ) {
    throw new Error("interaction_identity_mismatch");
  }
}

export function parseExactPermissionSettlementForRequest(
  requestInput: unknown,
  settlementInput: unknown
): ExactPermissionSettlement {
  const request = historicalPermissionRequestSchema.parse(requestInput);
  if (!("options" in request))
    throw new Error("legacy_permission_request_requires_execution_cancel");
  const settlement = exactPermissionSettlementSchema.parse(settlementInput);
  assertInteractionIdentityMatches(request, settlement);
  selectedAcpPermissionOptionId(
    request.options,
    settlement.decision === "deny"
      ? { decision: settlement.decision }
      : { decision: settlement.decision, optionId: settlement.optionId }
  );
  return settlement;
}

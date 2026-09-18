import { z } from "zod";
import {
  legacyPermissionRequestSchema,
  legacyPermissionSettlementSchema
} from "./acpPermissionInteractions.js";
import {
  mailboxDeliveredSequenceSchema,
  mailboxMessageIdSchema,
  mailboxSequenceSchema
} from "./mailboxIdentity.js";
import { agentHostProtocolVersionSchema } from "./version.js";

export const HISTORICAL_PERMISSION_REPLAY_VERSION_HEADER =
  "x-planweave-historical-permission-replay-version";
export const historicalPermissionReplayVersionSchema = z.literal(1);

export function negotiateHistoricalPermissionReplayVersion(value: unknown): 1 | undefined {
  if (value === undefined) return undefined;
  if (value !== "1") throw new Error("historical_permission_replay_unsupported");
  return 1;
}

export const historicalPermissionHostEventSchema = legacyPermissionRequestSchema.extend({
  protocolVersion: agentHostProtocolVersionSchema,
  messageId: mailboxMessageIdSchema
});
export const historicalPermissionMailboxCommandSchema = legacyPermissionSettlementSchema.extend({
  decision: z.literal("allow_once")
});

function historicalJson(schema: z.ZodType) {
  return z
    .string()
    .max(256 * 1024)
    .superRefine((value, context) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid historical JSON." });
        return;
      }
      if (!schema.safeParse(parsed).success) {
        context.addIssue({ code: "custom", message: "Invalid historical permission record." });
      }
    });
}

/** Authenticated history intake only; this envelope cannot authorize a permission. */
export const historicalPermissionHostReplaySchema = z
  .object({
    type: z.literal("host.permission_history"),
    protocolVersion: agentHostProtocolVersionSchema,
    eventJson: historicalJson(historicalPermissionHostEventSchema)
  })
  .strict();

/** Reject the old decision and stop only its matching execution; never select an option. */
export const historicalPermissionMailboxReplaySchema = z
  .object({
    type: z.literal("mailbox.permission_history"),
    protocolVersion: agentHostProtocolVersionSchema,
    sequence: mailboxDeliveredSequenceSchema,
    previousSequence: mailboxSequenceSchema,
    messageId: mailboxMessageIdSchema,
    commandJson: historicalJson(historicalPermissionMailboxCommandSchema)
  })
  .strict();

export function parseHistoricalPermissionEventJson(raw: string) {
  return historicalPermissionHostEventSchema.parse(JSON.parse(raw));
}

export function parseHistoricalPermissionCommandJson(raw: string) {
  return historicalPermissionMailboxCommandSchema.parse(JSON.parse(raw));
}

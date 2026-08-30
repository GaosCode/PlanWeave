import {
  interactionRequestSchema,
  interactionSettlementSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { timestampSchema } from "./primitives.js";

export const remoteInteractionViewSchema = z
  .object({
    request: interactionRequestSchema,
    operationId: opaqueIdentifierSchema,
    hostId: opaqueIdentifierSchema,
    status: z.enum(["pending", "settled", "expired"]),
    createdAt: timestampSchema,
    settlement: interactionSettlementSchema.optional(),
    settledBy: opaqueIdentifierSchema.optional(),
    settledAt: timestampSchema.optional()
  })
  .strict();
export type RemoteInteractionView = z.infer<typeof remoteInteractionViewSchema>;

export const remoteInteractionPageSchema = z
  .object({
    items: z.array(remoteInteractionViewSchema).max(100),
    nextCursor: z.number().int().positive().nullable()
  })
  .strict();
export type RemoteInteractionPage = z.infer<typeof remoteInteractionPageSchema>;

export const remoteInteractionPageQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type RemoteInteractionPageQuery = z.infer<typeof remoteInteractionPageQuerySchema>;

export const remoteInteractionResponseSchema = interactionSettlementSchema;
export type RemoteInteractionResponse = z.infer<typeof remoteInteractionResponseSchema>;

import { z } from "zod";
import {
  agentRunControlActionSchema,
  agentRunControlCommandIdSchema,
  agentRunControlErrorCodeSchema,
  agentRunControlReceiptResultSchema
} from "../../autoRun/agentRunControlContract.js";

export const desktopAgentRunControlInputSchema = z
  .object({
    ref: z
      .object({
        projectRoot: z.string().min(1).max(4096),
        canvasId: z.string().min(1).max(256).nullable().optional()
      })
      .strict(),
    recordId: z.string().min(1).max(1024),
    action: agentRunControlActionSchema
  })
  .strict();

export const desktopAgentRunControlSuccessSchema = z
  .object({
    ok: z.literal(true),
    commandId: agentRunControlCommandIdSchema,
    acceptedAt: z.string().datetime(),
    result: agentRunControlReceiptResultSchema
  })
  .strict();

export const desktopAgentRunControlErrorSchema = z
  .object({
    ok: z.literal(false),
    commandId: agentRunControlCommandIdSchema.nullable(),
    code: agentRunControlErrorCodeSchema,
    message: z.string().min(1).max(4096)
  })
  .strict();

export const desktopAgentRunControlResponseSchema = z.union([
  desktopAgentRunControlSuccessSchema,
  desktopAgentRunControlErrorSchema
]);

export type DesktopAgentRunControlInput = z.infer<typeof desktopAgentRunControlInputSchema>;
export type DesktopAgentRunControlResponse = z.infer<typeof desktopAgentRunControlResponseSchema>;

import { z } from "zod";
import {
  acpConversationActionSchema,
  acpConversationPageSchema
} from "@planweave-ai/agent-host-protocol/browser";
import { workspaceCanvasLocatorSchema } from "./canvasLocator.js";
import { desktopOwnerCanvasExecutionLocatorSchema } from "./workspaceExecution.js";

export const desktopRemoteAcpConversationInputSchema = z
  .object({
    locator: z.union([workspaceCanvasLocatorSchema, desktopOwnerCanvasExecutionLocatorSchema]),
    operationId: z.string().min(1).max(256),
    blockRef: z.string().min(3).max(512),
    afterCursor: z.number().int().nonnegative().safe().default(0),
    action: acpConversationActionSchema.optional()
  })
  .strict();
export type DesktopRemoteAcpConversationInput = z.input<
  typeof desktopRemoteAcpConversationInputSchema
>;
export const desktopRemoteAcpConversationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: acpConversationPageSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(256) }).strict()
]);

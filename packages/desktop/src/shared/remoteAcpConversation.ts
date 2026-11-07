import {
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteOperationStateSchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import { z } from "zod";
import {
  acpConversationActionSchema,
  acpConversationHttpBodyBytes,
  REMOTE_CONTROL_HTTP_BODY_MAX_BYTES,
  acpConversationOrderedPageSchema
} from "@planweave-ai/agent-host-protocol/browser";
import { workspaceCanvasLocatorSchema } from "./canvasLocator.js";
import { desktopOwnerCanvasExecutionLocatorSchema } from "./workspaceExecution.js";

const remoteCancelCommandSchema = remoteHumanExecutionActionCommandSchema.transform(
  (command, context) => {
    if (command.kind === "cancel") return command;
    context.addIssue({ code: "custom", message: "Expected a remote cancellation command." });
    return z.NEVER;
  }
);

export const desktopRemoteAcpConversationInputSchema = z
  .object({
    locator: z.union([workspaceCanvasLocatorSchema, desktopOwnerCanvasExecutionLocatorSchema]),
    operationId: z.string().min(1).max(256),
    blockRef: z.string().min(3).max(512),
    afterCursor: z.number().int().nonnegative().safe().default(0),
    afterTurnId: z.string().min(1).max(256).nullable().optional(),
    action: z
      .union([
        acpConversationActionSchema,
        z
          .object({ kind: z.literal("execution_cancel"), command: remoteCancelCommandSchema })
          .strict(),
        z
          .object({
            kind: z.literal("execution_respond"),
            response: remoteInteractionResponseSchema
          })
          .strict()
      ])
      .optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.action?.kind === "prompt" &&
      acpConversationHttpBodyBytes(input.action) > REMOTE_CONTROL_HTTP_BODY_MAX_BYTES
    )
      context.addIssue({
        code: "custom",
        path: ["action", "text"],
        message: "acp_conversation_http_body_too_large"
      });
  });
export type DesktopRemoteAcpConversationInput = z.input<
  typeof desktopRemoteAcpConversationInputSchema
>;
export const desktopRemoteAcpConversationPageSchema = acpConversationOrderedPageSchema
  .extend({
    execution: z
      .object({
        state: remoteOperationStateSchema,
        cancel: remoteCancelCommandSchema.nullable(),
        interactions: z.array(remoteInteractionViewSchema)
      })
      .strict()
  })
  .strict();
export type DesktopRemoteAcpConversationPage = z.infer<
  typeof desktopRemoteAcpConversationPageSchema
>;
export const desktopRemoteAcpConversationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: desktopRemoteAcpConversationPageSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(256) }).strict()
]);

export type DesktopRemoteAcpConversationResult = z.infer<
  typeof desktopRemoteAcpConversationResultSchema
>;

export class RemoteAcpConversationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RemoteAcpConversationError";
  }
}

import { remoteAcpConversation } from "./remoteAcpConversation.js";
import { desktopRemoteAcpConversationResultSchema } from "../shared/remoteAcpConversation.js";
import { ipcMain } from "electron";
import {
  desktopWorkspaceExecutionCancelInputSchema,
  desktopWorkspaceExecutionFollowInputSchema,
  desktopWorkspaceExecutionResponseSchema,
  desktopWorkspaceExecutionRespondInputSchema,
  desktopWorkspaceExecutionStartInputSchema
} from "../shared/workspaceExecution.js";
import { workspaceExecutionInvokeChannels } from "../shared/workspaceExecutionIpc.js";
import type { CollaborationService } from "./collaboration/collaborationService.js";
import { getOperatorControlService } from "./operatorControl/operatorControlHandlers.js";
import { WorkspaceExecutionDesktopService } from "./workspaceExecutionDesktopService.js";
import { workspaceExecutionHandlerResult } from "./workspaceExecutionIpcResult.js";

export function registerWorkspaceExecutionHandlers(input: {
  collaboration: CollaborationService;
  service?: WorkspaceExecutionDesktopService;
}): WorkspaceExecutionDesktopService {
  const service =
    input.service ??
    new WorkspaceExecutionDesktopService(input.collaboration, getOperatorControlService());
  ipcMain.handle(workspaceExecutionInvokeChannels.conversation, async (_event, rawInput) => {
    try {
      return desktopRemoteAcpConversationResultSchema.parse({
        ok: true,
        value: await remoteAcpConversation(
          rawInput,
          input.collaboration,
          getOperatorControlService()
        )
      });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : error instanceof Error
            ? error.message
            : null;
      return desktopRemoteAcpConversationResultSchema.parse({
        ok: false,
        error:
          typeof code === "string" && /^[a-z][a-z0-9_]{1,255}$/.test(code)
            ? code
            : "acp_conversation_request_failed"
      });
    }
  });
  ipcMain.handle(workspaceExecutionInvokeChannels.start, async (_event, rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.start(desktopWorkspaceExecutionStartInputSchema.parse(rawInput))
      )
    )
  );
  ipcMain.handle(workspaceExecutionInvokeChannels.follow, async (_event, rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.follow(desktopWorkspaceExecutionFollowInputSchema.parse(rawInput))
      )
    )
  );
  ipcMain.handle(workspaceExecutionInvokeChannels.cancel, async (_event, rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.cancel(desktopWorkspaceExecutionCancelInputSchema.parse(rawInput))
      )
    )
  );
  ipcMain.handle(workspaceExecutionInvokeChannels.respond, async (_event, rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.respond(desktopWorkspaceExecutionRespondInputSchema.parse(rawInput))
      )
    )
  );
  return service;
}

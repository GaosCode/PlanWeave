import { remoteAcpConversation } from "./remoteAcpConversation.js";
import { desktopRemoteAcpConversationResultSchema } from "../shared/remoteAcpConversation.js";
import { ipcMain } from "electron";
import {
  desktopWorkspaceExecutionCancelInputSchema,
  desktopWorkspaceExecutionCancellationRecoveryInputSchema,
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
import { assertDesktopInspectorHomeCurrent } from "./desktopInspectorHome.js";

function handleWorkspaceExecution<T>(
  channel: string,
  operation: (input: unknown) => Promise<T>
): void {
  ipcMain.handle(channel, (event, rawInput: unknown) => {
    assertDesktopInspectorHomeCurrent(event.sender);
    return operation(rawInput);
  });
}

export function registerWorkspaceExecutionHandlers(input: {
  collaboration: CollaborationService;
  service?: WorkspaceExecutionDesktopService;
}): WorkspaceExecutionDesktopService {
  const service =
    input.service ??
    new WorkspaceExecutionDesktopService(input.collaboration, getOperatorControlService());
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.conversation, async (rawInput) => {
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
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.recoverCancellation, async (rawInput) =>
    workspaceExecutionHandlerResult(() =>
      service.recoverCancellations(
        desktopWorkspaceExecutionCancellationRecoveryInputSchema.parse(rawInput)
      )
    )
  );
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.start, async (rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.start(desktopWorkspaceExecutionStartInputSchema.parse(rawInput))
      )
    )
  );
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.follow, async (rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.follow(desktopWorkspaceExecutionFollowInputSchema.parse(rawInput))
      )
    )
  );
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.cancel, async (rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.cancel(desktopWorkspaceExecutionCancelInputSchema.parse(rawInput))
      )
    )
  );
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.respond, async (rawInput) =>
    workspaceExecutionHandlerResult(async () =>
      desktopWorkspaceExecutionResponseSchema.parse(
        await service.respond(desktopWorkspaceExecutionRespondInputSchema.parse(rawInput))
      )
    )
  );
  return service;
}

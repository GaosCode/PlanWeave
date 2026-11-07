import { remoteAcpConversation } from "./remoteAcpConversation.js";
import { remoteAcpConversationResult } from "./remoteAcpConversationResult.js";
import { ipcMain } from "electron";
import {
  desktopWorkspaceExecutionCancelInputSchema,
  desktopWorkspaceExecutionStartCancellationInputSchema,
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
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.conversation, (rawInput) =>
    remoteAcpConversationResult(() =>
      remoteAcpConversation(rawInput, input.collaboration, getOperatorControlService())
    )
  );
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.recoverCancellation, async (rawInput) =>
    workspaceExecutionHandlerResult(() =>
      service.recoverCancellations(
        desktopWorkspaceExecutionCancellationRecoveryInputSchema.parse(rawInput)
      )
    )
  );
  handleWorkspaceExecution(workspaceExecutionInvokeChannels.cancelStart, async (rawInput) =>
    workspaceExecutionHandlerResult(() =>
      service.cancelStart(desktopWorkspaceExecutionStartCancellationInputSchema.parse(rawInput))
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

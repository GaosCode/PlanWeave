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
import { WorkspaceExecutionDesktopService } from "./workspaceExecutionDesktopService.js";
import { workspaceExecutionHandlerResult } from "./workspaceExecutionIpcResult.js";

export function registerWorkspaceExecutionHandlers(input: {
  collaboration: CollaborationService;
  service?: WorkspaceExecutionDesktopService;
}): WorkspaceExecutionDesktopService {
  const service = input.service ?? new WorkspaceExecutionDesktopService(input.collaboration);
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

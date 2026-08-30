import type { PlanWeaveWorkspaceExecutionApi } from "../shared/workspaceExecution.js";
import {
  desktopWorkspaceExecutionCancelInputSchema,
  desktopWorkspaceExecutionFollowInputSchema,
  desktopWorkspaceExecutionRespondInputSchema,
  desktopWorkspaceExecutionStartInputSchema
} from "../shared/workspaceExecution.js";
import {
  workspaceExecutionInvokeChannels,
  workspaceExecutionIpcResultSchema
} from "../shared/workspaceExecutionIpc.js";

type Invoke = (channel: string, input: unknown) => Promise<unknown>;

async function invokeWorkspaceExecution(invoke: Invoke, channel: string, input: unknown) {
  const result = workspaceExecutionIpcResultSchema.parse(await invoke(channel, input));
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

export function createWorkspaceExecutionPreloadApi(invoke: Invoke): PlanWeaveWorkspaceExecutionApi {
  return {
    startWorkspaceExecution: (input) =>
      invokeWorkspaceExecution(
        invoke,
        workspaceExecutionInvokeChannels.start,
        desktopWorkspaceExecutionStartInputSchema.parse(input)
      ),
    followWorkspaceExecution: (input) =>
      invokeWorkspaceExecution(
        invoke,
        workspaceExecutionInvokeChannels.follow,
        desktopWorkspaceExecutionFollowInputSchema.parse(input)
      ),
    respondWorkspaceExecution: (input) =>
      invokeWorkspaceExecution(
        invoke,
        workspaceExecutionInvokeChannels.respond,
        desktopWorkspaceExecutionRespondInputSchema.parse(input)
      ),
    cancelWorkspaceExecution: (input) =>
      invokeWorkspaceExecution(
        invoke,
        workspaceExecutionInvokeChannels.cancel,
        desktopWorkspaceExecutionCancelInputSchema.parse(input)
      )
  };
}

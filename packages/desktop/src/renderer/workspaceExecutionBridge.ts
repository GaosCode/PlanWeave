import type {
  PlanWeaveWorkspaceExecutionApi,
  PlanWeaveWorkspaceExecutionPreloadApi
} from "../shared/workspaceExecution";
import {
  desktopRemoteAcpConversationResultSchema,
  RemoteAcpConversationError
} from "../shared/remoteAcpConversation";

export function createWorkspaceExecutionRendererApi(
  api: PlanWeaveWorkspaceExecutionPreloadApi
): PlanWeaveWorkspaceExecutionApi {
  return {
    ...api,
    remoteAcpConversation: async (input) => {
      const result = desktopRemoteAcpConversationResultSchema.parse(
        await api.remoteAcpConversation(input)
      );
      if (!result.ok) throw new RemoteAcpConversationError(result.error);
      return result.value;
    }
  };
}

import type { CollaborationService } from "./collaboration/collaborationService.js";
import type { OperatorControlService } from "./operatorControl/operatorControlService.js";
import { desktopRemoteAcpConversationInputSchema } from "../shared/remoteAcpConversation.js";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";

export async function remoteAcpConversation(
  raw: unknown,
  collaboration: CollaborationService,
  operator: OperatorControlService
) {
  const input = desktopRemoteAcpConversationInputSchema.parse(raw);
  const locator = input.locator;
  const assertScope = (operation: RemoteOperationObservation) => {
    if (
      operation.projectId !== locator.projectId ||
      operation.canvasId !== locator.canvasId ||
      operation.blockRef !== input.blockRef
    ) {
      throw new Error("acp_conversation_scope_mismatch");
    }
  };
  if (locator.kind === "workspace") {
    return collaboration.withWorkspaceExecutionClient(locator, async (client) => {
      const remote = client.remoteOperations();
      assertScope(await remote.observeRemoteOperation(input.operationId));
      return remote.acpConversation(input.operationId, input.afterCursor, input.action);
    });
  }
  return operator.withExecutionProfile(locator.operatorProfileId, async (client) => {
    assertScope(await client.observeRemoteOperation(input.operationId, locator.humanPrincipalId));
    return client.acpConversation(
      input.operationId,
      input.afterCursor,
      locator.humanPrincipalId,
      input.action
    );
  });
}

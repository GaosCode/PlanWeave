import type { RemoteAgentAccessPolicy } from "./remoteAgent/accessPolicy.js";
import { retryTarget } from "./remoteAgent/dispatchTarget.js";
import { RemoteAgentAuthorizationError } from "./remoteAgent/errors.js";
import type { RemoteOperation } from "./remoteOperations.js";
import { AcpConversationError } from "./acpConversationService.js";

/** Continuing a session does not redispatch its Block or acquire a new writeback authority. */
export function authorizeAcpConversation(
  operation: RemoteOperation,
  humanPrincipalId: string,
  policy: Pick<RemoteAgentAccessPolicy, "evaluateAccess">
): void {
  const snapshot = operation.agentAccess;
  if (!snapshot) {
    throw new RemoteAgentAuthorizationError("remote_agent_access_snapshot_missing");
  }
  const original = snapshot.authorized.remoteAgent;
  const target = retryTarget(operation, snapshot.authorized);
  if (
    (target.kind === "workspace_canvas" && target.workspaceId !== operation.workspaceId) ||
    operation.attempt.hostId !== original.hostId ||
    (operation.endpointSelection &&
      (operation.endpointSelection.endpointId !== original.endpointId ||
        operation.endpointSelection.hostId !== original.hostId ||
        operation.endpointSelection.profileId !== original.profileId ||
        operation.endpointSelection.agentId !== original.agentId))
  ) {
    throw new AcpConversationError("acp_conversation_identity_mismatch");
  }
  const { agent } = policy.evaluateAccess({
    principal: { humanPrincipalId },
    endpointId: original.endpointId,
    target
  });
  if (
    agent.endpointId !== original.endpointId ||
    agent.hostId !== original.hostId ||
    agent.profileId !== original.profileId ||
    agent.agentId !== original.agentId
  ) {
    throw new AcpConversationError("acp_conversation_identity_mismatch");
  }
}

import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import type { AgentEndpointCatalog } from "../agentEndpointCatalog.js";
import { RemoteAgentAuthorizationError } from "./errors.js";
import type { RemoteAgentAccessPolicy } from "./accessPolicy.js";
import type { RemoteAgentUseTarget } from "./schema.js";

export type ListAuthorizedRemoteAgentEndpointsInput = {
  policy: RemoteAgentAccessPolicy;
  catalog: AgentEndpointCatalog;
  principal: { humanPrincipalId: string };
  target: RemoteAgentUseTarget;
};

/**
 * Execution-selector listing: target-scoped availability filtered by the same
 * access rules as dispatch. Access denials are omitted; offline/capacity/profile
 * and workspace-mapping unavailability stay visible.
 */
export function listAuthorizedRemoteAgentEndpoints(
  input: ListAuthorizedRemoteAgentEndpointsInput
): RemoteAgentEndpointList {
  const listed =
    input.target.kind === "owner_canvas"
      ? input.catalog.listVisibleFleet()
      : input.catalog.listVisible(input.target.workspaceId);
  const items = listed.items.filter((endpoint) => {
    try {
      input.policy.evaluateAccess({
        principal: input.principal,
        endpointId: endpoint.endpointId,
        target: input.target
      });
      return true;
    } catch (error) {
      if (error instanceof RemoteAgentAuthorizationError) return false;
      throw error;
    }
  });
  return remoteAgentEndpointListSchema.parse({
    schemaVersion: "agent-endpoint-list/v1",
    items
  });
}

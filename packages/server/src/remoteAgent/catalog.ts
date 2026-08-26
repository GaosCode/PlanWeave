import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import type { AgentEndpointCatalog } from "../agentEndpointCatalog.js";
import { deriveEndpointAvailabilityPolicy } from "./dispatchTarget.js";
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
 * unavailability stay visible. Unrestricted owners overlay owner-workspace
 * capacity on a workspace canvas via deriveEndpointAvailabilityPolicy.
 * Workspace mapping is not an Agent grant or execution-catalog filter.
 */
export function listAuthorizedRemoteAgentEndpoints(
  input: ListAuthorizedRemoteAgentEndpointsInput
): RemoteAgentEndpointList {
  const listed =
    input.target.kind === "owner_canvas"
      ? input.catalog.listProjected({ kind: "owner_fleet" })
      : input.catalog.listVisible(input.target.workspaceId);
  const ownerWorkspaceById =
    input.target.kind === "workspace_canvas"
      ? new Map(
          input.catalog
            .listProjected({ kind: "owner_workspace" })
            .items.map((endpoint) => [endpoint.endpointId, endpoint])
        )
      : undefined;
  const items = listed.items.flatMap((endpoint) => {
    try {
      const access = input.policy.evaluateAccess({
        principal: input.principal,
        endpointId: endpoint.endpointId,
        target: input.target
      });
      const availability = deriveEndpointAvailabilityPolicy({
        accessMode: access.agent.accessMode,
        agentAccessAuthority: access.agentAccessAuthority,
        target: input.target
      });
      const listedEndpoint =
        availability.kind === "owner_workspace"
          ? (ownerWorkspaceById?.get(endpoint.endpointId) ?? endpoint)
          : endpoint;
      return [listedEndpoint];
    } catch (error) {
      if (error instanceof RemoteAgentAuthorizationError) return [];
      throw error;
    }
  });
  return remoteAgentEndpointListSchema.parse({
    schemaVersion: "agent-endpoint-list/v1",
    items
  });
}

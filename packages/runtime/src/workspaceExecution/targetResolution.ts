import type { RemoteAgentEndpointList } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  workspaceExecutionRequestSchema,
  workspaceExecutionTargetSchema,
  type WorkspaceExecutionRequest,
  type WorkspaceExecutionTarget
} from "./contracts.js";
import { WorkspaceExecutionError } from "./errors.js";

export function resolveWorkspaceExecutionTarget(
  requestInput: WorkspaceExecutionRequest,
  catalog?: RemoteAgentEndpointList
): WorkspaceExecutionTarget {
  const request = workspaceExecutionRequestSchema.parse(requestInput);
  if (request.target.policy === "local") {
    return workspaceExecutionTargetSchema.parse({ target: "local" });
  }
  if (!catalog || !request.effectiveExecutor) {
    throw new WorkspaceExecutionError("agent_endpoint_unavailable");
  }
  const selectedId = request.target.agentEndpointId;
  if (selectedId) {
    const endpoint = catalog.items.find((item) => item.endpointId === selectedId);
    if (!endpoint || endpoint.status !== "available") {
      throw new WorkspaceExecutionError("agent_endpoint_unavailable");
    }
    if (endpoint.agentId !== request.effectiveExecutor.agentId) {
      throw new WorkspaceExecutionError("agent_endpoint_executor_mismatch");
    }
    return workspaceExecutionTargetSchema.parse({
      target: "remote",
      agentEndpointId: endpoint.endpointId,
      agentProfileId: endpoint.profileId,
      agentId: endpoint.agentId
    });
  }
  const compatible = catalog.items.filter(
    (item) => item.status === "available" && item.agentId === request.effectiveExecutor?.agentId
  );
  if (compatible.length === 0) {
    throw new WorkspaceExecutionError("agent_endpoint_unavailable");
  }
  if (compatible.length > 1) {
    throw new WorkspaceExecutionError("agent_endpoint_selection_required");
  }
  const endpoint = compatible[0];
  if (!endpoint) {
    throw new WorkspaceExecutionError("agent_endpoint_unavailable");
  }
  return workspaceExecutionTargetSchema.parse({
    target: "remote",
    agentEndpointId: endpoint.endpointId,
    agentProfileId: endpoint.profileId,
    agentId: endpoint.agentId
  });
}

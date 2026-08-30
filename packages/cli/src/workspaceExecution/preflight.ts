import type { WorkspaceExecutionRequest } from "@planweave-ai/runtime";
import { WorkspaceExecutionCliError } from "./errors.js";

export type CliExecutionTargetPolicy = "local" | "remote" | "auto";

export interface LocalExecutionAvailabilityPort {
  probe(signal?: AbortSignal): Promise<{ status: "available" | "unavailable" }>;
}

export async function resolveCliExecutionTarget(input: {
  policy: CliExecutionTargetPolicy;
  agentEndpointId?: string;
  selectedAgentEndpointId?: string;
  local: LocalExecutionAvailabilityPort;
  signal?: AbortSignal;
}): Promise<WorkspaceExecutionRequest["target"]> {
  if (input.policy === "local") {
    if (input.agentEndpointId || input.selectedAgentEndpointId) {
      throw new WorkspaceExecutionCliError("workspace_execution_usage_invalid", 2);
    }
    return { policy: "local" };
  }
  const endpoint = input.agentEndpointId ?? input.selectedAgentEndpointId;
  if (input.policy === "remote" || endpoint) {
    return { policy: "remote", ...(endpoint ? { agentEndpointId: endpoint } : {}) };
  }
  let availability: Awaited<ReturnType<LocalExecutionAvailabilityPort["probe"]>>;
  try {
    availability = await input.local.probe(input.signal);
  } catch (error) {
    throw new WorkspaceExecutionCliError("local_execution_probe_failed", 9, false, {
      cause: error
    });
  }
  return availability.status === "available" ? { policy: "local" } : { policy: "remote" };
}

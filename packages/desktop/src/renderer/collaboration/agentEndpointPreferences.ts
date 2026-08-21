import type { DesktopAgentEndpointPreference } from "../../shared/desktopSettings";
import { canonicalBuiltinExecutorName } from "@planweave-ai/runtime/browser";
import type { AvailableAgentEndpoint } from "./agentEndpointViewModel";

export type AgentEndpointPreferenceScope =
  | { kind: "task"; taskId: string }
  | { kind: "block"; blockRef: string };

export type EndpointSelection =
  | { kind: "endpoint"; id: string }
  | { kind: "default_local"; id: string }
  | { kind: "mismatch"; detail: string };

export function agentEndpointPreferenceKey(input: {
  projectRoot: string;
  canvasId: string;
  scope: AgentEndpointPreferenceScope;
}): string {
  const scopeId = input.scope.kind === "task" ? input.scope.taskId : input.scope.blockRef;
  return JSON.stringify([input.projectRoot, input.canvasId, input.scope.kind, scopeId]);
}

export function remoteAgentEndpointPreferenceKey(input: {
  workspaceId: string;
  projectId: string;
  canvasId: string;
  scope: AgentEndpointPreferenceScope;
}): string {
  const scopeId = input.scope.kind === "task" ? input.scope.taskId : input.scope.blockRef;
  return JSON.stringify([
    "remote",
    input.workspaceId,
    input.projectId,
    input.canvasId,
    input.scope.kind,
    scopeId
  ]);
}

/** UI/select display id. Mismatch never silently becomes local:. */
export function agentEndpointSelectionId(selection: EndpointSelection): string {
  if (selection.kind === "mismatch") {
    return `mismatch:${selection.detail}`;
  }
  return selection.id;
}

function findRemoteEndpoint(
  endpoints: readonly AvailableAgentEndpoint[],
  remoteEndpointId: string
): AvailableAgentEndpoint | undefined {
  return endpoints.find(
    (endpoint) =>
      endpoint.source === "remote" &&
      (endpoint.remoteEndpointId === remoteEndpointId ||
        endpoint.id === `remote:${remoteEndpointId}`)
  );
}

/**
 * Resolve the effective Agent Endpoint selection for a block/task.
 * Mismatch is based on live endpoint facts vs manifest executor — never on a stored executorName snapshot.
 */
export function selectedAgentEndpointId(input: {
  executorName: string;
  preference: DesktopAgentEndpointPreference | undefined;
  endpoints: readonly AvailableAgentEndpoint[];
}): EndpointSelection {
  const executorName = canonicalBuiltinExecutorName(input.executorName);
  if (!input.preference) {
    return { kind: "default_local", id: `local:${executorName}` };
  }

  if (input.preference.kind === "local") {
    const preferredExecutorName = canonicalBuiltinExecutorName(input.preference.executorName);
    if (preferredExecutorName !== executorName) {
      return {
        kind: "mismatch",
        detail: `${preferredExecutorName}->${executorName}`
      };
    }
    return { kind: "endpoint", id: `local:${preferredExecutorName}` };
  }

  const endpoint = findRemoteEndpoint(input.endpoints, input.preference.remoteEndpointId);
  if (!endpoint) {
    return {
      kind: "mismatch",
      detail: `agent_endpoint_unknown:${input.preference.remoteEndpointId}`
    };
  }
  if (canonicalBuiltinExecutorName(endpoint.executorName) !== executorName) {
    return {
      kind: "mismatch",
      detail: `${canonicalBuiltinExecutorName(endpoint.executorName)}->${executorName}`
    };
  }
  return { kind: "endpoint", id: endpoint.id };
}

export function updateAgentEndpointPreferences(input: {
  current: Record<string, DesktopAgentEndpointPreference>;
  key: string;
  endpoint: AvailableAgentEndpoint;
}): Record<string, DesktopAgentEndpointPreference> {
  const next = { ...input.current };
  if (input.endpoint.source === "remote" && input.endpoint.remoteEndpointId) {
    next[input.key] = {
      kind: "remote",
      remoteEndpointId: input.endpoint.remoteEndpointId
    };
  } else {
    next[input.key] = {
      kind: "local",
      executorName: input.endpoint.executorName
    };
  }
  return next;
}

export function clearAgentEndpointPreference(
  current: Record<string, DesktopAgentEndpointPreference>,
  key: string
): Record<string, DesktopAgentEndpointPreference> {
  const next = { ...current };
  delete next[key];
  return next;
}

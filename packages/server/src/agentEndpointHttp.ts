import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  agentEndpointErrorResponseSchema,
  remoteAgentEndpointListSchema,
  type AgentEndpointErrorCode
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  authenticateCollaborationForScope,
  hasAuthenticatedCollaborationDevice,
  humanTransportAllowed,
  parseHumanDeviceBearer,
  workspaceDeviceSessionHumanContext,
  type HumanIdentityRepository,
  type CollaborationScopeAuthority
} from "./identity/index.js";
import { authorizeHumanAction } from "./identity/policy.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import type { AgentEndpointCatalog } from "./agentEndpointCatalog.js";

export type AgentEndpointHttpOptions = {
  catalog: AgentEndpointCatalog;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  transportAdmission: TransportAdmissionPolicy;
};

function projectIdFromRoute(request: IncomingMessage, pathname: string): string | undefined {
  if (request.method !== "GET") return undefined;
  const match = /^\/api\/v1\/projects\/([^/]+)\/agent-endpoints$/.exec(pathname);
  if (!match) return undefined;
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

function respondError(
  response: ServerResponse,
  status: number,
  code: AgentEndpointErrorCode
): void {
  respond(response, status, agentEndpointErrorResponseSchema.parse({ error: code }));
}

export async function handleAgentEndpointHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AgentEndpointHttpOptions
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  const projectId = projectIdFromRoute(request, url.pathname);
  if (!projectId) return false;
  if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
    request.resume();
    respondError(response, 403, "agent_endpoint_forbidden");
    return true;
  }
  if ([...url.searchParams.keys()].length > 0) {
    request.resume();
    respondError(response, 400, "agent_endpoint_request_invalid");
    return true;
  }
  const scope = authenticateCollaborationForScope(
    options.repository,
    options.workspaceIdentity,
    options.collaborationScopeAuthority,
    request.headers.authorization,
    projectId
  );
  if (!scope) {
    const deviceToken = parseHumanDeviceBearer(request.headers.authorization);
    const authenticated =
      hasAuthenticatedCollaborationDevice(
        options.repository,
        options.workspaceIdentity,
        request.headers.authorization
      ) ||
      (deviceToken !== undefined &&
        options.workspaceIdentity.hasCurrentWorkspaceDeviceCredential(deviceToken));
    request.resume();
    respondError(
      response,
      authenticated ? 403 : 401,
      authenticated ? "agent_endpoint_forbidden" : "agent_endpoint_unauthenticated"
    );
    return true;
  }
  const human = workspaceDeviceSessionHumanContext(scope.actor, options.workspaceIdentity);
  const decision = human
    ? authorizeHumanAction({
        action: "remote_run_control",
        subject: { kind: "human", context: human },
        facts: { targetProjectId: projectId }
      })
    : { allowed: false as const };
  if (!decision.allowed) {
    request.resume();
    respondError(response, 403, "agent_endpoint_forbidden");
    return true;
  }
  try {
    const body = remoteAgentEndpointListSchema.parse(
      options.catalog.listVisible(scope.workspaceId)
    );
    request.resume();
    respond(response, 200, body);
  } catch {
    request.resume();
    respondError(response, 500, "agent_endpoint_request_failed");
  }
  return true;
}

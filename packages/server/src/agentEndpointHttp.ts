import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  agentEndpointErrorResponseSchema,
  remoteAgentEndpointListSchema,
  type AgentEndpointErrorCode
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  humanPrincipalIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
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
import type { RemoteAgentAccessPolicy } from "./remoteAgent/accessPolicy.js";
import { listAuthorizedRemoteAgentEndpoints } from "./remoteAgent/catalog.js";

export type AgentEndpointHttpOptions = {
  catalog: AgentEndpointCatalog;
  remoteAgentAccess: RemoteAgentAccessPolicy;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  transportAdmission: TransportAdmissionPolicy;
};

type HumanCatalogLocatorQuery = {
  canvasId?: string;
  workspaceId?: string;
  humanPrincipalId?: string;
};

function readCatalogLocatorQuery(url: URL): HumanCatalogLocatorQuery | "invalid" {
  const allowed = new Set(["canvasId", "workspaceId", "humanPrincipalId"]);
  const result: HumanCatalogLocatorQuery = {};
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return "invalid";
    const value = url.searchParams.get(key);
    if (!value) return "invalid";
    try {
      if (key === "canvasId") result.canvasId = opaqueIdentifierSchema.parse(value);
      else if (key === "workspaceId") result.workspaceId = workspaceIdSchema.parse(value);
      else result.humanPrincipalId = humanPrincipalIdSchema.parse(value);
    } catch {
      return "invalid";
    }
  }
  return result;
}

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
  const locatorQuery = readCatalogLocatorQuery(url);
  if (locatorQuery === "invalid") {
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
  if (
    locatorQuery.humanPrincipalId !== undefined &&
    locatorQuery.humanPrincipalId !== scope.actor.humanPrincipalId
  ) {
    request.resume();
    respondError(response, 403, "agent_endpoint_forbidden");
    return true;
  }
  const canvasId = locatorQuery.canvasId ?? scope.canvasId ?? "default";
  if (locatorQuery.workspaceId !== undefined && locatorQuery.workspaceId !== scope.workspaceId) {
    request.resume();
    respondError(response, 403, "agent_endpoint_forbidden");
    return true;
  }
  try {
    const body = remoteAgentEndpointListSchema.parse(
      listAuthorizedRemoteAgentEndpoints({
        policy: options.remoteAgentAccess,
        catalog: options.catalog,
        principal: { humanPrincipalId: scope.actor.humanPrincipalId },
        target:
          locatorQuery.workspaceId === undefined
            ? {
                kind: "owner_canvas",
                projectId,
                canvasId
              }
            : {
                kind: "workspace_canvas",
                workspaceId: workspaceIdSchema.parse(locatorQuery.workspaceId),
                projectId,
                canvasId
              }
      })
    );
    request.resume();
    respond(response, 200, body);
  } catch {
    request.resume();
    respondError(response, 500, "agent_endpoint_request_failed");
  }
  return true;
}

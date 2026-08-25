import type { IncomingMessage, ServerResponse } from "node:http";
import type { OperatorPrincipal } from "../operatorAuth.js";
import { operatorRemoteAgentListQuerySchema } from "./managementDtos.js";

export type RemoteAgentManagementPort = {
  listRemoteAgents(principal: OperatorPrincipal, query: unknown): unknown;
  setRemoteAgentAccessMode(
    principal: OperatorPrincipal,
    endpointId: string,
    request: unknown
  ): unknown;
  grantRemoteAgentWorkspace(
    principal: OperatorPrincipal,
    endpointId: string,
    request: unknown
  ): unknown;
  revokeRemoteAgentGrant(
    principal: OperatorPrincipal,
    endpointId: string,
    workspaceId: string,
    request: unknown
  ): unknown;
  revokeRemoteAgent(principal: OperatorPrincipal, endpointId: string, request: unknown): unknown;
  repairRemoteAgentOwnership(
    principal: OperatorPrincipal,
    endpointId: string,
    request: unknown
  ): unknown;
};

export type RemoteAgentManagementRoute =
  | { kind: "list_remote_agents" }
  | {
      kind:
        | "set_remote_agent_access_mode"
        | "grant_remote_agent_workspace"
        | "revoke_remote_agent"
        | "repair_remote_agent_ownership";
      endpointId: string;
    }
  | { kind: "revoke_remote_agent_grant"; endpointId: string; workspaceId: string };

export function matchRemoteAgentManagementRoute(
  method: string | undefined,
  pathname: string,
  decodeIdentifier: (value: string) => string | undefined
): RemoteAgentManagementRoute | undefined {
  if (method === "GET" && pathname === "/api/v1/remote-agents") {
    return { kind: "list_remote_agents" };
  }
  const revokeGrant = /^\/api\/v1\/remote-agents\/([^/]+)\/grants\/([^/]+)\/revoke$/.exec(pathname);
  if (revokeGrant && method === "POST") {
    const endpointId = decodeIdentifier(revokeGrant[1]);
    const workspaceId = decodeIdentifier(revokeGrant[2]);
    if (!endpointId || !workspaceId) return undefined;
    return { kind: "revoke_remote_agent_grant", endpointId, workspaceId };
  }
  const remoteAgent =
    /^\/api\/v1\/remote-agents\/([^/]+)\/(access-mode|grants|revoke|repair-ownership)$/.exec(
      pathname
    );
  if (remoteAgent && method === "POST") {
    const endpointId = decodeIdentifier(remoteAgent[1]);
    if (!endpointId) return undefined;
    if (remoteAgent[2] === "access-mode") {
      return { kind: "set_remote_agent_access_mode", endpointId };
    }
    if (remoteAgent[2] === "grants") return { kind: "grant_remote_agent_workspace", endpointId };
    if (remoteAgent[2] === "revoke") return { kind: "revoke_remote_agent", endpointId };
    return { kind: "repair_remote_agent_ownership", endpointId };
  }
  return undefined;
}

export async function handleRemoteAgentManagementHttp(input: {
  route: RemoteAgentManagementRoute;
  principal: OperatorPrincipal;
  service: RemoteAgentManagementPort;
  url: URL;
  request: IncomingMessage;
  query: (url: URL, allowed: readonly string[]) => Record<string, string | undefined>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  respond: (response: ServerResponse, status: number, body: unknown) => void;
  response: ServerResponse;
}): Promise<void> {
  const { route, principal, service, url, request, query, readJson, respond, response } = input;
  switch (route.kind) {
    case "list_remote_agents":
      respond(
        response,
        200,
        service.listRemoteAgents(
          principal,
          operatorRemoteAgentListQuerySchema.parse(query(url, ["humanPrincipalId"]))
        )
      );
      return;
    case "set_remote_agent_access_mode":
      query(url, []);
      respond(
        response,
        200,
        service.setRemoteAgentAccessMode(principal, route.endpointId, await readJson(request))
      );
      return;
    case "grant_remote_agent_workspace":
      query(url, []);
      respond(
        response,
        200,
        service.grantRemoteAgentWorkspace(principal, route.endpointId, await readJson(request))
      );
      return;
    case "revoke_remote_agent_grant":
      query(url, []);
      respond(
        response,
        200,
        service.revokeRemoteAgentGrant(
          principal,
          route.endpointId,
          route.workspaceId,
          await readJson(request)
        )
      );
      return;
    case "revoke_remote_agent":
      query(url, []);
      respond(
        response,
        200,
        service.revokeRemoteAgent(principal, route.endpointId, await readJson(request))
      );
      return;
    case "repair_remote_agent_ownership":
      query(url, []);
      respond(
        response,
        200,
        service.repairRemoteAgentOwnership(principal, route.endpointId, await readJson(request))
      );
  }
}

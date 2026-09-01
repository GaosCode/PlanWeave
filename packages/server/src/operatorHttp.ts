import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  opaqueIdentifierSchema,
  remoteRunnerEventServerCapabilitySchema
} from "@planweave-ai/agent-host-protocol";
import { RemoteBlockRuntimeError } from "@planweave-ai/runtime";
import { OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE } from "@planweave-ai/collaboration-protocol/remote-run";
import { z } from "zod";
import { agentEndpointCatalogErrorCode } from "./agentEndpointCatalog.js";
import { remoteAgentAuthorizationErrorCode } from "./remoteAgent/errors.js";
import {
  handleRemoteAgentManagementHttp,
  matchRemoteAgentManagementRoute,
  type RemoteAgentManagementPort,
  type RemoteAgentManagementRoute
} from "./remoteAgent/managementHttp.js";
import {
  OperatorTokenRegistry,
  type OperatorPrincipal,
  type OperatorRequestPrincipal
} from "./operatorAuth.js";
import type { HumanIdentityCredentialStore } from "./identity/humanIdentityCredentialStore.js";
import { serverReadinessSchema, type ServerReadiness } from "./readiness.js";
import { DispatchAssignmentError } from "./work/dispatchIntegration.js";
import { RemoteExecutionActionRejectedError } from "./remoteExecutionActions.js";
import { CanvasRuntimeRpcError } from "./canvas/runtimeRpcBroker.js";
import { CanvasRuntimeUnavailableError } from "./canvas/executionRuntimePort.js";
import { readOwnerCanvasMaterializationUpload } from "./canvas/ownerCanvasMaterializationHttp.js";
import {
  OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
  OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER,
  operatorOwnerTerminalResultMetadataSchema,
  type OperatorOperationRuntimeWire,
  type OperatorOwnerTerminalResultPayload
} from "./operatorDtos.js";
import {
  operatorNetworkTransportAllowed,
  type TransportAdmissionPolicy
} from "./insecureTransport.js";

const MAX_OPERATOR_BODY_BYTES = 64 * 1024;
const OPERATOR_HUMAN_IDENTITY_HEADER = "x-planweave-human-identity";

const buildRevisionSchema = z.string().regex(/^(?:[0-9a-f]{7,64}|development)$/);
const healthResponseSchema = z
  .object({ status: z.literal("ok"), serverBuildRevision: buildRevisionSchema })
  .strict();
const versionResponseSchema = z
  .object({
    serverVersion: z.string().min(1).max(64),
    serverBuildRevision: buildRevisionSchema,
    protocolVersion: z.literal(1),
    remoteRunnerEvents: remoteRunnerEventServerCapabilitySchema,
    limits: z
      .object({
        maxArtifactBytes: z.number().int().positive(),
        maxWebSocketPayloadBytes: z.number().int().positive()
      })
      .strict()
  })
  .strict();

export type OperatorHttpOptions = {
  authorization: OperatorTokenRegistry;
  humanIdentityCredentials: HumanIdentityCredentialStore;
  service: OperatorControlPort;
  readiness(): ServerReadiness;
  serverVersion: string;
  serverBuildRevision: string;
  limits: {
    maxArtifactBytes: number;
    maxWebSocketPayloadBytes: number;
  };
  transportAdmission: TransportAdmissionPolicy;
};

export type OperatorControlPort = {
  remoteRunnerEventCapability?(): unknown;
  createEnrollmentGrant(principal: OperatorRequestPrincipal, request: unknown): unknown;
  listHosts(principal: OperatorPrincipal, query: unknown): unknown;
  listAgentEndpoints(principal: OperatorRequestPrincipal, query: unknown): unknown;
  getHost(principal: OperatorPrincipal, hostId: string): unknown;
  revokeHost(principal: OperatorPrincipal, hostId: string): unknown;
  requestHostCredentialRenewal(
    principal: OperatorRequestPrincipal,
    hostId: string,
    request: unknown
  ): unknown;
  dispatch(
    principal: OperatorRequestPrincipal,
    request: unknown,
    runtimeWire?: OperatorOperationRuntimeWire
  ): Promise<unknown>;
  observeOperation(
    principal: OperatorRequestPrincipal,
    operationId: string,
    runtimeWire?: OperatorOperationRuntimeWire
  ): Promise<unknown>;
  readOwnerOperationTerminalResult(
    principal: OperatorRequestPrincipal,
    operationId: string
  ): Promise<OperatorOwnerTerminalResultPayload>;
  inspectOwnerCanvasMaterializationHead(
    principal: OperatorRequestPrincipal,
    scope: unknown
  ): unknown;
  materializeOwnerCanvas(principal: OperatorRequestPrincipal, request: unknown): unknown;
  executeAction(
    principal: OperatorRequestPrincipal,
    operationId: string,
    request: unknown
  ): Promise<unknown>;
  replayEvents(
    principal: OperatorRequestPrincipal,
    operationId: string,
    afterCursor: unknown
  ): unknown;
  listPendingInteractions(
    principal: OperatorRequestPrincipal,
    operationId: string,
    query: unknown
  ): unknown;
  settleInteraction(
    principal: OperatorRequestPrincipal,
    operationId: string,
    request: unknown
  ): unknown;
} & RemoteAgentManagementPort;

type OperatorRoute =
  | { kind: "health" }
  | { kind: "readiness" }
  | { kind: "version" }
  | { kind: "create_enrollment" }
  | { kind: "list_hosts" }
  | { kind: "list_agent_endpoints" }
  | { kind: "get_host" | "revoke_host" | "renew_host_credential"; hostId: string }
  | { kind: "dispatch" }
  | { kind: "owner_canvas_materialization_head" | "owner_canvas_materialize" }
  | {
      kind:
        | "get_operation"
        | "terminal_result"
        | "action"
        | "events"
        | "interactions"
        | "settle_interaction";
      operationId: string;
    }
  | RemoteAgentManagementRoute;

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function attachHumanIdentity(
  request: IncomingMessage,
  principal: OperatorPrincipal,
  credentials: HumanIdentityCredentialStore
): OperatorRequestPrincipal {
  const authorization = request.headers[OPERATOR_HUMAN_IDENTITY_HEADER];
  if (authorization === undefined) return principal;
  if (Array.isArray(authorization)) throw new Error("operator_human_identity_unauthorized");
  const match = /^Bearer (\S+)$/.exec(authorization.trim());
  const identity = match ? credentials.authenticate(match[1]) : undefined;
  if (!identity) throw new Error("operator_human_identity_unauthorized");
  return { ...principal, humanPrincipalId: identity.humanPrincipalId };
}

function route(request: IncomingMessage, pathname: string): OperatorRoute | undefined {
  if (request.method === "GET" && pathname === "/healthz") return { kind: "health" };
  if (request.method === "GET" && pathname === "/readyz") return { kind: "readiness" };
  if (request.method === "GET" && pathname === "/version") return { kind: "version" };
  if (request.method === "POST" && pathname === "/api/v1/host-enrollments") {
    return { kind: "create_enrollment" };
  }
  if (request.method === "GET" && pathname === "/api/v1/hosts") {
    return { kind: "list_hosts" };
  }
  if (request.method === "GET" && pathname === "/api/v1/agent-endpoints") {
    return { kind: "list_agent_endpoints" };
  }
  if (request.method === "POST" && pathname === "/api/v1/remote-operations") {
    return { kind: "dispatch" };
  }
  if (request.method === "GET" && pathname === "/api/v1/owner-canvas-materializations/head") {
    return { kind: "owner_canvas_materialization_head" };
  }
  if (request.method === "POST" && pathname === "/api/v1/owner-canvas-materializations") {
    return { kind: "owner_canvas_materialize" };
  }
  const remoteAgentRoute = matchRemoteAgentManagementRoute(
    request.method,
    pathname,
    decodeIdentifier
  );
  if (remoteAgentRoute) return remoteAgentRoute;
  const host = /^\/api\/v1\/hosts\/([^/]+)(\/(?:revoke|credential-renewal))?$/.exec(pathname);
  if (host) {
    const hostId = decodeIdentifier(host[1]);
    if (!hostId) return undefined;
    if (request.method === "GET" && !host[2]) return { kind: "get_host", hostId };
    if (request.method === "POST" && host[2] === "/revoke") {
      return { kind: "revoke_host", hostId };
    }
    if (request.method === "POST" && host[2] === "/credential-renewal") {
      return { kind: "renew_host_credential", hostId };
    }
  }
  const operation =
    /^\/api\/v1\/remote-operations\/([^/]+)(?:\/(actions|events|interactions|terminal-result)(\/respond)?)?$/.exec(
      pathname
    );
  if (!operation) return undefined;
  const operationId = decodeIdentifier(operation[1]);
  if (!operationId) return undefined;
  if (request.method === "GET" && !operation[2]) return { kind: "get_operation", operationId };
  if (request.method === "GET" && operation[2] === "terminal-result" && !operation[3]) {
    return { kind: "terminal_result", operationId };
  }
  if (request.method === "POST" && operation[2] === "actions" && !operation[3]) {
    return { kind: "action", operationId };
  }
  if (request.method === "GET" && operation[2] === "events" && !operation[3]) {
    return { kind: "events", operationId };
  }
  if (request.method === "GET" && operation[2] === "interactions" && !operation[3]) {
    return { kind: "interactions", operationId };
  }
  if (request.method === "POST" && operation[2] === "interactions" && operation[3] === "/respond") {
    return { kind: "settle_interaction", operationId };
  }
  return undefined;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function respondOwnerTerminalResult(
  response: ServerResponse,
  payload: OperatorOwnerTerminalResultPayload
): void {
  const metadata = operatorOwnerTerminalResultMetadataSchema.parse(payload.metadata);
  const bytes = Buffer.from(payload.reportBytes);
  if (bytes.byteLength > OUTPUT_MAX_ARTIFACT_BYTES) {
    throw new Error("operator_terminal_result_too_large");
  }
  const encodedMetadata = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  response.writeHead(200, {
    "content-type": OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
    "content-length": bytes.byteLength,
    [OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER]: encodedMetadata,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("operator_content_type_invalid");
  }
  const declaredLength = request.headers["content-length"];
  if (Array.isArray(declaredLength)) throw new Error("operator_content_length_invalid");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_OPERATOR_BODY_BYTES)
  ) {
    throw new Error("operator_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_OPERATOR_BODY_BYTES) throw new Error("operator_body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("operator_json_invalid");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("operator_query_invalid");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function operationRuntimeWire(accept: string | string[] | undefined): OperatorOperationRuntimeWire {
  const values = Array.isArray(accept) ? accept : accept === undefined ? [] : [accept];
  const publicRuntimeRequested = values.some((value) =>
    value.split(",").some((entry) => {
      const mediaType = entry.split(";", 1)[0]?.trim().toLowerCase();
      return mediaType === OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE;
    })
  );
  return publicRuntimeRequested ? "public-runtime-v1" : "legacy-rich";
}

function varyOnAccept(response: ServerResponse): void {
  const existing = response.getHeader("Vary");
  if (existing === undefined) {
    response.setHeader("Vary", "Accept");
    return;
  }
  const values = Array.isArray(existing) ? existing.map(String) : String(existing).split(",");
  if (!values.some((value) => value.trim().toLowerCase() === "accept")) {
    response.setHeader("Vary", `${String(existing)}, Accept`);
  }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "operator_request_invalid" };
  if (error instanceof CanvasRuntimeUnavailableError) {
    return { status: 503, code: "canvas_runtime_unavailable" };
  }
  if (error instanceof CanvasRuntimeRpcError) {
    if (error.code === "remote_block_not_found") return { status: 404, code: error.code };
    if (
      error.code === "remote_block_not_dispatchable" ||
      error.code === "remote_block_source_changed" ||
      error.code === "remote_block_result_conflict"
    ) {
      return { status: 409, code: error.code };
    }
    if (
      error.code === "canvas_runtime_host_offline" ||
      error.code === "canvas_runtime_rpc_deadline_exceeded" ||
      error.code === "canvas_runtime_reconcile_required"
    ) {
      return { status: 503, code: error.code };
    }
  }
  if (error instanceof RemoteBlockRuntimeError) {
    if (error.code === "remote_block_not_found") {
      return { status: 404, code: error.code };
    }
    if (
      error.code === "remote_block_not_dispatchable" ||
      error.code === "remote_block_source_changed" ||
      error.code === "remote_block_result_conflict"
    ) {
      return { status: 409, code: error.code };
    }
    return { status: 400, code: error.code };
  }
  const endpointErrorCode = agentEndpointCatalogErrorCode(error);
  if (endpointErrorCode) return { status: 409, code: endpointErrorCode };
  const agentAccessCode = remoteAgentAuthorizationErrorCode(error);
  if (agentAccessCode) {
    if (agentAccessCode === "remote_agent_not_found") return { status: 404, code: agentAccessCode };
    if (
      agentAccessCode === "remote_agent_policy_revision_conflict" ||
      agentAccessCode === "remote_agent_grant_revision_conflict"
    ) {
      return { status: 409, code: agentAccessCode };
    }
    return { status: 403, code: agentAccessCode };
  }
  if (error instanceof RemoteExecutionActionRejectedError) {
    return { status: 409, code: error.code };
  }
  if (error instanceof DispatchAssignmentError) {
    if (error.code === "work_revision_conflict" || error.code === "work_dispatch_host_mismatch") {
      return { status: 409, code: error.code };
    }
    if (
      error.code === "work_not_agent_assigned" ||
      error.code === "work_item_kind_target_mismatch" ||
      error.code === "work_item_not_found" ||
      error.code === "work_input_invalid"
    ) {
      return { status: 409, code: error.code };
    }
    return { status: 400, code: error.code };
  }
  if (!(error instanceof Error)) return { status: 500, code: "operator_request_failed" };
  if (error.message === "remote_run_v3_required") {
    return { status: 400, code: error.message };
  }
  if (error.message === "remote_acp_event_replay_cursor_ahead") {
    return { status: 409, code: error.message };
  }
  if (
    [
      "operator_body_too_large",
      "operator_content_length_invalid",
      "operator_content_type_invalid",
      "operator_json_invalid",
      "operator_query_invalid"
    ].includes(error.message)
  ) {
    return {
      status: error.message === "operator_body_too_large" ? 413 : 400,
      code: error.message === "operator_body_too_large" ? error.message : "operator_request_invalid"
    };
  }
  if (
    error.message.startsWith("owner_canvas_materialization_") ||
    error.message.startsWith("content_version_")
  ) {
    if (error.message.endsWith("too_large")) return { status: 413, code: error.message };
    if (
      error.message.includes("conflict") ||
      error.message === "owner_canvas_materialization_active_operation"
    ) {
      return { status: 409, code: error.message };
    }
    if (error.message.endsWith("unavailable")) return { status: 503, code: error.message };
    return { status: 400, code: "operator_request_invalid" };
  }
  if (error.message.startsWith("operator_project_forbidden")) {
    return { status: 403, code: "operator_scope_forbidden" };
  }
  if (
    error.message === "operator_workspace_forbidden" ||
    error.message === "operator_workspace_unmapped" ||
    error.message === "operator_host_workspace_ambiguous"
  ) {
    return { status: 403, code: "operator_workspace_forbidden" };
  }
  if (error.message === "operator_workspace_required") {
    return { status: 400, code: "operator_workspace_required" };
  }
  if (error.message === "operator_server_admin_required") {
    return { status: 403, code: "operator_admin_required" };
  }
  if (error.message === "operator_human_identity_unauthorized") {
    return { status: 401, code: error.message };
  }
  if (error.message === "operator_human_identity_forbidden") {
    return { status: 403, code: error.message };
  }
  if (error.message.includes("not_found"))
    return { status: 404, code: "operator_resource_not_found" };
  if (
    error.message.includes("conflict") ||
    error.message.includes("mismatch") ||
    error.message.includes("stale") ||
    error.message.includes("invalid_state") ||
    error.message.includes("not_interruptible")
  ) {
    return { status: 409, code: "operator_operation_conflict" };
  }
  return { status: 500, code: "operator_request_failed" };
}

export function operatorTransportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  transportAdmission: TransportAdmissionPolicy
): boolean {
  return operatorNetworkTransportAllowed(socket, transportAdmission);
}

export async function handleOperatorHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: OperatorHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (
      url.pathname.startsWith("/api/v1/") ||
      ["/healthz", "/readyz", "/version"].includes(url.pathname)
    ) {
      respond(response, 404, {
        error: "route_not_found",
        serverBuildRevision: options.serverBuildRevision
      });
      return true;
    }
    return false;
  }
  try {
    if (matched.kind === "health") {
      query(url, []);
      respond(
        response,
        200,
        healthResponseSchema.parse({
          status: "ok",
          serverBuildRevision: options.serverBuildRevision
        })
      );
      return true;
    }
    if (matched.kind === "readiness") {
      query(url, []);
      const readiness = serverReadinessSchema.parse(options.readiness());
      respond(response, readiness.status === "ready" ? 200 : 503, readiness);
      return true;
    }
    if (matched.kind === "version") {
      query(url, []);
      respond(
        response,
        200,
        versionResponseSchema.parse({
          serverVersion: options.serverVersion,
          serverBuildRevision: options.serverBuildRevision,
          protocolVersion: 1,
          remoteRunnerEvents: options.service.remoteRunnerEventCapability?.() ?? {
            available: false
          },
          limits: options.limits
        })
      );
      return true;
    }
    if (!operatorTransportAllowed(request.socket, options.transportAdmission)) {
      request.resume();
      respond(response, 426, {
        error: "operator_insecure_transport",
        serverBuildRevision: options.serverBuildRevision
      });
      return true;
    }
    const operatorPrincipal = options.authorization.authenticate(request.headers.authorization);
    if (!operatorPrincipal) {
      request.resume();
      respond(response, 401, {
        error: "operator_unauthorized",
        serverBuildRevision: options.serverBuildRevision
      });
      return true;
    }
    const principal = attachHumanIdentity(
      request,
      operatorPrincipal,
      options.humanIdentityCredentials
    );
    switch (matched.kind) {
      case "create_enrollment":
        query(url, []);
        respond(
          response,
          201,
          options.service.createEnrollmentGrant(principal, await readJson(request))
        );
        break;
      case "list_hosts":
        respond(
          response,
          200,
          options.service.listHosts(principal, query(url, ["workspaceId", "cursor", "limit"]))
        );
        break;
      case "list_agent_endpoints": {
        const endpointQuery = query(url, [
          "projectId",
          "humanPrincipalId",
          "canvasId",
          "workspaceId"
        ]);
        if (
          endpointQuery.projectId === undefined &&
          endpointQuery.humanPrincipalId === undefined &&
          endpointQuery.canvasId === undefined &&
          endpointQuery.workspaceId === undefined
        ) {
          options.authorization.requireServerAdmin(principal);
        }
        respond(response, 200, options.service.listAgentEndpoints(principal, endpointQuery));
        break;
      }
      case "list_remote_agents":
      case "set_remote_agent_access_mode":
      case "grant_remote_agent_workspace":
      case "revoke_remote_agent_grant":
      case "revoke_remote_agent":
        await handleRemoteAgentManagementHttp({
          route: matched,
          principal,
          service: options.service,
          url,
          request,
          query,
          readJson,
          respond,
          response
        });
        break;
      case "repair_remote_agent_ownership":
        options.authorization.requireServerAdmin(principal);
        await handleRemoteAgentManagementHttp({
          route: matched,
          principal,
          service: options.service,
          url,
          request,
          query,
          readJson,
          respond,
          response
        });
        break;
      case "get_host":
        query(url, []);
        respond(response, 200, options.service.getHost(principal, matched.hostId));
        break;
      case "revoke_host":
        query(url, []);
        respond(response, 200, options.service.revokeHost(principal, matched.hostId));
        break;
      case "renew_host_credential":
        query(url, []);
        respond(
          response,
          202,
          options.service.requestHostCredentialRenewal(
            principal,
            matched.hostId,
            await readJson(request)
          )
        );
        break;
      case "dispatch":
        query(url, []);
        varyOnAccept(response);
        respond(
          response,
          202,
          await options.service.dispatch(
            principal,
            await readJson(request),
            operationRuntimeWire(request.headers.accept)
          )
        );
        break;
      case "owner_canvas_materialization_head": {
        const parameters = query(url, ["ownerHumanPrincipalId", "projectId", "canvasId"]);
        respond(
          response,
          200,
          options.service.inspectOwnerCanvasMaterializationHead(principal, parameters)
        );
        break;
      }
      case "owner_canvas_materialize":
        query(url, []);
        respond(
          response,
          201,
          options.service.materializeOwnerCanvas(
            principal,
            await readOwnerCanvasMaterializationUpload(request)
          )
        );
        break;
      case "get_operation":
        query(url, []);
        varyOnAccept(response);
        respond(
          response,
          200,
          await options.service.observeOperation(
            principal,
            matched.operationId,
            operationRuntimeWire(request.headers.accept)
          )
        );
        break;
      case "terminal_result":
        query(url, []);
        respondOwnerTerminalResult(
          response,
          await options.service.readOwnerOperationTerminalResult(principal, matched.operationId)
        );
        break;
      case "action":
        query(url, []);
        respond(
          response,
          202,
          await options.service.executeAction(
            principal,
            matched.operationId,
            await readJson(request)
          )
        );
        break;
      case "events": {
        const parameters = query(url, ["afterCursor"]);
        respond(
          response,
          200,
          options.service.replayEvents(principal, matched.operationId, parameters.afterCursor)
        );
        break;
      }
      case "interactions":
        respond(
          response,
          200,
          options.service.listPendingInteractions(
            principal,
            matched.operationId,
            query(url, ["cursor", "limit"])
          )
        );
        break;
      case "settle_interaction":
        query(url, []);
        respond(
          response,
          200,
          options.service.settleInteraction(principal, matched.operationId, await readJson(request))
        );
        break;
    }
  } catch (error) {
    const safe = safeError(error);
    request.resume();
    if (!response.headersSent) {
      respond(response, safe.status, {
        error: safe.code,
        serverBuildRevision: options.serverBuildRevision
      });
    } else response.destroy();
  }
  return true;
}

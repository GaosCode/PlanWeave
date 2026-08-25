import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { setupCodeIssueRequestSchema } from "@planweave-ai/collaboration-protocol/setup";
import { z } from "zod";
import { OperatorTokenRegistry, type OperatorPrincipal } from "../operatorAuth.js";
import { SetupCodeError, SetupCodeService } from "./setupCodeService.js";
import {
  humanNetworkTransportAllowed,
  type TransportAdmissionPolicy
} from "../insecureTransport.js";

const MAX_SETUP_BODY_BYTES = 16_384;
const currentWorkspaceDeviceIssueRequestSchema = setupCodeIssueRequestSchema
  .omit({ workspaceId: true, purpose: true })
  .extend({ purpose: z.literal("device_session") })
  .strict();

export type SetupCodeHttpOptions = {
  service: SetupCodeService;
  authorization: OperatorTokenRegistry;
  transportAdmission: TransportAdmissionPolicy;
};

type SetupRoute =
  | { kind: "issue"; workspaceId: string }
  | { kind: "issueCurrentWorkspace" }
  | { kind: "list"; workspaceId: string }
  | { kind: "revoke"; workspaceId: string; setupCodeId: string }
  | { kind: "redeem" };

function transportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  transportAdmission: TransportAdmissionPolicy
): boolean {
  return humanNetworkTransportAllowed(socket, transportAdmission);
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

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): SetupRoute | undefined {
  if (request.method === "POST" && pathname === "/api/v1/setup-codes") {
    return { kind: "issueCurrentWorkspace" };
  }
  if (request.method === "POST" && pathname === "/api/v1/setup-codes/redeem") {
    return { kind: "redeem" };
  }
  const workspaceCodes = /^\/api\/v1\/workspaces\/([^/]+)\/setup-codes$/.exec(pathname);
  if (workspaceCodes) {
    const workspaceId = decodeIdentifier(workspaceCodes[1]);
    if (!workspaceId) return undefined;
    if (request.method === "POST") return { kind: "issue", workspaceId };
    if (request.method === "GET") return { kind: "list", workspaceId };
  }
  const revoke = /^\/api\/v1\/workspaces\/([^/]+)\/setup-codes\/([^/]+)\/revoke$/.exec(pathname);
  if (revoke && request.method === "POST") {
    const workspaceId = decodeIdentifier(revoke[1]);
    const setupCodeId = decodeIdentifier(revoke[2]);
    if (!workspaceId || !setupCodeId) return undefined;
    return { kind: "revoke", workspaceId, setupCodeId };
  }
  return undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new SetupCodeError("setup_code_malformed");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_SETUP_BODY_BYTES) throw new Error("setup_code_body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SetupCodeError("setup_code_malformed");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("setup_code_query_invalid");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function mapError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "setup_code_malformed" };
  if (error instanceof SetupCodeError) {
    switch (error.code) {
      case "setup_code_expired":
        return { status: 410, code: error.code };
      case "setup_code_revoked":
      case "setup_code_issuer_revoked":
      case "setup_code_workspace_archived":
        return { status: 403, code: error.code };
      case "setup_code_redeemed":
      case "setup_code_already_redeemed":
      case "setup_code_already_revoked":
      case "setup_code_purpose_mismatch":
      case "setup_code_workspace_mismatch":
        return { status: 409, code: error.code };
      case "setup_code_not_found":
      case "workspace_not_found":
        return { status: 404, code: error.code };
      case "workspace_identity_read_cutover_incomplete":
        return { status: 409, code: error.code };
      case "setup_code_forbidden_capability":
        return { status: 400, code: error.code };
      case "setup_code_existing_identity_invalid":
        return { status: 403, code: error.code };
      case "setup_code_existing_identity_conflict":
        return { status: 400, code: error.code };
      default:
        return { status: 400, code: error.code };
    }
  }
  if (!(error instanceof Error)) return { status: 500, code: "setup_code_failed" };
  if (error.message === "operator_workspace_forbidden") {
    return { status: 403, code: "operator_workspace_forbidden" };
  }
  if (error.message === "operator_server_admin_required") {
    return { status: 403, code: "operator_server_admin_required" };
  }
  if (error.message === "setup_code_body_too_large") {
    return { status: 413, code: "setup_code_body_too_large" };
  }
  if (error.message === "setup_code_query_invalid") {
    return { status: 400, code: "setup_code_query_invalid" };
  }
  return { status: 500, code: "setup_code_failed" };
}

function requireOperator(
  authorization: OperatorTokenRegistry,
  header: string | string[] | undefined
): OperatorPrincipal {
  const principal = authorization.authenticate(header);
  if (!principal) throw new Error("operator_unauthorized");
  return principal;
}

export async function handleSetupCodeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: SetupCodeHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) return false;

  try {
    if (!transportAllowed(request.socket, options.transportAdmission)) {
      request.resume();
      respond(response, 426, { error: "setup_code_insecure_transport" });
      return true;
    }

    if (matched.kind === "redeem") {
      query(url, []);
      respond(response, 200, options.service.redeem(await readJson(request)));
      return true;
    }

    const principal = requireOperator(options.authorization, request.headers.authorization);
    if (matched.kind === "issueCurrentWorkspace") {
      query(url, []);
      options.authorization.requireServerAdmin(principal);
      const body = currentWorkspaceDeviceIssueRequestSchema.parse(await readJson(request));
      respond(
        response,
        201,
        options.service.issue(principal, { ...body, workspaceId: principal.workspaceId })
      );
      return true;
    }
    if (matched.kind === "issue") {
      query(url, []);
      const body = await readJson(request);
      const bodyWorkspaceId =
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        "workspaceId" in body &&
        typeof body.workspaceId === "string"
          ? body.workspaceId
          : undefined;
      if (bodyWorkspaceId !== undefined && bodyWorkspaceId !== matched.workspaceId) {
        throw new SetupCodeError("setup_code_workspace_mismatch");
      }
      const requestBody =
        body && typeof body === "object" && !Array.isArray(body)
          ? { ...body, workspaceId: matched.workspaceId }
          : { workspaceId: matched.workspaceId };
      respond(response, 201, options.service.issue(principal, requestBody));
      return true;
    }
    if (matched.kind === "list") {
      const params = query(url, ["cursor", "limit", "openOnly"]);
      respond(
        response,
        200,
        options.service.list(principal, matched.workspaceId, {
          cursor: params.cursor === undefined ? undefined : Number(params.cursor),
          limit: params.limit === undefined ? undefined : Number(params.limit),
          openOnly:
            params.openOnly === undefined
              ? undefined
              : params.openOnly === "true"
                ? true
                : params.openOnly === "false"
                  ? false
                  : params.openOnly
        })
      );
      return true;
    }
    query(url, []);
    const body = await readJson(request);
    const reason =
      body && typeof body === "object" && "reason" in body
        ? (body as { reason: unknown }).reason
        : undefined;
    const revocation = options.service.revoke(principal, {
      schemaVersion: "workspace-setup/v1",
      setupCodeId: matched.setupCodeId,
      reason
    });
    if (revocation.workspaceId !== matched.workspaceId) {
      respond(response, 404, { error: "setup_code_not_found" });
      return true;
    }
    respond(response, 200, revocation);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "operator_unauthorized") {
      respond(response, 401, { error: "operator_unauthorized" });
      return true;
    }
    const mapped = mapError(error);
    respond(response, mapped.status, { error: mapped.code });
    return true;
  }
}

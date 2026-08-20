import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  authenticateCollaborationForScope,
  authenticateCollaborationForProject,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type CollaborationScopeAuthority
} from "../identity/index.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ContentVersionService } from "./contentVersionService.js";
import { ContentVersionRepository } from "./contentVersionRepository.js";
import { streamContentVersion } from "./contentVersionTransferHttp.js";

type Route =
  | { kind: "publish"; projectId: string; canvasId: string }
  | { kind: "fetch"; projectId: string; canvasId: string }
  | { kind: "ack"; projectId: string; canvasId: string }
  | { kind: "head"; projectId: string; canvasId: string };

export type ContentVersionHttpOptions = {
  service: ContentVersionService;
  contentVersions: ContentVersionRepository;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  transportAdmission: TransportAdmissionPolicy;
};

function route(request: IncomingMessage, pathname: string): Route | undefined {
  if (request.method !== "POST") return undefined;
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/canvases\/([^/]+)\/content\/(initial-publish|fetch|acknowledgements|head)$/.exec(
      pathname
    );
  if (!match) return undefined;
  const projectId = opaqueIdentifierSchema.safeParse(decodeURIComponent(match[1]!));
  const canvasId = opaqueIdentifierSchema.safeParse(decodeURIComponent(match[2]!));
  if (!projectId.success || !canvasId.success) return undefined;
  const kind =
    match[3] === "initial-publish"
      ? "publish"
      : match[3] === "fetch"
        ? "fetch"
        : match[3] === "acknowledgements"
          ? "ack"
          : "head";
  return { kind, projectId: projectId.data, canvasId: canvasId.data };
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

async function json(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""))
    throw new Error("invalid");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 256 * 1024 * 1024) throw new Error("large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid");
  }
}

export async function handleContentVersionHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ContentVersionHttpOptions
): Promise<boolean> {
  const matched = route(request, new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  if (!matched) return false;
  if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
    respond(response, 400, { error: "insecure_transport" });
    return true;
  }
  const credentialActor = authenticateCollaborationForProject(
    options.repository,
    options.workspaceIdentity,
    request.headers.authorization,
    matched.projectId
  );
  if (!credentialActor) {
    respond(response, 401, { error: "unauthorized" });
    return true;
  }
  const authenticated = authenticateCollaborationForScope(
    options.repository,
    options.workspaceIdentity,
    options.collaborationScopeAuthority,
    request.headers.authorization,
    matched.projectId,
    matched.canvasId
  );
  if (!authenticated) {
    respond(response, 403, { error: "forbidden" });
    return true;
  }
  const context = authenticated.actor;
  try {
    const body = await json(request);
    if (matched.kind === "publish") {
      const result = options.service.publishInitial(context, {
        ...(body as object),
        projectId: matched.projectId,
        canvasId: matched.canvasId
      });
      respond(
        response,
        result.outcome === "published"
          ? 201
          : result.reason === "head_cas_conflict" || result.reason === "head_already_exists"
            ? 409
            : 422,
        result
      );
    } else if (matched.kind === "fetch") {
      const authorized = options.service.authorizeFetch(context, {
        ...(body as object),
        projectId: matched.projectId,
        canvasId: matched.canvasId
      });
      await streamContentVersion(
        response,
        options.contentVersions,
        authorized.scope,
        authorized.content
      );
    } else if (matched.kind === "ack") {
      respond(
        response,
        200,
        options.service.acknowledge(context, matched.projectId, matched.canvasId, body)
      );
    } else {
      respond(
        response,
        200,
        options.service.discoverAuthority(context, {
          ...(body as object),
          projectId: matched.projectId,
          canvasId: matched.canvasId
        })
      );
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return true;
    }
    const code = error instanceof Error ? error.message : "content_failure";
    respond(
      response,
      code.endsWith("forbidden")
        ? 403
        : code === "content_version_not_found"
          ? 404
          : code === "large"
            ? 413
            : 422,
      { error: code.endsWith("forbidden") ? "forbidden" : "content_request_rejected" }
    );
  }
  return true;
}

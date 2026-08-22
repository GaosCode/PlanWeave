import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import type { WorkspaceCanvasInitialPublishResult } from "@planweave-ai/collaboration-protocol/content/version";
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
  | { kind: "workspace_publish"; projectId: string }
  | { kind: "fetch"; projectId: string; canvasId: string }
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
  const workspacePublish =
    request.method === "POST"
      ? /^\/api\/v1\/projects\/([^/]+)\/workspace-canvases\/publish$/.exec(pathname)
      : null;
  if (workspacePublish) {
    const projectId = opaqueIdentifierSchema.safeParse(decodeURIComponent(workspacePublish[1]!));
    return projectId.success ? { kind: "workspace_publish", projectId: projectId.data } : undefined;
  }
  const match = /^\/api\/v1\/projects\/([^/]+)\/canvases\/([^/]+)\/content\/(fetch|head)$/.exec(
    pathname
  );
  if (!match) return undefined;
  const projectId = opaqueIdentifierSchema.safeParse(decodeURIComponent(match[1]!));
  const canvasId = opaqueIdentifierSchema.safeParse(decodeURIComponent(match[2]!));
  if (!projectId.success || !canvasId.success) return undefined;
  const kind = match[3] === "fetch" ? "fetch" : "head";
  if (
    (kind === "fetch" && request.method !== "POST") ||
    (kind === "head" && request.method !== "GET")
  ) {
    return undefined;
  }
  return { kind, projectId: projectId.data, canvasId: canvasId.data };
}

function workspaceCanvasPublishHttpStatus(result: WorkspaceCanvasInitialPublishResult): number {
  if (result.outcome === "published") return 201;
  if (result.outcome === "reused") return 200;
  switch (result.reason) {
    case "canvas_already_exists":
    case "operation_conflict":
      return 409;
    case "authorization_revoked":
      return 403;
    case "content_verification_failed":
    case "storage_unavailable":
    case "canvas_publish_incomplete":
      return 422;
    default: {
      const exhaustive: never = result.reason;
      return exhaustive;
    }
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
  if (matched.kind === "workspace_publish") {
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
    try {
      const body = await json(request);
      const result = options.service.publishWorkspaceCanvas(
        credentialActor,
        matched.projectId,
        body
      );
      respond(response, workspaceCanvasPublishHttpStatus(result), result);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return true;
      }
      const code = error instanceof Error ? error.message : "content_failure";
      respond(response, code === "large" ? 413 : 422, { error: "content_request_rejected" });
    }
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
    if (matched.kind === "fetch") {
      const body = await json(request);
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
    } else {
      respond(
        response,
        200,
        options.service.readHead(context, matched.projectId, matched.canvasId)
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

import type { IncomingMessage, ServerResponse } from "node:http";
import { completedContentVersionRefSchema } from "@planweave-ai/collaboration-protocol/content/version";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { AgentHostRepository } from "../hosts.js";
import { authenticateAgentHostRequest } from "../hostTransportAuth.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { ContentVersionRepository } from "./contentVersionRepository.js";
import type { CanvasRuntimeHostLocator } from "./runtimeHostLocator.js";
import { streamContentVersion } from "./contentVersionTransferHttp.js";

export type RuntimeContentHttpOptions = {
  hosts: AgentHostRepository;
  locator: CanvasRuntimeHostLocator;
  contentVersions: ContentVersionRepository;
  transportAdmission: TransportAdmissionPolicy;
};

function respond(response: ServerResponse, status: number, error: string): void {
  const bytes = Buffer.from(JSON.stringify({ error }));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

/** Host-token-only immutable content plane, bound to the Host's active logical Runtime scope. */
export async function handleCanvasRuntimeContentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RuntimeContentHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const match = /^\/agent-hosts\/([^/]+)\/canvas-runtime\/content\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
    url.pathname
  );
  if (!match) return false;
  if (request.method !== "GET") {
    respond(response, 404, "runtime_content_route_not_found");
    return true;
  }
  let hostId: string;
  let scope: ReturnType<typeof canvasScopeRefSchema.parse>;
  let content: ReturnType<typeof completedContentVersionRefSchema.parse>;
  try {
    hostId = decodeURIComponent(match[1]!);
    scope = canvasScopeRefSchema.parse({
      workspaceId: url.searchParams.get("workspaceId"),
      projectId: decodeURIComponent(match[2]!),
      canvasId: decodeURIComponent(match[3]!)
    });
    content = completedContentVersionRefSchema.parse({
      versionId: decodeURIComponent(match[4]!),
      canonicalDigest: url.searchParams.get("canonicalDigest"),
      verification: "complete"
    });
  } catch {
    respond(response, 400, "runtime_content_request_invalid");
    return true;
  }
  try {
    const authentication = authenticateAgentHostRequest(
      request,
      options.hosts,
      hostId,
      options.transportAdmission,
      scope.workspaceId
    );
    if (!authentication.ok) {
      respond(response, authentication.status, "runtime_content_unauthorized");
      request.resume();
      return true;
    }
    let located: ReturnType<CanvasRuntimeHostLocator["locate"]>;
    try {
      located = options.locator.locate(scope);
    } catch (error) {
      if (error instanceof Error && error.message === "canvas_runtime_scope_unavailable") {
        respond(response, 403, "runtime_content_scope_forbidden");
        return true;
      }
      throw error;
    }
    if (located.kind !== "available" || located.hostId !== hostId) {
      respond(response, 403, "runtime_content_scope_forbidden");
      return true;
    }
    const head = options.contentVersions.head(scope);
    if (
      !head ||
      head.content.versionId !== content.versionId ||
      head.content.canonicalDigest !== content.canonicalDigest
    ) {
      respond(response, 409, "runtime_content_target_stale");
      return true;
    }
    await streamContentVersion(response, options.contentVersions, scope, content);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return true;
    }
    respond(response, 500, "runtime_content_internal_error");
  }
  return true;
}

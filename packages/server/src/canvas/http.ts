import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandOutcomeSchema,
  canvasReconnectResponseSchema,
  type CanvasCommandOutcome
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { canvasRuntimeStatusProjectionSchema } from "@planweave-ai/collaboration-protocol/canvas/status";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticateCollaborationForScope,
  authenticateCollaborationForProject,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "../identity/index.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  CANVAS_COMMAND_HTTP_BODY_MAX_BYTES,
  CANVAS_COMMAND_RATE_MAX_REQUESTS,
  CANVAS_COMMAND_RATE_WINDOW_MS
} from "./limits.js";
import { CanvasCommandService } from "./service.js";

type CanvasRoute =
  | { kind: "command"; projectId: string; canvasId: string }
  | { kind: "reconnect"; projectId: string; canvasId: string }
  | { kind: "runtime_status"; projectId: string; canvasId: string }
  | { kind: "forbidden_feature"; feature: string; projectId?: string };

type RateBucket = { windowStartedAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

export type CanvasCommandHttpOptions = {
  service: CanvasCommandService;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  transportAdmission: TransportAdmissionPolicy;
  clock?: () => Date;
};

export function canvasCommandOutcomeHttpStatus(outcome: CanvasCommandOutcome): 200 | 409 | 500 {
  if (outcome.type === "canvas.command.accepted") return 200;
  return outcome.code === "server_error" ? 500 : 409;
}

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

/**
 * Routes only durable canvas command + reconnect APIs.
 * Explicitly rejects directory enum/watch, upload/download, bidirectional sync,
 * billing, and SSH/VPS automation paths under the canvas namespace.
 */
export function routeCanvasCommandHttp(
  request: IncomingMessage,
  pathname: string
): CanvasRoute | undefined {
  const forbidden =
    /^\/api\/v1\/(?:projects\/([^/]+)\/)?(?:fs|files|sync|upload|download|billing|subscription|license|ssh|vps|directory|watch)(?:\/|$)/i.exec(
      pathname
    );
  if (forbidden) {
    return {
      kind: "forbidden_feature",
      feature: pathname,
      projectId: forbidden[1] ? decodeIdentifier(forbidden[1]) : undefined
    };
  }

  const match =
    /^\/api\/v1\/projects\/([^/]+)\/canvases\/([^/]+)\/(?:commands|reconnect|runtime-status)(\/.*)?$/.exec(
      pathname
    );
  if (!match) return undefined;
  const projectId = decodeIdentifier(match[1] ?? "");
  const canvasId = decodeIdentifier(match[2] ?? "");
  if (!projectId || !canvasId) return undefined;
  const isReconnect = pathname.includes("/reconnect");
  if (isReconnect) {
    if (request.method !== "POST") return undefined;
    return { kind: "reconnect", projectId, canvasId };
  }
  if (pathname.includes("/runtime-status")) {
    if (request.method !== "GET") return undefined;
    return { kind: "runtime_status", projectId, canvasId };
  }
  if (request.method !== "POST") return undefined;
  return { kind: "command", projectId, canvasId };
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("canvas_body_content_type");
  }
  const declaredLength = request.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > CANVAS_COMMAND_HTTP_BODY_MAX_BYTES))
  ) {
    throw new Error("canvas_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > CANVAS_COMMAND_HTTP_BODY_MAX_BYTES) throw new Error("canvas_body_too_large");
    chunks.push(bytes);
  }
  try {
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("canvas_body_malformed");
  }
}

function rateLimit(key: string, clock: () => Date): boolean {
  const now = clock().getTime();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= CANVAS_COMMAND_RATE_WINDOW_MS) {
    rateBuckets.set(key, { windowStartedAt: now, count: 1 });
    if (rateBuckets.size > 2_000) {
      for (const [entryKey, entry] of rateBuckets) {
        if (now - entry.windowStartedAt >= CANVAS_COMMAND_RATE_WINDOW_MS)
          rateBuckets.delete(entryKey);
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > CANVAS_COMMAND_RATE_MAX_REQUESTS;
}

export async function handleCanvasCommandHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CanvasCommandHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const routed = routeCanvasCommandHttp(request, url.pathname);
  if (!routed) return false;

  if (routed.kind === "forbidden_feature") {
    respond(response, 404, {
      error: "not_found",
      detail: "canvas_feature_not_supported",
      feature: routed.feature
    });
    return true;
  }

  if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
    respond(response, 400, { error: "insecure_transport" });
    return true;
  }

  const credentialActor = authenticateCollaborationForProject(
    options.repository,
    options.workspaceIdentity,
    request.headers.authorization,
    routed.projectId
  );
  const authenticated = credentialActor
    ? authenticateCollaborationForScope(
        options.repository,
        options.workspaceIdentity,
        options.projectAuthority,
        request.headers.authorization,
        routed.projectId,
        routed.canvasId
      )
    : undefined;
  if (!authenticated) {
    respond(response, 401, {
      type: "canvas.command.rejected",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: routed.projectId,
      canvasId: routed.canvasId,
      operationId: "unauthenticated",
      code: credentialActor ? "forbidden" : "unauthorized"
    });
    return true;
  }
  const context = authenticated.actor;

  const clock = options.clock ?? (() => new Date());
  if (
    rateLimit(
      `${routed.kind}:${context.humanPrincipalId}:${routed.projectId}:${routed.canvasId}`,
      clock
    )
  ) {
    respond(response, 429, {
      type: "canvas.command.rejected",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: routed.projectId,
      canvasId: routed.canvasId,
      operationId: "rate-limited",
      code: "rate_limited"
    });
    return true;
  }

  try {
    if (routed.kind === "runtime_status") {
      const status = await options.service.readRuntimeStatus(context, {
        projectId: routed.projectId,
        canvasId: routed.canvasId
      });
      respond(response, 200, canvasRuntimeStatusProjectionSchema.parse(status));
      return true;
    }
    const body = await readJson(request);
    if (routed.kind === "command") {
      const submit =
        body && typeof body === "object"
          ? {
              ...(body as object),
              type: "canvas.command.submit",
              protocolVersion:
                (body as { protocolVersion?: unknown }).protocolVersion ??
                CANVAS_COMMAND_PROTOCOL_VERSION,
              schemaVersion:
                (body as { schemaVersion?: unknown }).schemaVersion ?? "canvas-command/v1",
              projectId: routed.projectId,
              canvasId: routed.canvasId
            }
          : body;
      const outcome = await options.service.submit(context, submit);
      const status = canvasCommandOutcomeHttpStatus(outcome);
      respond(response, status, canvasCommandOutcomeSchema.parse(outcome));
      return true;
    }

    const reconnectBody =
      body && typeof body === "object"
        ? {
            ...(body as object),
            type: "canvas.reconnect.request",
            protocolVersion:
              (body as { protocolVersion?: unknown }).protocolVersion ??
              CANVAS_COMMAND_PROTOCOL_VERSION,
            schemaVersion:
              (body as { schemaVersion?: unknown }).schemaVersion ?? "canvas-command/v1",
            projectId: routed.projectId,
            canvasId: routed.canvasId
          }
        : body;
    const reconnect = await options.service.reconnect(context, reconnectBody);
    const status = reconnect.type === "canvas.reconnect.error" ? 409 : 200;
    respond(response, status, canvasReconnectResponseSchema.parse(reconnect));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "server_error";
    if (message === "canvas_body_too_large") {
      respond(response, 413, { error: "payload_too_large" });
      return true;
    }
    if (message === "canvas_body_content_type" || message === "canvas_body_malformed") {
      respond(response, 400, { error: "invalid_command" });
      return true;
    }
    if (message.startsWith("canvas_runtime_status_")) {
      const forbidden = message.endsWith("forbidden") || message.endsWith("cross_scope");
      respond(response, forbidden ? 403 : message.endsWith("unknown_canvas") ? 404 : 503, {
        error: message
      });
      return true;
    }
    respond(response, 500, { error: "server_error" });
    return true;
  }
}

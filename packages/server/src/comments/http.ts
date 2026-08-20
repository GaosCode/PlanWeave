import {
  activityListWireQuerySchema,
  commentCreateWireCommandSchema,
  commentEditWireCommandSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema
} from "@planweave-ai/collaboration-protocol/activity/comments";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  authenticateCollaborationForScope,
  authenticateCollaborationForProject,
  hasAuthenticatedCollaborationDevice,
  humanAuthContextSchema,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type CollaborationScopeAuthority
} from "../identity/index.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { BoundedFixedWindowAdmission } from "../httpFixedWindowAdmission.js";
import { CommentService, CommentServiceError } from "./service.js";

const MAX_COMMENT_BODY_BYTES = 262_144;
const COMMENT_RATE_WINDOW_MS = 60_000;
const COMMENT_RATE_MAX_REQUESTS = 120;
const COMMENT_RATE_MAX_BUCKETS = 1_000;
const commentEditHttpBodySchema = commentEditWireCommandSchema.omit({ commentId: true });
const commentTombstoneHttpBodySchema = commentTombstoneWireCommandSchema.omit({ commentId: true });

type CommentHttpRoute =
  | { kind: "list_comments" | "create_comment" | "list_activity"; projectId: string }
  | { kind: "edit_comment" | "tombstone_comment"; projectId: string; commentId: string };

const rateLimiter = new BoundedFixedWindowAdmission<string>({
  windowMs: COMMENT_RATE_WINDOW_MS,
  maxRequests: COMMENT_RATE_MAX_REQUESTS,
  maxBuckets: COMMENT_RATE_MAX_BUCKETS
});

export type CommentActivityHttpOptions = {
  resolveService(workspaceId: string, projectId: string): CommentService | undefined;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  transportAdmission: TransportAdmissionPolicy;
  clock?: () => Date;
};

function commentActor(
  authenticated: NonNullable<ReturnType<typeof authenticateCollaborationForScope>>,
  workspaceIdentity: WorkspaceIdentityRepository
) {
  if (!("kind" in authenticated.actor) || authenticated.actor.kind !== "workspace_device") {
    return authenticated.actor;
  }
  const membership = workspaceIdentity
    .listMembershipViews(authenticated.workspaceId)
    .find(
      (candidate) =>
        candidate.humanPrincipalId === authenticated.actor.humanPrincipalId &&
        candidate.revokedAt === null
    );
  if (!membership) throw new CommentServiceError("comment_auth_forbidden");
  return humanAuthContextSchema.parse({
    humanPrincipalId: authenticated.actor.humanPrincipalId,
    displayName: authenticated.actor.displayName,
    deviceCredentialId: authenticated.actor.deviceSessionId,
    projectId: authenticated.projectId,
    role: membership.role,
    membershipId: membership.membershipId
  });
}

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): CommentHttpRoute | undefined {
  const projectMatch = /^\/api\/v1\/projects\/([^/]+)\/(comments|activity)(\/.*)?$/.exec(pathname);
  if (!projectMatch) return undefined;
  const projectId = decodeIdentifier(projectMatch[1]);
  if (!projectId) return undefined;
  const surface = projectMatch[2];
  const rest = projectMatch[3] ?? "";

  if (surface === "activity" && request.method === "GET" && rest === "") {
    return { kind: "list_activity", projectId };
  }
  if (surface !== "comments") return undefined;
  if (rest === "" && request.method === "GET") return { kind: "list_comments", projectId };
  if (rest === "" && request.method === "POST") return { kind: "create_comment", projectId };

  const tombstone = /^\/([^/]+)\/tombstone$/.exec(rest);
  if (request.method === "POST" && tombstone) {
    const commentId = decodeIdentifier(tombstone[1]);
    return commentId ? { kind: "tombstone_comment", projectId, commentId } : undefined;
  }
  const comment = /^\/([^/]+)$/.exec(rest);
  if (request.method === "PATCH" && comment) {
    const commentId = decodeIdentifier(comment[1]);
    return commentId ? { kind: "edit_comment", projectId, commentId } : undefined;
  }
  return undefined;
}

function isCandidate(pathname: string): boolean {
  return /^\/api\/v1\/projects\/[^/]+\/(comments|activity)(\/|$)/.test(pathname);
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new CommentServiceError("comment_input_invalid", "JSON content type required.");
  }
  const declaredLength = request.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_COMMENT_BODY_BYTES))
  ) {
    throw new Error("comment_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_COMMENT_BODY_BYTES) throw new Error("comment_body_too_large");
    chunks.push(bytes);
  }
  try {
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CommentServiceError("comment_input_invalid", "Malformed JSON body.");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new CommentServiceError("comment_input_invalid", "Invalid query parameters.");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function parseJsonParameter(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new CommentServiceError("comment_input_invalid", "Malformed JSON query parameter.");
  }
}

function rateLimit(humanPrincipalId: string, workspaceId: string, projectId: string, now: number) {
  const key = JSON.stringify([humanPrincipalId, workspaceId, projectId]);
  return rateLimiter.admit(key, now);
}

function statusFor(error: CommentServiceError): number {
  switch (error.code) {
    case "comment_auth_unauthenticated":
      return 401;
    case "comment_auth_forbidden":
    case "comment_auth_project_mismatch":
    case "comment_role_insufficient":
    case "comment_author_required":
    case "comment_not_author":
    case "comment_cross_project_forbidden":
    case "activity_auth_forbidden":
      return 403;
    case "comment_not_found":
    case "comment_work_item_not_found":
      return 404;
    case "comment_revision_conflict":
    case "comment_already_tombstoned":
      return 409;
    case "comment_input_invalid":
    case "comment_attachment_limit":
    case "comment_attachment_size":
    case "comment_attachment_media_type":
    case "activity_input_invalid":
    case "activity_source_duplicate":
      return 400;
  }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "comment_input_invalid" };
  if (error instanceof CommentServiceError) return { status: statusFor(error), code: error.code };
  if (error instanceof Error && error.message === "comment_body_too_large") {
    return { status: 413, code: "comment_body_too_large" };
  }
  return { status: 500, code: "comment_request_failed" };
}

export function resetCommentActivityHttpRateLimits(): void {
  rateLimiter.reset();
}

export async function handleCommentActivityHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CommentActivityHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (isCandidate(url.pathname)) {
      request.resume();
      respond(response, 404, { error: "route_not_found" });
      return true;
    }
    return false;
  }

  try {
    if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
      request.resume();
      respond(response, 426, { error: "human_insecure_transport" });
      return true;
    }
    const credentialActor = authenticateCollaborationForProject(
      options.repository,
      options.workspaceIdentity,
      request.headers.authorization,
      matched.projectId
    );
    if (
      !credentialActor &&
      !hasAuthenticatedCollaborationDevice(
        options.repository,
        options.workspaceIdentity,
        request.headers.authorization
      )
    ) {
      throw new CommentServiceError("comment_auth_unauthenticated");
    }
    const authenticated = authenticateCollaborationForScope(
      options.repository,
      options.workspaceIdentity,
      options.collaborationScopeAuthority,
      request.headers.authorization,
      matched.projectId
    );
    if (!authenticated) throw new CommentServiceError("comment_cross_project_forbidden");
    const now = (options.clock ?? (() => new Date()))().getTime();
    const admission = rateLimit(
      authenticated.actor.humanPrincipalId,
      authenticated.workspaceId,
      matched.projectId,
      now
    );
    if (!admission.allowed) {
      request.resume();
      respond(
        response,
        429,
        { error: "comment_rate_limited" },
        { "retry-after": String(admission.retryAfterSeconds) }
      );
      return true;
    }
    const actor = commentActor(authenticated, options.workspaceIdentity);
    const service = options.resolveService(authenticated.workspaceId, matched.projectId);
    if (!service) throw new CommentServiceError("comment_cross_project_forbidden");

    switch (matched.kind) {
      case "create_comment": {
        query(url, []);
        const body = commentCreateWireCommandSchema.parse(await readJson(request));
        respond(
          response,
          201,
          service.createComment({ ...body, actor, projectId: matched.projectId }).display
        );
        return true;
      }
      case "edit_comment": {
        query(url, []);
        const parsedBody = commentEditHttpBodySchema.parse(await readJson(request));
        const body = commentEditWireCommandSchema.parse({
          ...parsedBody,
          commentId: matched.commentId
        });
        respond(
          response,
          200,
          service.editComment({ ...body, actor, projectId: matched.projectId }).display
        );
        return true;
      }
      case "tombstone_comment": {
        query(url, []);
        const parsedBody = commentTombstoneHttpBodySchema.parse(await readJson(request));
        const body = commentTombstoneWireCommandSchema.parse({
          ...parsedBody,
          commentId: matched.commentId
        });
        respond(
          response,
          200,
          service.tombstoneComment({ ...body, actor, projectId: matched.projectId }).display
        );
        return true;
      }
      case "list_comments": {
        const parameters = query(url, ["workItem", "limit", "cursor", "includeTombstoned"]);
        if (
          parameters.includeTombstoned !== undefined &&
          parameters.includeTombstoned !== "true" &&
          parameters.includeTombstoned !== "false"
        ) {
          throw new CommentServiceError("comment_input_invalid");
        }
        const wire = commentListWireQuerySchema.parse({
          workItem: parseJsonParameter(parameters.workItem),
          ...(parameters.limit === undefined ? {} : { limit: Number(parameters.limit) }),
          ...(parameters.cursor === undefined
            ? {}
            : { cursor: parseJsonParameter(parameters.cursor) }),
          ...(parameters.includeTombstoned === undefined
            ? {}
            : { includeTombstoned: parameters.includeTombstoned === "true" })
        });
        respond(
          response,
          200,
          service.listComments({ ...wire, actor, projectId: matched.projectId })
        );
        return true;
      }
      case "list_activity": {
        const parameters = query(url, ["workItem", "limit", "cursor"]);
        const wire = activityListWireQuerySchema.parse({
          ...(parameters.workItem === undefined
            ? {}
            : { workItem: parseJsonParameter(parameters.workItem) }),
          ...(parameters.limit === undefined ? {} : { limit: Number(parameters.limit) }),
          ...(parameters.cursor === undefined
            ? {}
            : { cursor: parseJsonParameter(parameters.cursor) })
        });
        respond(
          response,
          200,
          service.listActivity({ ...wire, actor, projectId: matched.projectId })
        );
        return true;
      }
    }
  } catch (error) {
    const safe = safeError(error);
    request.resume();
    respond(response, safe.status, { error: safe.code });
    return true;
  }
}

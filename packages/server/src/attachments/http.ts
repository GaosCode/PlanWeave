import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { finalizePendingAttachmentRequestSchema } from "@planweave-ai/collaboration-protocol/activity/attachments";
import {
  commentAttachmentFileNameSchema,
  commentAttachmentMediaTypeSchema,
  commentAttachmentSizeBytesSchema,
  commentContentSha256Schema,
  commentIdSchema,
  pendingUploadTtlMsSchema
} from "../comments/schemas.js";
import {
  authenticateCollaborationForScope,
  humanTransportAllowed,
  workspaceDeviceSessionHumanContext,
  type HumanIdentityRepository,
  type CollaborationScopeAuthority,
  type WorkspaceIdentityRepository
} from "../identity/index.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import { attachmentErrorCodeSchema, type AttachmentErrorCode } from "./errors.js";
import { CommentAttachmentService, CommentAttachmentServiceError } from "./service.js";

export type AttachmentHttpOptions = {
  service: CommentAttachmentService;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  transportAdmission: TransportAdmissionPolicy;
  clock?: () => Date;
};

type AttachmentRoute =
  | { kind: "create_pending"; projectId: string }
  | { kind: "upload_pending"; projectId: string; pendingUploadId: string }
  | { kind: "finalize_pending"; projectId: string; pendingUploadId: string }
  | { kind: "read_pending"; projectId: string; pendingUploadId: string }
  | { kind: "read_digest"; projectId: string; digestSha256: string }
  | {
      kind: "read_comment_attachment";
      projectId: string;
      commentId: string;
      digestSha256: string;
    }
  | { kind: "cleanup"; projectId: string };

const createPendingBodySchema = z
  .object({
    expectedSizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional(),
    expectedDigestSha256: commentContentSha256Schema.optional(),
    commentId: commentIdSchema.optional(),
    ttlMs: pendingUploadTtlMsSchema.optional()
  })
  .strict();

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function decodeDigest(value: string): string | undefined {
  try {
    return commentContentSha256Schema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function pathnameOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://planweave.invalid").pathname;
}

function route(request: IncomingMessage, pathname: string): AttachmentRoute | undefined {
  const match = /^\/api\/v1\/projects\/([^/]+)\/attachments(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  const projectId = decodeIdentifier(match[1]);
  if (!projectId) return undefined;
  const rest = match[2] ?? "";

  if (request.method === "POST" && rest === "/pending") {
    return { kind: "create_pending", projectId };
  }
  if (request.method === "POST" && rest === "/cleanup") {
    return { kind: "cleanup", projectId };
  }

  const pendingUpload = /^\/pending\/([^/]+)$/.exec(rest);
  if (pendingUpload) {
    const pendingUploadId = decodeIdentifier(pendingUpload[1]);
    if (!pendingUploadId) return undefined;
    if (request.method === "PUT") {
      return { kind: "upload_pending", projectId, pendingUploadId };
    }
    if (request.method === "GET") {
      return { kind: "read_pending", projectId, pendingUploadId };
    }
  }

  const finalize = /^\/pending\/([^/]+)\/finalize$/.exec(rest);
  if (request.method === "POST" && finalize) {
    const pendingUploadId = decodeIdentifier(finalize[1]);
    if (!pendingUploadId) return undefined;
    return { kind: "finalize_pending", projectId, pendingUploadId };
  }

  const byDigest = /^\/by-digest\/([a-f0-9]{64})$/.exec(rest);
  if (request.method === "GET" && byDigest) {
    const digestSha256 = decodeDigest(byDigest[1]);
    if (!digestSha256) return undefined;
    return { kind: "read_digest", projectId, digestSha256 };
  }

  const commentAttachment = /^\/comments\/([^/]+)\/([a-f0-9]{64})$/.exec(rest);
  if (request.method === "GET" && commentAttachment) {
    const commentId = decodeIdentifier(commentAttachment[1]);
    const digestSha256 = decodeDigest(commentAttachment[2]);
    if (!commentId || !digestSha256) return undefined;
    return { kind: "read_comment_attachment", projectId, commentId, digestSha256 };
  }

  return undefined;
}

function isAttachmentApiCandidate(pathname: string): boolean {
  return pathname.startsWith("/api/v1/projects/") && pathname.includes("/attachments");
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

function safeDownloadHeaders(input: {
  mediaType: string;
  sizeBytes: number;
  fileName?: string;
  digestSha256: string;
}): Record<string, string | number> {
  const dispositionName = sanitizeContentDispositionFileName(input.fileName);
  return {
    "content-type": input.mediaType,
    "content-length": input.sizeBytes,
    "content-disposition": `attachment; filename="${dispositionName}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-frame-options": "DENY",
    "cache-control": "private, no-store",
    etag: `"sha256:${input.digestSha256}"`
  };
}

function sanitizeContentDispositionFileName(fileName: string | undefined): string {
  if (!fileName) return "attachment";
  // RFC 5987-ish fallback: strip quotes/control and path separators.
  const cleaned = fileName.replace(/["\\\r\n]/g, "_").replace(/[\\/]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 255) : "attachment";
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new CommentAttachmentServiceError("attachment_input_invalid");
  }
  const declaredLength = request.headers["content-length"];
  if (Array.isArray(declaredLength)) {
    throw new CommentAttachmentServiceError("attachment_input_invalid");
  }
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new CommentAttachmentServiceError("attachment_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new CommentAttachmentServiceError("attachment_too_large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CommentAttachmentServiceError("attachment_input_invalid");
  }
}

function httpStatusForCode(code: AttachmentErrorCode): number {
  switch (code) {
    case "attachment_auth_unauthenticated":
      return 401;
    case "attachment_auth_forbidden":
    case "attachment_auth_project_mismatch":
    case "attachment_role_insufficient":
    case "attachment_pending_not_uploader":
    case "attachment_cross_project_forbidden":
      return 403;
    case "attachment_not_found":
    case "attachment_pending_not_found":
    case "attachment_comment_not_found":
      return 404;
    case "attachment_pending_expired":
    case "attachment_status_conflict":
      return 409;
    case "attachment_input_invalid":
    case "attachment_digest_mismatch":
    case "attachment_size_mismatch":
    case "attachment_media_type":
      return 400;
    case "attachment_size_limit":
    case "attachment_too_large":
      return 413;
    default: {
      const _exhaustive: never = code;
      return 500;
    }
  }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) {
    return { status: 400, code: "attachment_input_invalid" };
  }
  if (error instanceof CommentAttachmentServiceError) {
    const code = attachmentErrorCodeSchema.parse(error.code);
    return { status: httpStatusForCode(code), code };
  }
  return { status: 500, code: "attachment_request_failed" };
}

function headerSingle(value: string | string[] | undefined, code: AttachmentErrorCode): string {
  if (Array.isArray(value) || !value) {
    throw new CommentAttachmentServiceError(code);
  }
  return value;
}

/**
 * Human-authenticated comment attachment HTTP surface.
 * Host tokens, dispatch grants, and bare digests never authorize these routes.
 */
export async function handleCommentAttachmentHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AttachmentHttpOptions
): Promise<boolean> {
  const pathname = pathnameOf(request);
  const matched = route(request, pathname);
  if (!matched) {
    if (isAttachmentApiCandidate(pathname)) {
      respondJson(response, 404, { error: "attachment_route_not_found" });
      return true;
    }
    return false;
  }

  if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
    respondJson(response, 403, { error: "attachment_auth_forbidden" });
    request.resume();
    return true;
  }
  try {
    const authenticated = authenticateCollaborationForScope(
      options.repository,
      options.workspaceIdentity,
      options.collaborationScopeAuthority,
      request.headers.authorization,
      matched.projectId
    );
    if (!authenticated) {
      respondJson(response, 401, { error: "attachment_auth_unauthenticated" });
      request.resume();
      return true;
    }
    const actor = workspaceDeviceSessionHumanContext(
      authenticated.actor,
      options.workspaceIdentity
    );
    if (!actor) {
      respondJson(response, 401, { error: "attachment_auth_unauthenticated" });
      request.resume();
      return true;
    }
    const workspaceId = authenticated.workspaceId;

    switch (matched.kind) {
      case "create_pending": {
        const body = createPendingBodySchema.parse(await readJson(request, 16_384));
        const record = options.service.createPendingUpload({
          actor,
          workspaceId,
          projectId: matched.projectId,
          ...body
        });
        respondJson(response, 201, {
          pendingUploadId: record.pendingUploadId,
          projectId: record.projectId,
          expectedSizeBytes: record.expectedSizeBytes,
          mediaType: record.mediaType,
          fileName: record.fileName,
          expectedDigestSha256: record.expectedDigestSha256,
          commentId: record.commentId,
          status: record.status,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt
        });
        return true;
      }
      case "upload_pending": {
        const contentLengthText = headerSingle(
          request.headers["content-length"],
          "attachment_input_invalid"
        );
        if (!/^\d+$/.test(contentLengthText)) {
          throw new CommentAttachmentServiceError("attachment_input_invalid");
        }
        const contentLength = Number(contentLengthText);
        const mediaType = commentAttachmentMediaTypeSchema.parse(
          headerSingle(request.headers["content-type"], "attachment_input_invalid")
            .split(";")[0]
            ?.trim()
        );
        const declaredDigestHeader = request.headers["x-planweave-content-sha256"];
        const declaredDigestSha256 =
          declaredDigestHeader === undefined
            ? undefined
            : commentContentSha256Schema.parse(
                headerSingle(declaredDigestHeader, "attachment_input_invalid")
              );

        const record = await options.service.uploadBody({
          actor,
          workspaceId,
          projectId: matched.projectId,
          pendingUploadId: matched.pendingUploadId,
          declaredDigestSha256,
          contentLength,
          mediaType,
          chunks: request
        });
        respondJson(response, 201, {
          pendingUploadId: record.pendingUploadId,
          status: record.status,
          digestSha256: record.digestSha256,
          sizeBytes: record.expectedSizeBytes,
          mediaType: record.mediaType,
          uploadedAt: record.uploadedAt
        });
        return true;
      }
      case "finalize_pending": {
        const body = finalizePendingAttachmentRequestSchema.parse(await readJson(request, 16_384));

        const result = options.service.finalize({
          actor,
          workspaceId,
          projectId: matched.projectId,
          pendingUploadId: matched.pendingUploadId,
          expectedDigestSha256: body.expectedDigestSha256
        });
        respondJson(response, 200, {
          pendingUploadId: result.record.pendingUploadId,
          status: "finalized",
          digestSha256: result.metadata.digestSha256,
          sizeBytes: result.metadata.sizeBytes,
          mediaType: result.metadata.mediaType,
          fileName: result.metadata.fileName
        });
        return true;
      }
      case "read_pending": {
        const opened = await options.service.openPendingRead({
          actor,
          workspaceId,
          projectId: matched.projectId,
          pendingUploadId: matched.pendingUploadId
        });
        response.writeHead(
          200,
          safeDownloadHeaders({
            mediaType: opened.metadata.mediaType,
            sizeBytes: opened.metadata.sizeBytes,
            fileName: opened.metadata.fileName,
            digestSha256: opened.metadata.digestSha256
          })
        );
        opened.stream.on("error", () => response.destroy());
        opened.stream.pipe(response);
        return true;
      }
      case "read_digest": {
        const opened = await options.service.openDigestRead({
          actor,
          workspaceId,
          projectId: matched.projectId,
          digestSha256: matched.digestSha256
        });
        response.writeHead(
          200,
          safeDownloadHeaders({
            mediaType: opened.mediaType,
            sizeBytes: opened.sizeBytes,
            digestSha256: opened.digestSha256
          })
        );
        opened.stream.on("error", () => response.destroy());
        opened.stream.pipe(response);
        return true;
      }
      case "read_comment_attachment": {
        const opened = await options.service.openCommentAttachmentRead({
          actor,
          workspaceId,
          projectId: matched.projectId,
          commentId: matched.commentId,
          digestSha256: matched.digestSha256
        });
        response.writeHead(
          200,
          safeDownloadHeaders({
            mediaType: opened.binding.mediaType,
            sizeBytes: opened.binding.sizeBytes,
            fileName: opened.binding.fileName,
            digestSha256: opened.binding.digestSha256
          })
        );
        opened.stream.on("error", () => response.destroy());
        opened.stream.pipe(response);
        return true;
      }
      case "cleanup": {
        const authActor = actor;
        if (authActor.projectId !== matched.projectId) {
          respondJson(response, 403, { error: "attachment_auth_project_mismatch" });
          return true;
        }
        const result = await options.service.cleanupExpiredStaged(workspaceId, matched.projectId);
        respondJson(response, 200, result);
        return true;
      }
      default: {
        const _exhaustive: never = matched;
        respondJson(response, 404, { error: "attachment_route_not_found" });
        return true;
      }
    }
  } catch (error) {
    const safe = safeError(error);
    respondJson(response, safe.status, { error: safe.code });
    request.resume();
    return true;
  }
}

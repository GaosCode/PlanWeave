import { cancelHttpBody } from "../httpResponseBody.js";
import { createHash } from "node:crypto";
import {
  authoritativeContentVersionSchema,
  compareContentVersionMemberPaths,
  type AuthoritativeContentVersion,
  type CompletedContentVersionRef,
  type ContentVersionMember
} from "@planweave-ai/collaboration-protocol/content/version";
import { CONTENT_VERSION_MAX_TOTAL_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  contentVersionTransferCompleteFrameSchema,
  contentVersionTransferFrameSchema,
  contentVersionTransferHeaderFrameSchema,
  contentVersionTransferLimits,
  contentVersionTransferMediaType
} from "@planweave-ai/collaboration-protocol/content/transfer";
import { type CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { CollaborationClientError, collaborationErrorFromHttp } from "./collaborationErrors.js";
import { CollaborationHttpTransport } from "./collaborationHttpTransport.js";

function protocolError(code: string, cause?: unknown): CollaborationClientError {
  return new CollaborationClientError({
    kind: "protocol",
    code,
    message: code,
    ...(cause === undefined ? {} : { cause })
  });
}

function validateMember(member: ContentVersionMember, previousPath: string | undefined): void {
  if (
    previousPath !== undefined &&
    compareContentVersionMemberPaths(previousPath, member.path) >= 0
  ) {
    throw protocolError("content_transfer_member_order_invalid");
  }
  const sizeBytes = Buffer.byteLength(member.content, "utf8");
  if (sizeBytes !== member.sizeBytes) throw protocolError("content_transfer_member_size_invalid");
  const digest = createHash("sha256").update(member.content, "utf8").digest("hex");
  if (digest !== member.digestSha256) throw protocolError("content_transfer_member_digest_invalid");
}

async function* ndjsonFrames(response: Response) {
  if (!response.body) throw protocolError("content_transfer_body_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let wireBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      wireBytes += next.value.byteLength;
      if (wireBytes > contentVersionTransferLimits.maxWireBytes) {
        throw protocolError("content_transfer_wire_too_large");
      }
      pending += decoder.decode(next.value, { stream: true });
      while (true) {
        const lineEnd = pending.indexOf("\n");
        if (lineEnd < 0) break;
        const line = pending.slice(0, lineEnd);
        pending = pending.slice(lineEnd + 1);
        if (line.length === 0) throw protocolError("content_transfer_empty_frame");
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > contentVersionTransferLimits.maxFrameBytes) {
          throw protocolError("content_transfer_frame_too_large");
        }
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (error) {
          throw protocolError("content_transfer_frame_invalid", error);
        }
        try {
          yield contentVersionTransferFrameSchema.parse(raw);
        } catch (error) {
          throw protocolError("content_transfer_frame_schema_invalid", error);
        }
      }
      if (Buffer.byteLength(pending, "utf8") > contentVersionTransferLimits.maxFrameBytes) {
        throw protocolError("content_transfer_frame_too_large");
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) throw protocolError("content_transfer_frame_unterminated");
  } catch (error) {
    cancelHttpBody(reader, error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Dedicated immutable-content transfer client; generic collaboration JSON limits never apply here. */
export async function fetchContentVersionTransfer(input: {
  transport: CollaborationHttpTransport;
  scope: CanvasScopeRef;
  content: CompletedContentVersionRef;
}): Promise<AuthoritativeContentVersion> {
  const stream = await input.transport.openStream(
    "POST",
    `/api/v1/projects/${encodeURIComponent(input.scope.projectId)}/canvases/${encodeURIComponent(input.scope.canvasId)}/content/fetch`,
    { body: { content: input.content }, accept: contentVersionTransferMediaType }
  );
  const { response } = stream;
  try {
    if (!response.ok) {
      const text = await input.transport.readBoundedError(response);
      throw collaborationErrorFromHttp(response.status, text, response.headers.get("retry-after"));
    }
    const declaredType = response.headers.get("content-type") ?? "";
    const mediaType = declaredType.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== contentVersionTransferMediaType) {
      if (response.body) cancelHttpBody(response.body);
      throw protocolError("content_transfer_media_type_invalid");
    }
    let header: ReturnType<typeof contentVersionTransferHeaderFrameSchema.parse> | undefined;
    const members: ContentVersionMember[] = [];
    let previousPath: string | undefined;
    let totalBytes = 0;
    let completed = false;
    for await (const frame of ndjsonFrames(response)) {
      if (frame.type === "header") {
        if (header || members.length > 0 || completed)
          throw protocolError("content_transfer_header_order_invalid");
        header = contentVersionTransferHeaderFrameSchema.parse(frame);
        if (
          header.scope.workspaceId !== input.scope.workspaceId ||
          header.scope.projectId !== input.scope.projectId ||
          header.scope.canvasId !== input.scope.canvasId ||
          header.completed.versionId !== input.content.versionId ||
          header.canonicalDigest !== input.content.canonicalDigest
        ) {
          throw protocolError("content_transfer_authority_mismatch");
        }
        continue;
      }
      if (!header) throw protocolError("content_transfer_header_missing");
      if (frame.type === "member") {
        if (completed || frame.index !== members.length)
          throw protocolError("content_transfer_member_order_invalid");
        validateMember(frame.member, previousPath);
        totalBytes += frame.member.sizeBytes;
        if (
          totalBytes > CONTENT_VERSION_MAX_TOTAL_BYTES ||
          totalBytes > header.totalBytes ||
          members.length >= header.memberCount
        ) {
          throw protocolError("content_transfer_total_bytes_invalid");
        }
        members.push(frame.member);
        previousPath = frame.member.path;
        continue;
      }
      if (completed) throw protocolError("content_transfer_complete_duplicate");
      const complete = contentVersionTransferCompleteFrameSchema.parse(frame);
      if (
        complete.canonicalDigest !== header.canonicalDigest ||
        complete.totalBytes !== header.totalBytes ||
        complete.memberCount !== header.memberCount ||
        members.length !== header.memberCount ||
        totalBytes !== header.totalBytes
      ) {
        throw protocolError("content_transfer_complete_invalid");
      }
      completed = true;
    }
    if (!header || !completed) throw protocolError("content_transfer_incomplete");
    try {
      return authoritativeContentVersionSchema.parse({
        schemaVersion: header.schemaVersion,
        scope: header.scope,
        content: {
          members,
          canonicalDigest: header.canonicalDigest,
          totalBytes: header.totalBytes
        },
        completed: header.completed,
        createdAt: header.createdAt,
        createdBy: header.createdBy
      });
    } catch (error) {
      throw protocolError("content_transfer_authoritative_envelope_invalid", error);
    }
  } catch (error) {
    if (stream.timedOut()) {
      throw new CollaborationClientError({
        kind: "timeout",
        code: "collaboration_timeout",
        message: "Collaboration request timed out.",
        retryable: true,
        cause: error
      });
    }
    throw error;
  } finally {
    stream.release();
  }
}

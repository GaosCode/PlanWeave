import { createHash } from "node:crypto";
import {
  authoritativeContentVersionSchema,
  compareContentVersionMemberPaths,
  type AuthoritativeContentVersion,
  type CanvasRuntimeContentTarget,
  type ContentVersionMember
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  contentVersionTransferCompleteFrameSchema,
  contentVersionTransferFrameSchema,
  contentVersionTransferHeaderFrameSchema,
  contentVersionTransferLimits,
  contentVersionTransferMediaType
} from "@planweave-ai/collaboration-protocol/content/transfer";
import { CONTENT_VERSION_MAX_TOTAL_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import type { CanvasRuntimeLogicalScope } from "@planweave-ai/agent-host-protocol";

export interface CanvasRuntimeContentTransferPort {
  updateCredentialToken(token: string): void;
  fetch(
    scope: CanvasRuntimeLogicalScope,
    target: CanvasRuntimeContentTarget,
    signal: AbortSignal
  ): Promise<AuthoritativeContentVersion>;
}

export class CanvasRuntimeContentTransfer implements CanvasRuntimeContentTransferPort {
  private token: string;

  constructor(
    private readonly options: {
      baseUrl: URL;
      hostId: string;
      token: string;
      request?: typeof fetch;
    }
  ) {
    this.token = options.token;
  }

  updateCredentialToken(token: string): void {
    if (token.length === 0) throw new Error("host_credential_invalid");
    this.token = token;
  }

  async fetch(
    scope: CanvasRuntimeLogicalScope,
    target: CanvasRuntimeContentTarget,
    signal: AbortSignal
  ): Promise<AuthoritativeContentVersion> {
    const url = new URL(this.options.baseUrl.origin);
    url.pathname =
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}/canvas-runtime/content/` +
      `${encodeURIComponent(scope.projectId)}/${encodeURIComponent(scope.canvasId)}/` +
      `${encodeURIComponent(target.content.versionId)}`;
    url.searchParams.set("workspaceId", scope.workspaceId);
    url.searchParams.set("canonicalDigest", target.content.canonicalDigest);
    const response = await (this.options.request ?? fetch)(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: contentVersionTransferMediaType
      },
      signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`runtime_content_download_failed_${response.status}`);
    }
    if (
      (response.headers.get("content-type") ?? "").split(";", 1)[0] !==
      contentVersionTransferMediaType
    ) {
      await response.body?.cancel();
      throw new Error("runtime_content_media_type_invalid");
    }
    return this.readTransfer(response, scope, target);
  }

  private async readTransfer(
    response: Response,
    scope: CanvasRuntimeLogicalScope,
    target: CanvasRuntimeContentTarget
  ): Promise<AuthoritativeContentVersion> {
    if (!response.body) throw new Error("runtime_content_body_missing");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let wireBytes = 0;
    let header: ReturnType<typeof contentVersionTransferHeaderFrameSchema.parse> | undefined;
    const members: ContentVersionMember[] = [];
    let previousPath: string | undefined;
    let totalBytes = 0;
    let complete = false;
    const consume = (line: string) => {
      if (Buffer.byteLength(line, "utf8") > contentVersionTransferLimits.maxFrameBytes) {
        throw new Error("runtime_content_frame_too_large");
      }
      const frame = contentVersionTransferFrameSchema.parse(JSON.parse(line));
      if (frame.type === "header") {
        if (header || members.length > 0) throw new Error("runtime_content_header_order_invalid");
        header = contentVersionTransferHeaderFrameSchema.parse(frame);
        if (
          header.scope.workspaceId !== scope.workspaceId ||
          header.scope.projectId !== scope.projectId ||
          header.scope.canvasId !== scope.canvasId ||
          header.completed.versionId !== target.content.versionId ||
          header.canonicalDigest !== target.content.canonicalDigest
        )
          throw new Error("runtime_content_authority_mismatch");
        return;
      }
      if (!header) throw new Error("runtime_content_header_missing");
      if (frame.type === "member") {
        if (complete || frame.index !== members.length)
          throw new Error("runtime_content_member_order_invalid");
        if (
          previousPath &&
          compareContentVersionMemberPaths(previousPath, frame.member.path) >= 0
        ) {
          throw new Error("runtime_content_member_order_invalid");
        }
        const size = Buffer.byteLength(frame.member.content, "utf8");
        const digest = createHash("sha256").update(frame.member.content, "utf8").digest("hex");
        if (size !== frame.member.sizeBytes || digest !== frame.member.digestSha256) {
          throw new Error("runtime_content_member_integrity_invalid");
        }
        totalBytes += size;
        if (totalBytes > CONTENT_VERSION_MAX_TOTAL_BYTES || totalBytes > header.totalBytes) {
          throw new Error("runtime_content_total_bytes_invalid");
        }
        members.push(frame.member);
        previousPath = frame.member.path;
        return;
      }
      const end = contentVersionTransferCompleteFrameSchema.parse(frame);
      if (
        complete ||
        end.canonicalDigest !== header.canonicalDigest ||
        end.totalBytes !== header.totalBytes ||
        end.memberCount !== header.memberCount ||
        members.length !== header.memberCount ||
        totalBytes !== header.totalBytes
      )
        throw new Error("runtime_content_transfer_incomplete");
      complete = true;
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        wireBytes += next.value.byteLength;
        if (wireBytes > contentVersionTransferLimits.maxWireBytes)
          throw new Error("runtime_content_wire_too_large");
        pending += decoder.decode(next.value, { stream: true });
        let lineEnd = pending.indexOf("\n");
        while (lineEnd >= 0) {
          const line = pending.slice(0, lineEnd);
          pending = pending.slice(lineEnd + 1);
          if (!line) throw new Error("runtime_content_empty_frame");
          consume(line);
          lineEnd = pending.indexOf("\n");
        }
      }
      pending += decoder.decode();
      if (pending || !header || !complete) throw new Error("runtime_content_transfer_incomplete");
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
      await reader.cancel(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

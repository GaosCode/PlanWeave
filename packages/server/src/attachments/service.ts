import { createHash } from "node:crypto";
import { ZodError } from "zod";
import {
  commentAttachmentInputSchema,
  commentAttachmentMediaTypeSchema,
  commentContentSha256Schema,
  pendingAttachmentUploadIdSchema,
  type CommentAttachmentInput,
  type CommentAttachmentMetadata
} from "../comments/schemas.js";
import { humanProjectIdSchema, type HumanAuthContext } from "../identity/schemas.js";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  ATTACHMENT_ERROR_MESSAGES,
  attachmentErrorCodeSchema,
  type AttachmentErrorCode
} from "./errors.js";
import { CommentAttachmentBlobStore } from "./blobStore.js";
import {
  authorizeAttachmentProjectAccess,
  authorizeCommentAttachmentRead,
  authorizeDigestScopedRead,
  authorizePendingUploadMutation,
  authorizePendingUploadRead,
  evaluateAttachmentMediaAndSize,
  evaluatePendingUploadTtlMs,
  humanSubject,
  resolvePendingUploadTtlMs,
  type CommentAttachmentBinding,
  type PendingUploadRecord
} from "./policy.js";
import { AttachmentRepositoryError, CommentAttachmentRepository } from "./repository.js";
import type { HumanIdentityRepository } from "../identity/repository.js";

export class CommentAttachmentServiceError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string = ATTACHMENT_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "CommentAttachmentServiceError";
  }
}

function deny(code: AttachmentErrorCode, message?: string): never {
  throw new CommentAttachmentServiceError(code, message ?? ATTACHMENT_ERROR_MESSAGES[code]);
}

function mapUnknown(error: unknown): never {
  if (error instanceof CommentAttachmentServiceError) throw error;
  if (error instanceof AttachmentRepositoryError) {
    throw new CommentAttachmentServiceError(error.code, error.message);
  }
  if (error instanceof ZodError) {
    throw new CommentAttachmentServiceError("attachment_input_invalid");
  }
  if (error instanceof Error) {
    const code = attachmentErrorCodeSchema.safeParse(error.message);
    if (code.success) {
      throw new CommentAttachmentServiceError(code.data);
    }
    if (error.message === "attachment_write_stalled") {
      throw new CommentAttachmentServiceError("attachment_input_invalid");
    }
    if (
      error.message === "attachment_blob_conflict" ||
      error.message === "attachment_blob_size_mismatch" ||
      error.message === "attachment_blob_digest_mismatch" ||
      error.message === "attachment_path_escape"
    ) {
      throw new CommentAttachmentServiceError("attachment_input_invalid", error.message);
    }
  }
  throw error;
}

export type CommentAttachmentServiceOptions = {
  repository: CommentAttachmentRepository;
  blobs: CommentAttachmentBlobStore;
  identity: HumanIdentityRepository;
  clock?: () => Date;
};

export class CommentAttachmentService {
  private readonly clock: () => Date;

  constructor(private readonly options: CommentAttachmentServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  private sameHumanPrincipal(left: string, right: string): boolean {
    return this.options.identity.areEquivalent(left, right);
  }

  createPendingUpload(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    expectedSizeBytes: number;
    mediaType: string;
    fileName?: string;
    expectedDigestSha256?: string;
    commentId?: string;
    ttlMs?: number;
  }): PendingUploadRecord {
    try {
      const subject = humanSubject(input.actor);
      const auth = authorizeAttachmentProjectAccess({
        subject,
        projectId: input.projectId
      });
      if (!auth.allowed) deny(auth.code, auth.message);

      if (input.actor.projectId !== input.projectId) {
        deny("attachment_auth_project_mismatch");
      }

      const bounds = evaluateAttachmentMediaAndSize({
        sizeBytes: input.expectedSizeBytes,
        mediaType: input.mediaType
      });
      if (!bounds.allowed) deny(bounds.code, bounds.message);

      const ttlCheck = evaluatePendingUploadTtlMs(input.ttlMs);
      if (!ttlCheck.allowed) deny(ttlCheck.code, ttlCheck.message);

      if (input.expectedDigestSha256 !== undefined) {
        commentContentSha256Schema.parse(input.expectedDigestSha256);
      }

      const now = this.clock();
      const workspaceId = workspaceIdSchema.parse(input.workspaceId);
      const ttlMs = resolvePendingUploadTtlMs(input.ttlMs);
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

      return this.options.repository.createPendingUpload({
        workspaceId,
        projectId: input.projectId,
        uploaderHumanPrincipalId: input.actor.humanPrincipalId,
        expectedSizeBytes: input.expectedSizeBytes,
        mediaType: commentAttachmentMediaTypeSchema.parse(input.mediaType),
        fileName: input.fileName,
        expectedDigestSha256: input.expectedDigestSha256,
        commentId: input.commentId,
        createdAt,
        expiresAt
      });
    } catch (error) {
      mapUnknown(error);
    }
  }

  async uploadBody(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    pendingUploadId: string;
    declaredDigestSha256?: string;
    contentLength: number;
    mediaType: string;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<PendingUploadRecord> {
    try {
      const subject = humanSubject(input.actor);
      if (input.actor.projectId !== input.projectId) {
        deny("attachment_auth_project_mismatch");
      }

      const record = this.options.repository.getPendingRequired(
        input.workspaceId,
        input.projectId,
        input.pendingUploadId
      );
      const auth = authorizePendingUploadMutation({
        subject,
        projectId: input.projectId,
        record,
        now: this.clock(),
        requiredStatus: ["pending"],
        sameHumanPrincipal: (left, right) => this.sameHumanPrincipal(left, right)
      });
      if (!auth.allowed) deny(auth.code, auth.message);

      if (input.contentLength !== record.expectedSizeBytes) {
        deny("attachment_size_mismatch");
      }
      const mediaType = commentAttachmentMediaTypeSchema.parse(input.mediaType);
      if (mediaType !== record.mediaType) {
        deny("attachment_media_type");
      }

      // Prefer streaming put when a digest is known up front (header or pending expectation).
      // If neither is set, buffer once within the attachment size budget, hash, then put.
      let chunks: AsyncIterable<Uint8Array>;
      let digest: string;

      if (input.declaredDigestSha256 !== undefined || record.expectedDigestSha256 !== undefined) {
        digest = commentContentSha256Schema.parse(
          input.declaredDigestSha256 ?? record.expectedDigestSha256
        );
        if (
          input.declaredDigestSha256 !== undefined &&
          record.expectedDigestSha256 !== undefined &&
          input.declaredDigestSha256 !== record.expectedDigestSha256
        ) {
          deny("attachment_digest_mismatch");
        }
        chunks = input.chunks;
      } else {
        const buffered = await collectBounded(
          input.chunks,
          record.expectedSizeBytes,
          this.options.blobs.maxBytes
        );
        digest = createHash("sha256").update(buffered).digest("hex");
        chunks = (async function* () {
          yield buffered;
        })();
      }

      await this.options.blobs.put({
        expectedSha256: digest,
        expectedSizeBytes: record.expectedSizeBytes,
        mediaType,
        chunks
      });

      return this.options.repository.markUploaded({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        pendingUploadId: input.pendingUploadId,
        digestSha256: digest,
        sizeBytes: record.expectedSizeBytes,
        mediaType,
        uploadedAt: this.clock().toISOString()
      });
    } catch (error) {
      mapUnknown(error);
    }
  }

  finalize(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    pendingUploadId: string;
    expectedDigestSha256?: string;
  }): { record: PendingUploadRecord; metadata: CommentAttachmentMetadata } {
    try {
      const pendingUploadId = pendingAttachmentUploadIdSchema.parse(input.pendingUploadId);
      const expectedDigestSha256 =
        input.expectedDigestSha256 === undefined
          ? undefined
          : commentContentSha256Schema.parse(input.expectedDigestSha256);
      const subject = humanSubject(input.actor);
      if (input.actor.projectId !== input.projectId) {
        deny("attachment_auth_project_mismatch");
      }

      const record = this.options.repository.getPendingRequired(
        input.workspaceId,
        input.projectId,
        pendingUploadId
      );
      const auth = authorizePendingUploadMutation({
        subject,
        projectId: input.projectId,
        record,
        now: this.clock(),
        requiredStatus: ["uploaded", "finalized"],
        sameHumanPrincipal: (left, right) => this.sameHumanPrincipal(left, right)
      });
      if (!auth.allowed) deny(auth.code, auth.message);
      if (!record.digestSha256) deny("attachment_status_conflict");
      if (expectedDigestSha256 !== undefined && expectedDigestSha256 !== record.digestSha256) {
        deny("attachment_digest_mismatch");
      }

      const attachment = commentAttachmentInputSchema.parse({
        pendingUploadId: record.pendingUploadId,
        digestSha256: record.digestSha256,
        sizeBytes: record.expectedSizeBytes,
        mediaType: record.mediaType,
        fileName: record.fileName
      });

      return this.options.repository.finalize({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        pendingUploadId,
        expected: attachment,
        finalizedAt: this.clock().toISOString()
      });
    } catch (error) {
      mapUnknown(error);
    }
  }

  async openPendingRead(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    pendingUploadId: string;
  }): Promise<{
    record: PendingUploadRecord;
    metadata: { digestSha256: string; sizeBytes: number; mediaType: string; fileName?: string };
    stream: import("node:fs").ReadStream;
  }> {
    try {
      const subject = humanSubject(input.actor);
      if (input.actor.projectId !== input.projectId) {
        deny("attachment_auth_project_mismatch");
      }
      const record = this.options.repository.getPendingRequired(
        input.workspaceId,
        input.projectId,
        input.pendingUploadId
      );
      const auth = authorizePendingUploadRead({
        subject,
        projectId: input.projectId,
        record,
        now: this.clock()
      });
      if (!auth.allowed) deny(auth.code, auth.message);
      if (!record.digestSha256) deny("attachment_not_found");

      const { metadata, stream } = await this.options.blobs.openRead(record.digestSha256);
      return {
        record,
        metadata: {
          digestSha256: metadata.digestSha256,
          sizeBytes: metadata.sizeBytes,
          mediaType: metadata.mediaType,
          fileName: record.fileName
        },
        stream
      };
    } catch (error) {
      mapUnknown(error);
    }
  }

  async openCommentAttachmentRead(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    commentId: string;
    digestSha256: string;
  }): Promise<{
    binding: CommentAttachmentBinding;
    stream: import("node:fs").ReadStream;
  }> {
    try {
      const subject = humanSubject(input.actor);
      if (input.actor.projectId !== input.projectId) {
        deny("attachment_auth_project_mismatch");
      }
      const binding = this.options.repository.getBinding(
        input.workspaceId,
        input.projectId,
        input.commentId,
        input.digestSha256
      );
      if (!binding) deny("attachment_not_found");

      const auth = authorizeCommentAttachmentRead({
        subject,
        projectId: input.projectId,
        binding
      });
      if (!auth.allowed) deny(auth.code, auth.message);

      const { stream } = await this.options.blobs.openRead(binding.digestSha256);
      return { binding, stream };
    } catch (error) {
      mapUnknown(error);
    }
  }

  async openDigestRead(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    digestSha256: string;
  }): Promise<{
    digestSha256: string;
    sizeBytes: number;
    mediaType: string;
    stream: import("node:fs").ReadStream;
  }> {
    try {
      const subject = humanSubject(input.actor);
      if (input.actor.projectId !== input.projectId) {
        deny("attachment_auth_project_mismatch");
      }
      const digest = commentContentSha256Schema.parse(input.digestSha256);
      const referenced = this.options.repository.hasProjectReference(
        input.workspaceId,
        input.projectId,
        digest
      );
      const auth = authorizeDigestScopedRead({
        subject,
        projectId: input.projectId,
        referencedInProject: referenced
      });
      if (!auth.allowed) deny(auth.code, auth.message);

      const { metadata, stream } = await this.options.blobs.openRead(digest);
      return {
        digestSha256: metadata.digestSha256,
        sizeBytes: metadata.sizeBytes,
        mediaType: metadata.mediaType,
        stream
      };
    } catch (error) {
      mapUnknown(error);
    }
  }

  bindCommentAttachments(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    commentId: string;
    attachments: readonly CommentAttachmentMetadata[];
  }): CommentAttachmentBinding[] {
    try {
      const subject = humanSubject(input.actor);
      const auth = authorizeAttachmentProjectAccess({
        subject,
        projectId: input.projectId
      });
      if (!auth.allowed) deny(auth.code, auth.message);
      if (input.actor.projectId !== input.projectId) {
        deny("attachment_auth_project_mismatch");
      }
      return this.options.repository.bindCommentAttachments({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        commentId: input.commentId,
        attachments: input.attachments,
        createdAt: this.clock().toISOString()
      });
    } catch (error) {
      mapUnknown(error);
    }
  }

  setCommentTombstoned(input: {
    workspaceId: string;
    projectId: string;
    commentId: string;
    tombstonedAt?: string;
  }): void {
    this.options.repository.setCommentTombstoned({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      commentId: input.commentId,
      tombstonedAt: input.tombstonedAt ?? this.clock().toISOString()
    });
  }

  resolveFinalizedAttachment(
    workspaceId: string,
    projectId: string,
    input: CommentAttachmentInput
  ): CommentAttachmentMetadata {
    try {
      return this.options.repository.resolveFinalizedForCommentInput(workspaceId, projectId, input);
    } catch (error) {
      mapUnknown(error);
    }
  }

  /**
   * Retention: expire and delete staged uploads past expires_at that are not finalized.
   * Finalized rows and comment bindings are retained for comment lifecycle (B-003).
   */
  async cleanupExpiredStaged(
    workspaceId: string,
    projectId: string,
    limit = 100
  ): Promise<{
    removedPending: number;
    removedBlobs: number;
  }> {
    const workspace = workspaceIdSchema.parse(workspaceId);
    const project = humanProjectIdSchema.parse(projectId);
    const nowIso = this.clock().toISOString();
    const expired = this.options.repository.listExpiredStagedForCleanup(
      workspace,
      project,
      nowIso,
      limit
    );
    let removedPending = 0;
    let removedBlobs = 0;
    for (const record of expired) {
      this.options.repository.markExpired(workspace, record.projectId, record.pendingUploadId);
      const { digestSha256 } = this.options.repository.deletePending(
        workspace,
        record.projectId,
        record.pendingUploadId
      );
      removedPending += 1;
      if (digestSha256) {
        const deleted = await this.options.blobs.deleteIfUnreferenced(digestSha256);
        if (deleted) removedBlobs += 1;
      }
    }
    return { removedPending, removedBlobs };
  }
}

async function collectBounded(
  chunks: AsyncIterable<Uint8Array>,
  expectedSize: number,
  maxBytes: number
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > expectedSize || size > maxBytes) {
      throw new CommentAttachmentServiceError("attachment_size_mismatch");
    }
    parts.push(Buffer.from(chunk));
  }
  if (size !== expectedSize) {
    throw new CommentAttachmentServiceError("attachment_size_mismatch");
  }
  return Buffer.concat(parts);
}

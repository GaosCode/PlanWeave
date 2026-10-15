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
  withAttachmentCleanup,
  type AttachmentErrorCode
} from "./errors.js";
import type { CommentAttachmentDigestLifecycle } from "./digestLifecycle.js";
import { CommentAttachmentBlobStore } from "./blobStore.js";
import {
  authorizeAttachmentProjectAccess,
  authorizeCommentAttachmentRead,
  authorizePendingUploadMutation,
  authorizePendingUploadRead,
  evaluateAttachmentMediaAndSize,
  evaluatePendingUploadTtlMs,
  humanSubject,
  resolvePendingUploadTtlMs,
  type CommentAttachmentBinding,
  type PendingUploadRecord
} from "./policy.js";
import {
  AttachmentRepositoryError,
  CommentAttachmentRepository,
  type AttachmentDraftCleanupCursor
} from "./repository.js";
import type { HumanIdentityRepository } from "../identity/repository.js";

export class CommentAttachmentServiceError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string = ATTACHMENT_ERROR_MESSAGES[code],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CommentAttachmentServiceError";
  }
}

function deny(code: AttachmentErrorCode, message?: string): never {
  throw new CommentAttachmentServiceError(code, message ?? ATTACHMENT_ERROR_MESSAGES[code]);
}

function mapUnknown(error: unknown): never {
  if (error instanceof CommentAttachmentServiceError) throw error;
  if (error instanceof AttachmentRepositoryError) {
    throw new CommentAttachmentServiceError(error.code, error.message, { cause: error });
  }
  if (error instanceof ZodError) {
    throw new CommentAttachmentServiceError("attachment_input_invalid", undefined, {
      cause: error
    });
  }
  if (error instanceof Error) {
    const code = attachmentErrorCodeSchema.safeParse(error.message);
    if (code.success) {
      throw new CommentAttachmentServiceError(code.data, undefined, { cause: error });
    }
    if (error.message === "attachment_write_stalled") {
      throw new CommentAttachmentServiceError("attachment_input_invalid", undefined, {
        cause: error
      });
    }
    if (
      error.message === "attachment_blob_conflict" ||
      error.message === "attachment_blob_size_mismatch" ||
      error.message === "attachment_blob_digest_mismatch" ||
      error.message === "attachment_path_escape"
    ) {
      throw new CommentAttachmentServiceError("attachment_input_invalid", error.message, {
        cause: error
      });
    }
  }
  throw error;
}

export type CommentAttachmentServiceOptions = {
  repository: CommentAttachmentRepository;
  blobs: CommentAttachmentBlobStore;
  lifecycle: CommentAttachmentDigestLifecycle;
  identity: HumanIdentityRepository;
  canRead(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    canvasId?: string;
  }): boolean;
  clock?: () => Date;
};

export type AttachmentMaintenanceCursor = { draft?: AttachmentDraftCleanupCursor; blob?: string };
export type AttachmentMaintenanceResult = {
  cursor: AttachmentMaintenanceCursor;
  candidates: number;
  blobDeleteAttempts: number;
  removedPending: number;
  removedBlobs: number;
  failures: Array<{ phase: "draft" | "blob"; error: unknown }>;
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

      const staged = await this.options.blobs.stage({
        expectedSha256: digest,
        expectedSizeBytes: record.expectedSizeBytes,
        mediaType,
        chunks
      });
      return await withAttachmentCleanup(
        () =>
          this.options.lifecycle.withDigest(digest, async () => {
            const current = this.options.repository.getPendingRequired(
              input.workspaceId,
              input.projectId,
              input.pendingUploadId
            );
            const currentAuth = authorizePendingUploadMutation({
              subject,
              projectId: input.projectId,
              record: current,
              now: this.clock(),
              requiredStatus: ["pending"],
              sameHumanPrincipal: (left, right) => this.sameHumanPrincipal(left, right)
            });
            if (!currentAuth.allowed) deny(currentAuth.code, currentAuth.message);
            await staged.publish();
            return this.options.repository.markUploaded({
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              pendingUploadId: input.pendingUploadId,
              digestSha256: digest,
              sizeBytes: record.expectedSizeBytes,
              mediaType,
              uploadedAt: this.clock().toISOString()
            });
          }),
        () => staged.dispose()
      );
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
      const candidate = this.options.repository.getPendingRequired(
        input.workspaceId,
        input.projectId,
        input.pendingUploadId
      );
      const initialAuth = authorizePendingUploadRead({
        subject,
        projectId: input.projectId,
        record: candidate,
        now: this.clock()
      });
      if (!initialAuth.allowed) deny(initialAuth.code, initialAuth.message);
      if (!candidate.digestSha256) deny("attachment_not_found");
      return await this.withDigestRead(candidate.digestSha256, async () => {
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

        if (!this.canReadPending(input.actor, record)) deny("attachment_auth_forbidden");
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
      });
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
      return await this.withDigestRead(input.digestSha256, async () => {
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

        const readable = this.options.repository
          .listDigestReadBindings(input.workspaceId, input.projectId, binding.digestSha256)
          .find((reference) => reference.binding.commentId === binding.commentId);
        if (
          !readable?.workItem ||
          !this.options.canRead({ ...input, canvasId: readable.workItem.canvasId })
        ) {
          deny("attachment_auth_forbidden");
        }
        const { stream } = await this.options.blobs.openRead(binding.digestSha256);
        return { binding, stream };
      });
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
      const base = authorizeAttachmentProjectAccess({ subject, projectId: input.projectId });
      if (!base.allowed) deny(base.code, base.message);
      return await this.withDigestRead(digest, async () => {
        const bindings = this.options.repository.listDigestReadBindings(
          input.workspaceId,
          input.projectId,
          digest
        );
        const pending = this.options.repository.listDigestPendingUploads(
          input.workspaceId,
          input.projectId,
          digest
        );
        if (!bindings.length && !pending.length) deny("attachment_not_found");
        const allowed =
          bindings.some(
            (reference) =>
              reference.workItem &&
              this.options.canRead({ ...input, canvasId: reference.workItem.canvasId })
          ) || pending.some((record) => this.canReadPending(input.actor, record));
        if (!allowed) deny("attachment_auth_forbidden");

        const { metadata, stream } = await this.options.blobs.openRead(digest);
        return {
          digestSha256: metadata.digestSha256,
          sizeBytes: metadata.sizeBytes,
          mediaType: metadata.mediaType,
          stream
        };
      });
    } catch (error) {
      mapUnknown(error);
    }
  }

  private async withDigestRead<T extends { stream: import("node:fs").ReadStream }>(
    digest: string,
    action: () => Promise<T>
  ): Promise<T> {
    let opened: T | undefined;
    try {
      return await this.options.lifecycle.withDigest(digest, async () => {
        opened = await action();
        return opened;
      });
    } catch (error) {
      if (opened && !opened.stream.closed) {
        const stream = opened.stream;
        return withAttachmentCleanup(
          async () => {
            throw error;
          },
          () =>
            new Promise<void>((resolve, reject) => {
              stream.once("error", reject);
              stream.once("close", () => {
                stream.off("error", reject);
                resolve();
              });
              stream.destroy();
            })
        );
      }
      throw error;
    }
  }

  private canReadPending(actor: HumanAuthContext, record: PendingUploadRecord): boolean {
    if (!record.digestSha256) return false;
    const exact = this.options.repository.hasExactPendingBindingProvenance(record);
    if (
      !exact &&
      !this.sameHumanPrincipal(actor.humanPrincipalId, record.uploaderHumanPrincipalId)
    ) {
      return false;
    }
    const bindings = this.options.repository.listDigestReadBindings(
      record.workspaceId,
      record.projectId,
      record.digestSha256,
      exact ? record.pendingUploadId : undefined
    );
    if (bindings.length) {
      return bindings.some(
        (reference) =>
          (exact || !record.commentId || reference.binding.commentId === record.commentId) &&
          reference.workItem &&
          this.options.canRead({
            actor,
            workspaceId: record.workspaceId,
            projectId: record.projectId,
            canvasId: reference.workItem.canvasId
          })
      );
    }
    if (record.commentId) return false;
    const auth = authorizePendingUploadRead({
      subject: humanSubject(actor),
      projectId: record.projectId,
      record,
      now: this.clock()
    });
    return (
      auth.allowed &&
      Date.parse(record.expiresAt) > this.clock().getTime() &&
      this.sameHumanPrincipal(actor.humanPrincipalId, record.uploaderHumanPrincipalId)
    );
  }

  bindCommentAttachments(input: {
    actor: HumanAuthContext;
    workspaceId: string;
    projectId: string;
    commentId: string;
    attachments: readonly (CommentAttachmentMetadata & { pendingUploadId: string })[];
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
      return this.options.repository.resolveFinalizedForCommentInput(
        workspaceId,
        projectId,
        input,
        this.clock().toISOString()
      );
    } catch (error) {
      mapUnknown(error);
    }
  }

  /**
   * Expire unbound drafts under the digest claim before file I/O. The atomic expiry CAS
   * and comment binding write transaction serialize reference revocation with binding.
   * Failed deletion leaves unreferenced blob metadata available for retry.
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
    const progress = { removedPending: 0, removedBlobs: 0, blobDeleteAttempts: 0 };
    for (const record of expired) await this.cleanupPending(record, nowIso, progress);
    for (const digest of this.options.repository.listUnreferencedBlobDigests(limit, nowIso)) {
      await this.cleanupBlob(digest, nowIso, progress);
    }
    return { removedPending: progress.removedPending, removedBlobs: progress.removedBlobs };
  }

  /** One globally bounded page; advance cursors even when individual candidates fail. */
  async cleanupMaintenanceBatch(
    cursor: AttachmentMaintenanceCursor,
    limit: number,
    signal?: AbortSignal
  ): Promise<AttachmentMaintenanceResult> {
    if (!Number.isSafeInteger(limit) || limit < 2)
      throw new Error("attachment_maintenance_limit_invalid");
    const nowIso = this.clock().toISOString();
    const draftLimit = Math.floor(limit / 2);
    const blobLimit = limit - draftLimit;
    const result: AttachmentMaintenanceResult = {
      cursor: {},
      candidates: 0,
      blobDeleteAttempts: 0,
      removedPending: 0,
      removedBlobs: 0,
      failures: []
    };
    const drafts = this.options.repository.listExpiredDraftsForMaintenance(
      nowIso,
      draftLimit,
      cursor.draft
    );
    for (const record of drafts) {
      if (signal?.aborted) break;
      result.candidates += 1;
      try {
        await this.cleanupPending(record, nowIso, result);
      } catch (error) {
        result.failures.push({ phase: "draft", error });
      }
    }
    const lastDraft = drafts.at(-1);
    if (drafts.length === draftLimit && lastDraft)
      result.cursor.draft = [lastDraft.workspaceId, lastDraft.projectId, lastDraft.pendingUploadId];
    if (signal?.aborted) return result;
    const blobs = this.options.repository.listUnreferencedBlobDigests(
      blobLimit,
      nowIso,
      cursor.blob
    );
    for (const digest of blobs) {
      if (signal?.aborted) break;
      result.candidates += 1;
      try {
        await this.cleanupBlob(digest, nowIso, result);
      } catch (error) {
        result.failures.push({ phase: "blob", error });
      }
    }
    if (blobs.length === blobLimit) result.cursor.blob = blobs.at(-1);
    return result;
  }

  private async cleanupPending(
    record: PendingUploadRecord,
    nowIso: string,
    progress: { removedPending: number; removedBlobs: number; blobDeleteAttempts: number }
  ): Promise<void> {
    const expire = async () => {
      if (
        !this.options.repository.markExpired(
          record.workspaceId,
          record.projectId,
          record.pendingUploadId,
          nowIso,
          record.digestSha256
        )
      )
        return;
      const removed = this.options.repository.deletePending(
        record.workspaceId,
        record.projectId,
        record.pendingUploadId
      );
      if (removed.removed) progress.removedPending += 1;
      if (removed.digestSha256) {
        progress.blobDeleteAttempts += 1;
        if (await this.options.blobs.deleteIfUnreferenced(removed.digestSha256, nowIso))
          progress.removedBlobs += 1;
      }
    };
    if (record.digestSha256) await this.options.lifecycle.withDigest(record.digestSha256, expire);
    else await expire();
  }

  private async cleanupBlob(
    digest: string,
    nowIso: string,
    progress: { removedBlobs: number; blobDeleteAttempts: number }
  ): Promise<void> {
    await this.options.lifecycle.withDigest(digest, async () => {
      progress.blobDeleteAttempts += 1;
      if (await this.options.blobs.deleteIfUnreferenced(digest, nowIso)) progress.removedBlobs += 1;
    });
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

import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import { workItemRefSchema, type WorkItemRef } from "../work/schemas.js";
import {
  commentAttachmentFileNameSchema,
  commentAttachmentMediaTypeSchema,
  commentAttachmentMetadataSchema,
  commentContentSha256Schema,
  commentIdSchema,
  pendingAttachmentUploadIdSchema,
  pendingAttachmentUploadSchema,
  type CommentAttachmentInput,
  type CommentAttachmentMetadata,
  type CommentId,
  type PendingAttachmentUploadId
} from "../comments/schemas.js";
import { humanPrincipalIdSchema, humanProjectIdSchema } from "../identity/schemas.js";
import { HumanPrincipalIdentity } from "../identity/humanPrincipalIdentity.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { ATTACHMENT_ERROR_MESSAGES, type AttachmentErrorCode } from "./errors.js";
import type { CommentAttachmentBinding, PendingUploadRecord } from "./policy.js";

export class AttachmentRepositoryError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string = ATTACHMENT_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "AttachmentRepositoryError";
  }
}

export type CommentAttachmentRepositoryOptions = {
  onMutationInTransaction?: (input: {
    workspaceId: string;
    projectId: string;
    pendingUploadId?: string;
    commentId?: string;
    occurredAt: string;
  }) => void;
};

// Exact provenance identifies modern bindings; legacy rows conservatively preserve digest bindings.
const unboundPendingSql = `NOT EXISTS (SELECT 1 FROM comment_attachment_bindings b
  WHERE b.workspace_id=p.workspace_id AND b.project_id=p.project_id AND b.digest_sha256=p.digest_sha256
  AND (p.binding_provenance_version=0 OR EXISTS
    (SELECT 1 FROM json_each(b.pending_upload_ids_json) WHERE value=p.pending_upload_id)))`;

// A draft remains a byte reference until expiry is atomically revoked; audit bindings are durable.
const unreferencedDigestSql = `NOT EXISTS (SELECT 1 FROM comment_pending_uploads p
  WHERE p.digest_sha256=blob.digest_sha256 AND p.status IN ('uploaded','finalized'))
  AND NOT EXISTS (SELECT 1 FROM comment_attachment_bindings b WHERE b.digest_sha256=blob.digest_sha256)
  AND NOT EXISTS (SELECT 1 FROM comment_attachment_bindings_unscoped_legacy b WHERE b.digest_sha256=blob.digest_sha256)
  AND NOT EXISTS (SELECT 1 FROM comment_pending_uploads_unscoped_legacy p
    WHERE json_extract(p.payload_json,'$.digestSha256')=blob.digest_sha256
    AND json_extract(p.payload_json,'$.status') IN ('uploaded','finalized')
    AND json_extract(p.payload_json,'$.expiresAt') > ?)`;

const pendingStatusSchema = z.enum(["pending", "uploaded", "finalized", "expired", "aborted"]);

const legacyPendingReferenceSchema = z.object({
  status: pendingStatusSchema,
  digestSha256: commentContentSha256Schema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});

type PendingRow = {
  pending_upload_id: string;
  workspace_id: string;
  project_id: string;
  uploader_human_principal_id: string;
  expected_digest_sha256: string | null;
  expected_size_bytes: number;
  media_type: string;
  file_name: string | null;
  comment_id: string | null;
  status: string;
  digest_sha256: string | null;
  created_at: string;
  expires_at: string;
  uploaded_at: string | null;
  finalized_at: string | null;
};

type BindingRow = {
  workspace_id: string;
  project_id: string;
  comment_id: string;
  digest_sha256: string;
  size_bytes: number;
  media_type: string;
  file_name: string | null;
  created_at: string;
  comment_tombstoned_at: string | null;
  pending_upload_ids_json: string;
};

function toPendingRecord(row: PendingRow): PendingUploadRecord {
  const base = pendingAttachmentUploadSchema.parse({
    pendingUploadId: row.pending_upload_id,
    projectId: row.project_id,
    uploaderHumanPrincipalId: row.uploader_human_principal_id,
    expectedDigestSha256: row.expected_digest_sha256 ?? undefined,
    expectedSizeBytes: row.expected_size_bytes,
    mediaType: row.media_type,
    fileName: row.file_name ?? undefined,
    commentId: row.comment_id ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  });
  return {
    ...base,
    workspaceId: workspaceIdSchema.parse(row.workspace_id),
    status: pendingStatusSchema.parse(row.status),
    digestSha256: row.digest_sha256 ?? undefined,
    uploadedAt: row.uploaded_at ?? undefined,
    finalizedAt: row.finalized_at ?? undefined
  };
}

function toBinding(row: BindingRow): CommentAttachmentBinding {
  return {
    workspaceId: workspaceIdSchema.parse(row.workspace_id),
    projectId: humanProjectIdSchema.parse(row.project_id),
    commentId: commentIdSchema.parse(row.comment_id),
    digestSha256: commentContentSha256Schema.parse(row.digest_sha256),
    sizeBytes: row.size_bytes,
    mediaType: commentAttachmentMediaTypeSchema.parse(row.media_type),
    fileName: row.file_name ? commentAttachmentFileNameSchema.parse(row.file_name) : undefined,
    createdAt: row.created_at,
    commentTombstonedAt: row.comment_tombstoned_at ?? undefined
  };
}

export type AttachmentDraftCleanupCursor = readonly [
  workspaceId: string,
  projectId: string,
  pendingUploadId: string
];

export class CommentAttachmentRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: CommentAttachmentRepositoryOptions = {}
  ) {}

  createPendingUpload(input: {
    workspaceId: string;
    projectId: string;
    uploaderHumanPrincipalId: string;
    expectedSizeBytes: number;
    mediaType: string;
    fileName?: string;
    expectedDigestSha256?: string;
    commentId?: string;
    createdAt: string;
    expiresAt: string;
  }): PendingUploadRecord {
    const pendingUploadId = pendingAttachmentUploadIdSchema.parse(randomUUID());
    const workspaceId = workspaceIdSchema.parse(input.workspaceId);
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const uploaderHumanPrincipalId = new HumanPrincipalIdentity(this.database).canonicalizeTarget(
      humanPrincipalIdSchema.parse(input.uploaderHumanPrincipalId)
    );
    const mediaType = commentAttachmentMediaTypeSchema.parse(input.mediaType);
    const expectedDigestSha256 = input.expectedDigestSha256
      ? commentContentSha256Schema.parse(input.expectedDigestSha256)
      : null;
    const fileName = input.fileName ? commentAttachmentFileNameSchema.parse(input.fileName) : null;
    const commentId = input.commentId ? commentIdSchema.parse(input.commentId) : null;

    this.database
      .prepare(
        `INSERT INTO comment_pending_uploads(
          pending_upload_id,workspace_id,project_id,uploader_human_principal_id,
          expected_digest_sha256,expected_size_bytes,media_type,file_name,comment_id,
          status,digest_sha256,created_at,expires_at,uploaded_at,finalized_at,binding_provenance_version
        ) VALUES (?,?,?,?,?,?,?,?,?, 'pending', NULL,?,?, NULL, NULL,1)`
      )
      .run(
        pendingUploadId,
        workspaceId,
        projectId,
        uploaderHumanPrincipalId,
        expectedDigestSha256,
        input.expectedSizeBytes,
        mediaType,
        fileName,
        commentId,
        input.createdAt,
        input.expiresAt
      );

    return this.getPendingRequired(workspaceId, projectId, pendingUploadId);
  }

  getPending(
    workspaceId: string,
    projectId: string,
    pendingUploadId: string
  ): PendingUploadRecord | undefined {
    const raw = this.database
      .prepare(
        `SELECT * FROM comment_pending_uploads
         WHERE workspace_id=? AND project_id=? AND pending_upload_id=?`
      )
      .get(
        workspaceIdSchema.parse(workspaceId),
        humanProjectIdSchema.parse(projectId),
        pendingUploadId
      );
    if (!raw) return undefined;
    return toPendingRecord(raw as PendingRow);
  }

  getPendingRequired(
    workspaceId: string,
    projectId: string,
    pendingUploadId: string
  ): PendingUploadRecord {
    const record = this.getPending(workspaceId, projectId, pendingUploadId);
    if (!record) {
      throw new AttachmentRepositoryError("attachment_pending_not_found");
    }
    return record;
  }

  /**
   * CAS: pending → uploaded with verified digest. Concurrent uploaders lose with status conflict.
   */
  markUploaded(input: {
    workspaceId: string;
    projectId: string;
    pendingUploadId: string;
    digestSha256: string;
    sizeBytes: number;
    mediaType: string;
    uploadedAt: string;
  }): PendingUploadRecord {
    return inWriteTransaction(this.database, () => {
      const current = this.getPendingRequired(
        input.workspaceId,
        input.projectId,
        input.pendingUploadId
      );
      if (current.status !== "pending") {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      if (current.expectedSizeBytes !== input.sizeBytes) {
        throw new AttachmentRepositoryError("attachment_size_mismatch");
      }
      if (current.mediaType !== input.mediaType) {
        throw new AttachmentRepositoryError("attachment_media_type");
      }
      if (
        current.expectedDigestSha256 !== undefined &&
        current.expectedDigestSha256 !== input.digestSha256
      ) {
        throw new AttachmentRepositoryError("attachment_digest_mismatch");
      }

      const result = this.database
        .prepare(
          `UPDATE comment_pending_uploads
           SET status='uploaded', digest_sha256=?, uploaded_at=?,
               expected_digest_sha256=COALESCE(expected_digest_sha256, ?)
           WHERE workspace_id=? AND project_id=? AND pending_upload_id=? AND status='pending'`
        )
        .run(
          commentContentSha256Schema.parse(input.digestSha256),
          input.uploadedAt,
          commentContentSha256Schema.parse(input.digestSha256),
          workspaceIdSchema.parse(input.workspaceId),
          humanProjectIdSchema.parse(input.projectId),
          pendingAttachmentUploadIdSchema.parse(input.pendingUploadId)
        );
      if (result.changes !== 1) {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      const record = this.getPendingRequired(
        input.workspaceId,
        input.projectId,
        input.pendingUploadId
      );
      this.options.onMutationInTransaction?.({
        workspaceId: record.workspaceId,
        projectId: record.projectId,
        pendingUploadId: record.pendingUploadId,
        commentId: record.commentId,
        occurredAt: input.uploadedAt
      });
      return record;
    });
  }

  /**
   * CAS: uploaded → finalized. Returns metadata for comment create inputs.
   */
  finalize(input: {
    workspaceId: string;
    projectId: string;
    pendingUploadId: string;
    expected: CommentAttachmentInput;
    finalizedAt: string;
  }): { record: PendingUploadRecord; metadata: CommentAttachmentMetadata } {
    return inWriteTransaction(this.database, () => {
      const current = this.getPendingRequired(
        input.workspaceId,
        input.projectId,
        input.pendingUploadId
      );
      if (current.status === "finalized") {
        // Idempotent finalize when digest/size/media match.
        if (
          current.digestSha256 === input.expected.digestSha256 &&
          current.expectedSizeBytes === input.expected.sizeBytes &&
          current.mediaType === input.expected.mediaType
        ) {
          return {
            record: current,
            metadata: commentAttachmentMetadataSchema.parse({
              digestSha256: current.digestSha256,
              sizeBytes: current.expectedSizeBytes,
              mediaType: current.mediaType,
              fileName: current.fileName ?? input.expected.fileName,
              createdAt: current.finalizedAt ?? current.uploadedAt ?? current.createdAt
            })
          };
        }
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      if (current.status !== "uploaded") {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      if (current.digestSha256 !== input.expected.digestSha256) {
        throw new AttachmentRepositoryError("attachment_digest_mismatch");
      }
      if (current.expectedSizeBytes !== input.expected.sizeBytes) {
        throw new AttachmentRepositoryError("attachment_size_mismatch");
      }
      if (current.mediaType !== input.expected.mediaType) {
        throw new AttachmentRepositoryError("attachment_media_type");
      }
      if (String(current.pendingUploadId) !== String(input.expected.pendingUploadId)) {
        throw new AttachmentRepositoryError("attachment_input_invalid");
      }

      const result = this.database
        .prepare(
          `UPDATE comment_pending_uploads
           SET status='finalized', finalized_at=?, expires_at=?,
               file_name=COALESCE(?, file_name)
           WHERE workspace_id=? AND project_id=? AND pending_upload_id=? AND status='uploaded'`
        )
        .run(
          input.finalizedAt,
          new Date(
            Date.parse(input.finalizedAt) +
              Date.parse(current.expiresAt) -
              Date.parse(current.createdAt)
          ).toISOString(),
          input.expected.fileName ?? null,
          workspaceIdSchema.parse(input.workspaceId),
          humanProjectIdSchema.parse(input.projectId),
          pendingAttachmentUploadIdSchema.parse(input.pendingUploadId)
        );
      if (result.changes !== 1) {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      const record = this.getPendingRequired(
        input.workspaceId,
        input.projectId,
        input.pendingUploadId
      );
      this.options.onMutationInTransaction?.({
        workspaceId: record.workspaceId,
        projectId: record.projectId,
        pendingUploadId: record.pendingUploadId,
        commentId: record.commentId,
        occurredAt: input.finalizedAt
      });
      return {
        record,
        metadata: commentAttachmentMetadataSchema.parse({
          digestSha256: record.digestSha256,
          sizeBytes: record.expectedSizeBytes,
          mediaType: record.mediaType,
          fileName: record.fileName,
          createdAt: record.finalizedAt ?? input.finalizedAt
        })
      };
    });
  }

  markExpired(
    workspaceId: string,
    projectId: string,
    pendingUploadId: string,
    nowIso: string,
    expectedDigestSha256?: string
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE comment_pending_uploads AS p SET status='expired'
         WHERE workspace_id=? AND project_id=? AND pending_upload_id=?
           AND status IN ('pending','uploaded','finalized','expired') AND expires_at <= ? AND digest_sha256 IS ?
           AND ${unboundPendingSql}`
      )
      .run(
        workspaceIdSchema.parse(workspaceId),
        humanProjectIdSchema.parse(projectId),
        pendingAttachmentUploadIdSchema.parse(pendingUploadId),
        nowIso,
        expectedDigestSha256 ?? null
      );
    return result.changes === 1;
  }

  /**
   * Bind finalized digests to a comment id for authorized download by comment scope.
   * Used by comment create (B-003) and tests; B-002 exposes it for tombstone policy.
   * Opens its own write transaction. Prefer {@link bindCommentAttachmentsUnlocked}
   * when the caller already holds a write transaction (comment create).
   */
  bindCommentAttachments(input: {
    workspaceId: string;
    projectId: string;
    commentId: string;
    attachments: readonly (CommentAttachmentMetadata & { pendingUploadId: string })[];
    createdAt: string;
  }): CommentAttachmentBinding[] {
    return inWriteTransaction(this.database, () => this.bindCommentAttachmentsUnlocked(input));
  }

  /**
   * Same as {@link bindCommentAttachments} without opening a nested transaction.
   * Caller must already be inside a write transaction.
   */
  bindCommentAttachmentsUnlocked(input: {
    workspaceId: string;
    projectId: string;
    commentId: string;
    attachments: readonly (CommentAttachmentMetadata & { pendingUploadId: string })[];
    createdAt: string;
  }): CommentAttachmentBinding[] {
    const workspaceId = workspaceIdSchema.parse(input.workspaceId);
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const commentId = commentIdSchema.parse(input.commentId);
    const bindings: CommentAttachmentBinding[] = [];
    for (const attachment of input.attachments) {
      const pendingUploadId = pendingAttachmentUploadIdSchema.parse(attachment.pendingUploadId);
      this.resolveFinalizedForCommentInput(
        workspaceId,
        projectId,
        {
          ...attachment,
          pendingUploadId
        },
        input.createdAt
      );
      const existing = this.database
        .prepare(`SELECT pending_upload_ids_json FROM comment_attachment_bindings
          WHERE workspace_id=? AND project_id=? AND comment_id=? AND digest_sha256=?`)
        .get(workspaceId, projectId, commentId, attachment.digestSha256) as
        | { pending_upload_ids_json: string }
        | undefined;
      const pendingIds = existing
        ? z
            .array(pendingAttachmentUploadIdSchema)
            .parse(JSON.parse(existing.pending_upload_ids_json))
        : [];
      const provenance = JSON.stringify([...new Set([...pendingIds, pendingUploadId])]);
      this.database
        .prepare(
          `INSERT INTO comment_attachment_bindings(
            workspace_id,project_id,comment_id,digest_sha256,size_bytes,media_type,file_name,
            created_at,comment_tombstoned_at,pending_upload_ids_json
          ) VALUES (?,?,?,?,?,?,?, ?, NULL,?)
          ON CONFLICT(workspace_id, project_id, comment_id, digest_sha256) DO UPDATE SET
            size_bytes=excluded.size_bytes,
            media_type=excluded.media_type,
            file_name=excluded.file_name,
            pending_upload_ids_json=excluded.pending_upload_ids_json`
        )
        .run(
          workspaceId,
          projectId,
          commentId,
          attachment.digestSha256,
          attachment.sizeBytes,
          attachment.mediaType,
          attachment.fileName ?? null,
          input.createdAt,
          provenance
        );
      bindings.push(
        this.getBindingRequired(workspaceId, projectId, commentId, attachment.digestSha256)
      );
    }
    return bindings;
  }

  setCommentTombstoned(input: {
    workspaceId: string;
    projectId: string;
    commentId: string;
    tombstonedAt: string;
  }): void {
    this.database
      .prepare(
        `UPDATE comment_attachment_bindings
         SET comment_tombstoned_at=?
         WHERE workspace_id=? AND project_id=? AND comment_id=?`
      )
      .run(
        input.tombstonedAt,
        workspaceIdSchema.parse(input.workspaceId),
        humanProjectIdSchema.parse(input.projectId),
        commentIdSchema.parse(input.commentId)
      );
  }

  getBinding(
    workspaceId: string,
    projectId: string,
    commentId: string,
    digestSha256: string
  ): CommentAttachmentBinding | undefined {
    const raw = this.database
      .prepare(
        `SELECT * FROM comment_attachment_bindings
         WHERE workspace_id=? AND project_id=? AND comment_id=? AND digest_sha256=?`
      )
      .get(
        workspaceIdSchema.parse(workspaceId),
        humanProjectIdSchema.parse(projectId),
        commentIdSchema.parse(commentId),
        commentContentSha256Schema.parse(digestSha256)
      );
    if (!raw) return undefined;
    return toBinding(raw as BindingRow);
  }

  getBindingRequired(
    workspaceId: string,
    projectId: string,
    commentId: string,
    digestSha256: string
  ): CommentAttachmentBinding {
    const binding = this.getBinding(workspaceId, projectId, commentId, digestSha256);
    if (!binding) {
      throw new AttachmentRepositoryError("attachment_not_found");
    }
    return binding;
  }

  listDigestReadBindings(
    workspaceId: string,
    projectId: string,
    digestSha256: string,
    pendingUploadId?: string
  ): Array<{
    binding: CommentAttachmentBinding;
    workItem?: WorkItemRef;
  }> {
    const rows = this.database
      .prepare(`SELECT b.*, c.canvas_id, c.work_item_kind, c.work_item_key
      FROM comment_attachment_bindings b LEFT JOIN comments c
        ON c.workspace_id=b.workspace_id AND c.project_id=b.project_id AND c.comment_id=b.comment_id
      WHERE b.workspace_id=? AND b.project_id=? AND b.digest_sha256=?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(b.pending_upload_ids_json) WHERE value=?))`)
      .all(
        workspaceIdSchema.parse(workspaceId),
        humanProjectIdSchema.parse(projectId),
        commentContentSha256Schema.parse(digestSha256),
        pendingUploadId === undefined
          ? null
          : pendingAttachmentUploadIdSchema.parse(pendingUploadId),
        pendingUploadId === undefined
          ? null
          : pendingAttachmentUploadIdSchema.parse(pendingUploadId)
      ) as Array<
      BindingRow & {
        canvas_id: string | null;
        work_item_kind: string | null;
        work_item_key: string | null;
      }
    >;
    return rows.map((row) => ({
      binding: toBinding(row),
      workItem:
        row.canvas_id === null
          ? undefined
          : workItemRefSchema.parse(
              row.work_item_kind === "task"
                ? { kind: "task", canvasId: row.canvas_id, taskId: row.work_item_key }
                : { kind: "block", canvasId: row.canvas_id, blockRef: row.work_item_key }
            )
    }));
  }

  hasExactPendingBindingProvenance(record: PendingUploadRecord): boolean {
    const row = this.database
      .prepare(`SELECT binding_provenance_version FROM comment_pending_uploads
        WHERE workspace_id=? AND project_id=? AND pending_upload_id=?`)
      .get(record.workspaceId, record.projectId, record.pendingUploadId) as
      | { binding_provenance_version: number }
      | undefined;
    if (!row) throw new AttachmentRepositoryError("attachment_not_found");
    return z.union([z.literal(0), z.literal(1)]).parse(row.binding_provenance_version) === 1;
  }

  listDigestPendingUploads(
    workspaceId: string,
    projectId: string,
    digestSha256: string
  ): PendingUploadRecord[] {
    const rows = this.database
      .prepare(`SELECT * FROM comment_pending_uploads
      WHERE workspace_id=? AND project_id=? AND digest_sha256=? AND status IN ('uploaded','finalized')`)
      .all(
        workspaceIdSchema.parse(workspaceId),
        humanProjectIdSchema.parse(projectId),
        commentContentSha256Schema.parse(digestSha256)
      ) as PendingRow[];
    return rows.map(toPendingRecord);
  }

  /**
   * Expired drafts without an actual comment binding, including finalized drafts.
   * Returns digests that may become unreferenced after row deletion.
   */
  listExpiredStagedForCleanup(
    workspaceId: string,
    projectId: string,
    nowIso: string,
    limit = 100
  ): PendingUploadRecord[] {
    const workspace = workspaceIdSchema.parse(workspaceId);
    const project = humanProjectIdSchema.parse(projectId);
    const rows = this.database
      .prepare(
        `SELECT p.* FROM comment_pending_uploads AS p
         WHERE workspace_id=? AND project_id=?
           AND status IN ('pending','uploaded','finalized','expired')
           AND expires_at <= ? AND ${unboundPendingSql}
         ORDER BY expires_at ASC
         LIMIT ?`
      )
      .all(workspace, project, nowIso, limit) as PendingRow[];
    return rows.map(toPendingRecord);
  }

  listExpiredDraftsForMaintenance(
    nowIso: string,
    limit: number,
    after?: AttachmentDraftCleanupCursor
  ): PendingUploadRecord[] {
    return (
      this.database
        .prepare(`SELECT p.* FROM comment_pending_uploads AS p
      WHERE status IN ('pending','uploaded','finalized','expired') AND expires_at <= ?
        AND ${unboundPendingSql}
        AND (? IS NULL OR (workspace_id,project_id,pending_upload_id) > (?,?,?))
      ORDER BY workspace_id,project_id,pending_upload_id LIMIT ?`)
        .all(
          nowIso,
          after?.[0] ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          after?.[2] ?? null,
          limit
        ) as PendingRow[]
    ).map(toPendingRecord);
  }

  listUnreferencedBlobDigests(limit: number, nowIso: string, afterDigest?: string): string[] {
    return this.database
      .prepare(`SELECT digest_sha256 FROM comment_attachment_blobs AS blob
      WHERE ${unreferencedDigestSql} AND (? IS NULL OR blob.digest_sha256 > ?)
      ORDER BY blob.digest_sha256 LIMIT ?`)
      .all(nowIso, afterDigest ?? null, afterDigest ?? null, limit)
      .map((row) => commentContentSha256Schema.parse(row.digest_sha256));
  }

  canDeleteBlob(digestSha256: string, nowIso: string): boolean {
    const digest = commentContentSha256Schema.parse(digestSha256);
    // Quarantined data never authorizes access; malformed reference data must fail cleanup.
    for (const row of this.database
      .prepare(`SELECT payload_json FROM comment_pending_uploads_unscoped_legacy
      WHERE json_extract(payload_json,'$.digestSha256')=?`)
      .all(digest)) {
      legacyPendingReferenceSchema.parse(JSON.parse(z.string().parse(row.payload_json)));
    }
    return Boolean(
      this.database
        .prepare(`SELECT 1 AS eligible FROM comment_attachment_blobs AS blob
        WHERE blob.digest_sha256=? AND ${unreferencedDigestSql}`)
        .get(commentContentSha256Schema.parse(digestSha256), nowIso)
    );
  }

  deletePending(
    workspaceId: string,
    projectId: string,
    pendingUploadId: PendingAttachmentUploadId | string
  ): {
    digestSha256?: string;
    removed: boolean;
  } {
    return inWriteTransaction(this.database, () => {
      const record = this.getPending(workspaceId, projectId, pendingUploadId);
      const result = this.database
        .prepare(`DELETE FROM comment_pending_uploads
        WHERE workspace_id=? AND project_id=? AND pending_upload_id=? AND status='expired'`)
        .run(
          workspaceIdSchema.parse(workspaceId),
          humanProjectIdSchema.parse(projectId),
          pendingAttachmentUploadIdSchema.parse(pendingUploadId)
        );
      return {
        digestSha256: result.changes === 1 ? record?.digestSha256 : undefined,
        removed: result.changes === 1
      };
    });
  }

  /** Resolve a finalized pending upload for comment create attachment inputs. */
  resolveFinalizedForCommentInput(
    workspaceId: string,
    projectId: string,
    input: CommentAttachmentInput,
    nowIso: string
  ): CommentAttachmentMetadata {
    const record = this.getPendingRequired(workspaceId, projectId, input.pendingUploadId);
    if (Date.parse(record.expiresAt) <= Date.parse(nowIso)) {
      throw new AttachmentRepositoryError("attachment_pending_expired");
    }
    if (record.status !== "finalized") {
      throw new AttachmentRepositoryError("attachment_status_conflict");
    }
    if (record.digestSha256 !== input.digestSha256) {
      throw new AttachmentRepositoryError("attachment_digest_mismatch");
    }
    if (record.expectedSizeBytes !== input.sizeBytes) {
      throw new AttachmentRepositoryError("attachment_size_mismatch");
    }
    if (record.mediaType !== input.mediaType) {
      throw new AttachmentRepositoryError("attachment_media_type");
    }
    return commentAttachmentMetadataSchema.parse({
      digestSha256: record.digestSha256,
      sizeBytes: record.expectedSizeBytes,
      mediaType: record.mediaType,
      fileName: input.fileName ?? record.fileName,
      createdAt: record.finalizedAt ?? record.uploadedAt ?? record.createdAt
    });
  }
}

export type { CommentId };

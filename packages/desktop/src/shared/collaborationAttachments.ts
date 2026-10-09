import { z } from "zod";
import { COMMENT_ATTACHMENT_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  commentContentSha256Schema,
  commentIdSchema,
  pendingAttachmentUploadIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  createPendingAttachmentRequestSchema,
  type CreatePendingAttachmentRequest
} from "@planweave-ai/collaboration-protocol/activity/attachments";
import {
  commentAttachmentMediaTypeSchema,
  commentAttachmentSizeBytesSchema
} from "@planweave-ai/collaboration-protocol/activity/comments";
/** Create a staged comment attachment upload (metadata only — no bytes). */
export const collaborationCreatePendingAttachmentInputSchema = createPendingAttachmentRequestSchema;
export type CollaborationCreatePendingAttachmentInput = CreatePendingAttachmentRequest;

/**
 * Upload staged attachment bytes over IPC as base64.
 * Renderer never sends filesystem paths; only basename + content + declared media type.
 * Max payload tracks COMMENT_ATTACHMENT_MAX_BYTES (base64 expansion ~4/3).
 */
export const collaborationUploadPendingAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    mediaType: z.string().min(1).max(128),
    bodyBase64: z
      .string()
      .min(1)
      .max(Math.ceil((COMMENT_ATTACHMENT_MAX_BYTES * 4) / 3) + 8),
    digestSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/)
      .optional()
  })
  .strict();
export type CollaborationUploadPendingAttachmentInput = z.infer<
  typeof collaborationUploadPendingAttachmentInputSchema
>;

export const collaborationFinalizePendingAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    expectedDigestSha256: commentContentSha256Schema.optional()
  })
  .strict();
export type CollaborationFinalizePendingAttachmentInput = z.infer<
  typeof collaborationFinalizePendingAttachmentInputSchema
>;

export const collaborationReadCommentAttachmentInputSchema = z
  .object({
    commentId: commentIdSchema,
    digestSha256: commentContentSha256Schema
  })
  .strict();
export type CollaborationReadCommentAttachmentInput = z.input<
  typeof collaborationReadCommentAttachmentInputSchema
>;

export const collaborationCommentAttachmentBodySchema = z
  .object({
    digestSha256: commentContentSha256Schema,
    mediaType: commentAttachmentMediaTypeSchema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    bodyBase64: z
      .string()
      .min(1)
      .max(Math.ceil((COMMENT_ATTACHMENT_MAX_BYTES * 4) / 3) + 8)
  })
  .strict();
export type CollaborationCommentAttachmentBody = z.infer<
  typeof collaborationCommentAttachmentBodySchema
>;

export const collaborationReadPendingAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    digestSha256: commentContentSha256Schema
  })
  .strict();
export type CollaborationReadPendingAttachmentInput = z.input<
  typeof collaborationReadPendingAttachmentInputSchema
>;

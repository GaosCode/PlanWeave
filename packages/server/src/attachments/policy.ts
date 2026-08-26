import { authorizeHumanAction, type HumanPolicySubject } from "../identity/policy.js";
import type { HumanAuthContext } from "../identity/schemas.js";
import {
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_STAGED_UPLOAD_MAX_TTL_MS,
  COMMENT_STAGED_UPLOAD_MIN_TTL_MS,
  COMMENT_STAGED_UPLOAD_TTL_MS
} from "../comments/limits.js";
import {
  commentAttachmentMediaTypeSchema,
  type CommentAttachmentMediaType,
  type PendingAttachmentUpload
} from "../comments/schemas.js";
import {
  ATTACHMENT_ERROR_MESSAGES,
  allowAttachment,
  denyAttachment,
  type AttachmentAuthDecision,
  type AttachmentErrorCode
} from "./errors.js";
import type { WorkspaceId } from "@planweave-ai/collaboration-protocol/core/primitives";

export type PendingUploadStatus = "pending" | "uploaded" | "finalized" | "expired" | "aborted";

export type PendingUploadRecord = PendingAttachmentUpload & {
  workspaceId: WorkspaceId;
  status: PendingUploadStatus;
  digestSha256?: string;
  uploadedAt?: string;
  finalizedAt?: string;
};

export type CommentAttachmentBinding = {
  workspaceId: WorkspaceId;
  projectId: string;
  commentId: string;
  digestSha256: string;
  sizeBytes: number;
  mediaType: CommentAttachmentMediaType;
  fileName?: string;
  createdAt: string;
  /** Soft-delete of the owning comment; attachments remain readable for audit. */
  commentTombstonedAt?: string;
};

function denial(code: AttachmentErrorCode): AttachmentAuthDecision {
  return denyAttachment(code, ATTACHMENT_ERROR_MESSAGES[code]);
}

function mapHumanAuthCode(code: string): AttachmentErrorCode {
  switch (code) {
    case "human_auth_unauthenticated":
      return "attachment_auth_unauthenticated";
    case "human_auth_project_mismatch":
      return "attachment_auth_project_mismatch";
    case "human_role_insufficient":
      return "attachment_role_insufficient";
    case "human_auth_forbidden":
    case "human_membership_required":
      return "attachment_auth_forbidden";
    case "human_input_invalid":
      return "attachment_input_invalid";
    default:
      return "attachment_auth_forbidden";
  }
}

/**
 * Project-scoped human membership for attachment ops.
 * Reuses centralized `comment` action (member/owner). Host / operator / invitation
 * bearers are never attachment principals.
 */
export function authorizeAttachmentProjectAccess(input: {
  subject: HumanPolicySubject;
  projectId: string;
}): AttachmentAuthDecision {
  if (input.subject.kind === "unauthenticated") {
    return denial("attachment_auth_unauthenticated");
  }
  if (input.subject.kind !== "human") {
    // Host-like / invitation / local-admin subjects must not authorize comment content.
    return denial("attachment_auth_forbidden");
  }
  const decision = authorizeHumanAction({
    action: "comment",
    subject: input.subject,
    facts: { targetProjectId: input.projectId }
  });
  if (decision.allowed) {
    return allowAttachment();
  }
  return denial(mapHumanAuthCode(decision.code));
}

export function evaluateAttachmentMediaAndSize(input: {
  sizeBytes: number;
  mediaType: string;
}): AttachmentAuthDecision {
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > COMMENT_ATTACHMENT_MAX_BYTES
  ) {
    return denial("attachment_size_limit");
  }
  const media = commentAttachmentMediaTypeSchema.safeParse(input.mediaType);
  if (!media.success) {
    return denial("attachment_media_type");
  }
  return allowAttachment();
}

export function evaluatePendingUploadTtlMs(ttlMs: number | undefined): AttachmentAuthDecision {
  if (ttlMs === undefined) return allowAttachment();
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < COMMENT_STAGED_UPLOAD_MIN_TTL_MS ||
    ttlMs > COMMENT_STAGED_UPLOAD_MAX_TTL_MS
  ) {
    return denial("attachment_input_invalid");
  }
  return allowAttachment();
}

export function resolvePendingUploadTtlMs(ttlMs: number | undefined): number {
  return ttlMs ?? COMMENT_STAGED_UPLOAD_TTL_MS;
}

/**
 * Stream upload and finalize: only the original uploader on the same project,
 * while the staged row is not expired and in an allowed status.
 */
export function authorizePendingUploadMutation(input: {
  subject: HumanPolicySubject;
  projectId: string;
  record: PendingUploadRecord;
  now: Date;
  requiredStatus: readonly PendingUploadStatus[];
  sameHumanPrincipal?: (left: string, right: string) => boolean;
}): AttachmentAuthDecision {
  const base = authorizeAttachmentProjectAccess({
    subject: input.subject,
    projectId: input.projectId
  });
  if (!base.allowed) return base;

  if (input.record.projectId !== input.projectId) {
    return denial("attachment_cross_project_forbidden");
  }
  if (input.subject.kind !== "human") {
    return denial("attachment_auth_forbidden");
  }
  const sameUploader = (input.sameHumanPrincipal ?? ((left, right) => left === right))(
    input.subject.context.humanPrincipalId,
    input.record.uploaderHumanPrincipalId
  );
  if (!sameUploader) {
    return denial("attachment_pending_not_uploader");
  }
  if (Date.parse(input.record.expiresAt) <= input.now.getTime()) {
    return denial("attachment_pending_expired");
  }
  if (!input.requiredStatus.includes(input.record.status)) {
    return denial("attachment_status_conflict");
  }
  return allowAttachment();
}

/**
 * Read pending/finalized staged content: any active project member (not Host).
 * Expiry still applies until finalized; finalized staged rows remain readable
 * until bound or cleaned by retention policy.
 */
export function authorizePendingUploadRead(input: {
  subject: HumanPolicySubject;
  projectId: string;
  record: PendingUploadRecord;
  now: Date;
}): AttachmentAuthDecision {
  const base = authorizeAttachmentProjectAccess({
    subject: input.subject,
    projectId: input.projectId
  });
  if (!base.allowed) return base;

  if (input.record.projectId !== input.projectId) {
    return denial("attachment_cross_project_forbidden");
  }
  if (input.record.status !== "uploaded" && input.record.status !== "finalized") {
    return denial("attachment_status_conflict");
  }
  if (
    input.record.status === "uploaded" &&
    Date.parse(input.record.expiresAt) <= input.now.getTime()
  ) {
    return denial("attachment_pending_expired");
  }
  if (!input.record.digestSha256) {
    return denial("attachment_not_found");
  }
  return allowAttachment();
}

/**
 * Read a finalized comment-bound attachment.
 * Requires human project membership; Host tokens and bare digest knowledge never authorize.
 * Tombstoned comments still allow attachment read (audit-safe; body is redacted elsewhere).
 */
export function authorizeCommentAttachmentRead(input: {
  subject: HumanPolicySubject;
  projectId: string;
  binding: CommentAttachmentBinding;
}): AttachmentAuthDecision {
  const base = authorizeAttachmentProjectAccess({
    subject: input.subject,
    projectId: input.projectId
  });
  if (!base.allowed) return base;

  if (input.binding.projectId !== input.projectId) {
    return denial("attachment_cross_project_forbidden");
  }
  return allowAttachment();
}

/**
 * Digest-only lookup is never sufficient: caller must present a project-scoped
 * pending row or comment binding. This helper only checks membership + project match.
 */
export function authorizeDigestScopedRead(input: {
  subject: HumanPolicySubject;
  projectId: string;
  referencedInProject: boolean;
}): AttachmentAuthDecision {
  const base = authorizeAttachmentProjectAccess({
    subject: input.subject,
    projectId: input.projectId
  });
  if (!base.allowed) return base;
  if (!input.referencedInProject) {
    return denial("attachment_not_found");
  }
  return allowAttachment();
}

export function humanSubject(context: HumanAuthContext): HumanPolicySubject {
  return { kind: "human", context };
}

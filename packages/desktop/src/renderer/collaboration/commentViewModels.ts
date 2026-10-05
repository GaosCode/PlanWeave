import {
  COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES,
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX_COUNT,
  HUMAN_COMMENT_BODY_MAX_LENGTH
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  type ActivityRecord,
  type ActivityType,
  type CommentDisplayProjection
} from "@planweave-ai/collaboration-protocol/activity/comments";
import { type WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationSyncPhase } from "../../shared/collaborationReadModels.js";

export type CommentsPanelMode =
  | "disconnected"
  | "connecting"
  | "ready"
  | "loading"
  | "offline"
  | "auth_expired"
  | "forbidden"
  | "error"
  | "empty";

export type CommentActionVisibility = {
  /** Author permission is independent of temporary sync write availability. */
  hasEditPermission: boolean;
  canEdit: boolean;
  canTombstone: boolean;
  reason: "author" | "owner" | "none" | "tombstoned" | "inactive_author" | "offline" | "forbidden";
};

export type SafeAttachmentDisplay = {
  /** Stable id for list keys (digest). */
  id: string;
  /** Basename-only label; never a path. */
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  /** Short digest prefix for humans; never a filesystem path. */
  digestShort: string;
};

export type CommentRowViewModel = {
  commentId: string;
  authorLabel: string;
  authorActive: boolean;
  isCurrentUser: boolean;
  body: string | null;
  bodyFormat: "markdown";
  revision: number;
  createdAt: string;
  updatedAt: string;
  tombstoned: boolean;
  tombstoneLabel: string | null;
  workItemMissing: boolean;
  attachments: SafeAttachmentDisplay[];
  actions: CommentActionVisibility;
};

export type ActivitySourceKind = ActivityRecord["source"]["kind"];

export type ActivityRowViewModel = {
  activityId: string;
  type: ActivityType;
  sourceKind: ActivitySourceKind;
  /** Human-readable source distinction (membership/assignment/comment/remote_run). */
  sourceLabelKey:
    | "activitySourceMembership"
    | "activitySourceAssignment"
    | "activitySourceComment"
    | "activitySourceRemoteRun";
  headline: string;
  occurredAt: string;
  workItemLabel: string | null;
  /** Activity rows are never clickable command targets. */
  interactive: false;
};

const allowedMediaTypeSet = new Set<string>(COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES);

export function resolveCommentsPanelMode(input: {
  sessionConnected: boolean;
  sessionPhase: string | null | undefined;
  syncPhase: CollaborationSyncPhase;
  loading: boolean;
  hasComments: boolean;
  lastErrorKind: string | null;
}): CommentsPanelMode {
  if (!input.sessionConnected) {
    if (input.sessionPhase === "connecting") return "connecting";
    return "disconnected";
  }
  if (input.syncPhase === "auth_expired") return "auth_expired";
  if (input.syncPhase === "forbidden") return "forbidden";
  if (input.syncPhase === "disconnected" || input.syncPhase === "reconnecting") return "offline";
  if (input.syncPhase === "degraded" && input.lastErrorKind === "offline") return "offline";
  if (input.loading && !input.hasComments) return "loading";
  if (input.syncPhase === "error" || input.lastErrorKind) {
    if (!input.hasComments) return "error";
  }
  if (!input.hasComments) return "empty";
  return "ready";
}

export function resolveActivityPanelMode(input: {
  sessionConnected: boolean;
  sessionPhase: string | null | undefined;
  syncPhase: CollaborationSyncPhase;
  loading: boolean;
  hasItems: boolean;
  lastErrorKind: string | null;
}): CommentsPanelMode {
  return resolveCommentsPanelMode({
    sessionConnected: input.sessionConnected,
    sessionPhase: input.sessionPhase,
    syncPhase: input.syncPhase,
    loading: input.loading,
    hasComments: input.hasItems,
    lastErrorKind: input.lastErrorKind
  });
}

/**
 * Author may edit/tombstone own live comments; project owners may tombstone others.
 * Tombstoned comments never expose edit.
 */
export function resolveCommentActions(input: {
  comment: CommentDisplayProjection;
  currentHumanPrincipalId: string | null;
  currentUserIsOwner: boolean;
  canMutate: boolean;
}): CommentActionVisibility {
  const isAuthor =
    input.currentHumanPrincipalId != null &&
    input.comment.author.humanPrincipalId === input.currentHumanPrincipalId;
  const hasEditPermission =
    !input.comment.tombstoned && isAuthor && input.comment.author.membershipActive;
  if (input.comment.tombstoned) {
    return { hasEditPermission, canEdit: false, canTombstone: false, reason: "tombstoned" };
  }
  if (!input.canMutate) {
    return { hasEditPermission, canEdit: false, canTombstone: false, reason: "offline" };
  }
  if (isAuthor) {
    if (!input.comment.author.membershipActive) {
      return { hasEditPermission, canEdit: false, canTombstone: false, reason: "inactive_author" };
    }
    return { hasEditPermission, canEdit: true, canTombstone: true, reason: "author" };
  }
  if (input.currentUserIsOwner) {
    return { hasEditPermission, canEdit: false, canTombstone: true, reason: "owner" };
  }
  return { hasEditPermission, canEdit: false, canTombstone: false, reason: "none" };
}

/**
 * Attachment labels must never include paths, tokens, or raw digests as download URLs.
 */
export function sanitizeAttachmentFileName(fileName: string | undefined): string {
  if (!fileName) return "attachment";
  const base = fileName.split(/[/\\]/).pop()?.trim() ?? "";
  let cleaned = "";
  for (let index = 0; index < base.length; index += 1) {
    const code = base.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) continue;
    cleaned += base[index];
  }
  cleaned = cleaned.trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
  return cleaned.slice(0, 255);
}

export function buildSafeAttachmentDisplay(
  attachment: CommentDisplayProjection["attachments"][number]
): SafeAttachmentDisplay {
  return {
    id: attachment.digestSha256,
    displayName: sanitizeAttachmentFileName(attachment.fileName),
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    digestShort: `${attachment.digestSha256.slice(0, 8)}…`
  };
}

export function buildCommentRowViewModel(input: {
  comment: CommentDisplayProjection;
  currentHumanPrincipalId: string | null;
  currentUserIsOwner: boolean;
  canMutate: boolean;
  removedMemberLabel: string;
  tombstonedLabel: string;
}): CommentRowViewModel {
  const { comment } = input;
  const authorLabel = comment.author.membershipActive
    ? comment.author.displayName
    : `${comment.author.displayName} (${input.removedMemberLabel})`;
  return {
    commentId: comment.commentId,
    authorLabel,
    authorActive: comment.author.membershipActive,
    isCurrentUser:
      input.currentHumanPrincipalId != null &&
      comment.author.humanPrincipalId === input.currentHumanPrincipalId,
    body: comment.tombstoned ? null : comment.body,
    bodyFormat: "markdown",
    revision: comment.revision,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    tombstoned: comment.tombstoned,
    tombstoneLabel: comment.tombstoned ? input.tombstonedLabel : null,
    workItemMissing: comment.workItemPresence === "missing",
    attachments: comment.attachments.map(buildSafeAttachmentDisplay),
    actions: resolveCommentActions({
      comment,
      currentHumanPrincipalId: input.currentHumanPrincipalId,
      currentUserIsOwner: input.currentUserIsOwner,
      canMutate: input.canMutate
    })
  };
}

export function activitySourceLabelKey(
  kind: ActivitySourceKind
): ActivityRowViewModel["sourceLabelKey"] {
  switch (kind) {
    case "membership":
      return "activitySourceMembership";
    case "assignment":
      return "activitySourceAssignment";
    case "comment":
      return "activitySourceComment";
    case "remote_run":
      return "activitySourceRemoteRun";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function formatWorkItemLabel(workItem: WorkItemRef | undefined): string | null {
  if (!workItem) return null;
  if (workItem.kind === "task") return `Task ${workItem.taskId}`;
  return `Block ${workItem.blockRef}`;
}

/**
 * Build activity rows from typed server summaries only.
 * Never treats high-volume ACP events as human activity (those are not ActivityType).
 */
export function buildActivityRowViewModel(record: ActivityRecord): ActivityRowViewModel {
  return {
    activityId: record.activityId,
    type: record.type,
    sourceKind: record.source.kind,
    sourceLabelKey: activitySourceLabelKey(record.source.kind),
    headline: record.summary.headline,
    occurredAt: record.occurredAt,
    workItemLabel: formatWorkItemLabel(record.workItem ?? record.summary.workItem),
    interactive: false
  };
}

export function isAllowedCommentMediaType(mediaType: string): boolean {
  return allowedMediaTypeSet.has(mediaType);
}

export function validateCommentBodyLength(body: string): {
  ok: boolean;
  length: number;
  max: number;
} {
  const length = [...body].length;
  return {
    ok: length >= 1 && length <= HUMAN_COMMENT_BODY_MAX_LENGTH,
    length,
    max: HUMAN_COMMENT_BODY_MAX_LENGTH
  };
}

export function validateStagedAttachmentCount(count: number): boolean {
  return count >= 0 && count <= COMMENT_ATTACHMENTS_MAX_COUNT;
}

export function validateAttachmentSizeBytes(sizeBytes: number): boolean {
  return Number.isInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= COMMENT_ATTACHMENT_MAX_BYTES;
}

/** Detect accidental path leakage in UI-facing strings. */
export function looksLikeFilesystemPath(value: string): boolean {
  if (value.includes("\0")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("/") && value.includes("/") && value.split("/").length > 2) return true;
  if (value.includes("\\") && value.includes(":")) return true;
  return false;
}

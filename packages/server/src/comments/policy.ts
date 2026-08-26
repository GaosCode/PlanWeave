import { authorizeHumanAction, type HumanPolicySubject } from "../identity/policy.js";
import {
  actorRefFromHuman,
  type HumanAuthContext,
  type ProjectMemberRole
} from "../identity/schemas.js";
import type { WorkItemPackageFacts, WorkItemRef } from "../work/schemas.js";
import {
  COMMENT_ACTIVITY_ERROR_MESSAGES,
  allowCommentActivity,
  denyCommentActivity,
  type CommentActivityAuthDecision,
  type CommentActivityErrorCode
} from "./errors.js";
import {
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX_COUNT,
  COMMENT_INITIAL_REVISION
} from "./limits.js";
import {
  commentAttachmentMediaTypeSchema,
  commentDisplayProjectionSchema,
  commentRecordSchema,
  workItemsEqual,
  type ActivitySource,
  type CommentAttachmentInput,
  type CommentAttachmentMetadata,
  type CommentCreateCommand,
  type CommentDisplayProjection,
  type CommentEditCommand,
  type CommentRecord,
  type CommentTombstoneCommand,
  type CommentWorkItemPresence
} from "./schemas.js";

function denial(code: CommentActivityErrorCode): CommentActivityAuthDecision {
  return denyCommentActivity(code, COMMENT_ACTIVITY_ERROR_MESSAGES[code]);
}

function mapHumanAuthCode(code: string): CommentActivityErrorCode {
  switch (code) {
    case "human_auth_unauthenticated":
      return "comment_auth_unauthenticated";
    case "human_auth_project_mismatch":
      return "comment_auth_project_mismatch";
    case "human_role_insufficient":
      return "comment_role_insufficient";
    case "human_auth_forbidden":
    case "human_membership_required":
      return "comment_auth_forbidden";
    case "human_input_invalid":
      return "comment_input_invalid";
    default:
      return "comment_auth_forbidden";
  }
}

/**
 * Authorization for creating comments and reading comment threads.
 * Reuses centralized human policy action `comment` (member or owner on project).
 * Host credentials and operator tokens are not comment actors.
 */
export function authorizeCommentMutation(input: {
  subject: HumanPolicySubject;
  projectId: string;
}): CommentActivityAuthDecision {
  const decision = authorizeHumanAction({
    action: "comment",
    subject: input.subject,
    facts: { targetProjectId: input.projectId }
  });
  if (decision.allowed) {
    return allowCommentActivity();
  }
  return denial(mapHumanAuthCode(decision.code));
}

/**
 * Authorization for listing activity. Reuses `view_activity` (member or owner).
 */
export function authorizeActivityList(input: {
  subject: HumanPolicySubject;
  projectId: string;
}): CommentActivityAuthDecision {
  const decision = authorizeHumanAction({
    action: "view_activity",
    subject: input.subject,
    facts: { targetProjectId: input.projectId }
  });
  if (decision.allowed) {
    return allowCommentActivity();
  }
  return denial(
    decision.code === "human_auth_unauthenticated"
      ? "comment_auth_unauthenticated"
      : decision.code === "human_auth_project_mismatch"
        ? "comment_auth_project_mismatch"
        : "activity_auth_forbidden"
  );
}

/**
 * Create requires a current Plan Package WorkItemRef.
 * Removed/renamed items cannot receive new comments under a missing ref.
 */
export function evaluateCommentCreateWorkItem(input: {
  workItem: WorkItemRef;
  packageFacts: WorkItemPackageFacts;
}): CommentActivityAuthDecision {
  if (!input.packageFacts.exists) {
    return denial("comment_work_item_not_found");
  }
  if (input.packageFacts.kind !== input.workItem.kind) {
    return denial("comment_work_item_not_found");
  }
  if (input.packageFacts.canvasId !== input.workItem.canvasId) {
    return denial("comment_work_item_not_found");
  }
  if (input.workItem.kind === "task") {
    if (input.packageFacts.taskId !== input.workItem.taskId) {
      return denial("comment_work_item_not_found");
    }
  } else if (input.packageFacts.blockRef !== input.workItem.blockRef) {
    return denial("comment_work_item_not_found");
  }
  return allowCommentActivity();
}

/**
 * Presence for projections. Rename is a new WorkItemRef — old comments stay on the old key.
 */
export function resolveCommentWorkItemPresence(
  packageFacts: WorkItemPackageFacts
): CommentWorkItemPresence {
  return packageFacts.exists ? "present" : "missing";
}

/**
 * Attachment input validation (count/size/media). Staged blob verification is B-002.
 */
export function evaluateCommentAttachments(
  attachments: readonly CommentAttachmentInput[]
): CommentActivityAuthDecision {
  if (attachments.length > COMMENT_ATTACHMENTS_MAX_COUNT) {
    return denial("comment_attachment_limit");
  }
  for (const attachment of attachments) {
    if (
      !Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes < 1 ||
      attachment.sizeBytes > COMMENT_ATTACHMENT_MAX_BYTES
    ) {
      return denial("comment_attachment_size");
    }
    const media = commentAttachmentMediaTypeSchema.safeParse(attachment.mediaType);
    if (!media.success) {
      return denial("comment_attachment_media_type");
    }
  }
  return allowCommentActivity();
}

/**
 * Compare-and-set revision check for edit/tombstone.
 * expectedRevision must equal the durable current revision (always positive once stored).
 */
export function evaluateCommentRevision(input: {
  expectedRevision: number;
  currentRevision: number;
}): CommentActivityAuthDecision {
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !Number.isInteger(input.currentRevision) ||
    input.currentRevision < 1
  ) {
    return denial("comment_input_invalid");
  }
  if (input.expectedRevision !== input.currentRevision) {
    return denial("comment_revision_conflict");
  }
  return allowCommentActivity();
}

/**
 * Edit body: active project human membership + comment author only.
 * Owners may moderate via tombstone, not silent body rewrite of others' comments.
 * Hosts never edit comments.
 */
export function authorizeCommentEdit(input: {
  subject: HumanPolicySubject;
  projectId: string;
  record: CommentRecord;
  sameHumanPrincipal?: (left: string, right: string) => boolean;
}): CommentActivityAuthDecision {
  const base = authorizeCommentMutation({
    subject: input.subject,
    projectId: input.projectId
  });
  if (!base.allowed) return base;

  if (input.record.projectId !== input.projectId) {
    return denial("comment_cross_project_forbidden");
  }
  if (input.record.tombstonedAt !== undefined) {
    return denial("comment_already_tombstoned");
  }
  if (input.subject.kind !== "human") {
    return denial("comment_author_required");
  }
  if (
    !(input.sameHumanPrincipal ?? ((left, right) => left === right))(
      input.subject.context.humanPrincipalId,
      input.record.authorHumanPrincipalId
    )
  ) {
    return denial("comment_not_author");
  }
  return allowCommentActivity();
}

/**
 * Tombstone: author or project owner (moderation). Membership must be active human.
 * Idempotent second tombstone is rejected with comment_already_tombstoned.
 */
export function authorizeCommentTombstone(input: {
  subject: HumanPolicySubject;
  projectId: string;
  record: CommentRecord;
  sameHumanPrincipal?: (left: string, right: string) => boolean;
}): CommentActivityAuthDecision {
  const base = authorizeCommentMutation({
    subject: input.subject,
    projectId: input.projectId
  });
  if (!base.allowed) return base;

  if (input.record.projectId !== input.projectId) {
    return denial("comment_cross_project_forbidden");
  }
  if (input.record.tombstonedAt !== undefined) {
    return denial("comment_already_tombstoned");
  }
  if (input.subject.kind !== "human") {
    return denial("comment_author_required");
  }

  const context = input.subject.context;
  const isAuthor = (input.sameHumanPrincipal ?? ((left, right) => left === right))(
    context.humanPrincipalId,
    input.record.authorHumanPrincipalId
  );
  const isOwner = context.role === "owner";
  if (!isAuthor && !isOwner) {
    return denial("comment_role_insufficient");
  }
  return allowCommentActivity();
}

export type CommentCreateDecision =
  | {
      ok: true;
      record: CommentRecord;
    }
  | {
      ok: false;
      code: CommentActivityErrorCode;
      message: string;
    };

/**
 * Pure create decision (auth + work item + attachments). Caller supplies commentId and now.
 * Does not write storage and does not mutate Plan Package / Runtime state.
 */
export function decideCommentCreate(input: {
  command: CommentCreateCommand;
  packageFacts: WorkItemPackageFacts;
  commentId: string;
  now: Date;
  /** Resolved attachment metadata after staged finalize; length must match command.attachments. */
  finalizedAttachments?: CommentAttachmentMetadata[];
}): CommentCreateDecision {
  const { command } = input;

  if (command.actor.projectId !== command.projectId) {
    return {
      ok: false,
      code: "comment_auth_project_mismatch",
      message: COMMENT_ACTIVITY_ERROR_MESSAGES.comment_auth_project_mismatch
    };
  }

  const auth = authorizeCommentMutation({
    subject: { kind: "human", context: command.actor },
    projectId: command.projectId
  });
  if (!auth.allowed) {
    return { ok: false, code: auth.code, message: auth.message };
  }

  const workItem = evaluateCommentCreateWorkItem({
    workItem: command.workItem,
    packageFacts: input.packageFacts
  });
  if (!workItem.allowed) {
    return { ok: false, code: workItem.code, message: workItem.message };
  }

  const attachments = evaluateCommentAttachments(command.attachments);
  if (!attachments.allowed) {
    return { ok: false, code: attachments.code, message: attachments.message };
  }

  const finalized = input.finalizedAttachments ?? [];
  if (finalized.length !== command.attachments.length) {
    return {
      ok: false,
      code: "comment_input_invalid",
      message: COMMENT_ACTIVITY_ERROR_MESSAGES.comment_input_invalid
    };
  }

  const iso = input.now.toISOString();
  const record = commentRecordSchema.parse({
    commentId: input.commentId,
    projectId: command.projectId,
    workItem: command.workItem,
    authorHumanPrincipalId: command.actor.humanPrincipalId,
    body: command.body,
    bodyFormat: "markdown",
    revision: COMMENT_INITIAL_REVISION,
    createdAt: iso,
    updatedAt: iso,
    attachments: finalized
  });

  return { ok: true, record };
}

export type CommentEditDecision =
  | {
      ok: true;
      record: CommentRecord;
      previousRevision: number;
    }
  | {
      ok: false;
      code: CommentActivityErrorCode;
      message: string;
    };

/**
 * Pure edit decision. Body-only; CAS revision; author-only.
 * Allowed even when the WorkItemRef is missing from the package (orphan cleanup/annotation).
 */
export function decideCommentEdit(input: {
  command: CommentEditCommand;
  current: CommentRecord;
  now: Date;
  sameHumanPrincipal?: (left: string, right: string) => boolean;
}): CommentEditDecision {
  const { command, current } = input;

  if (current.commentId !== command.commentId) {
    return {
      ok: false,
      code: "comment_not_found",
      message: COMMENT_ACTIVITY_ERROR_MESSAGES.comment_not_found
    };
  }

  const auth = authorizeCommentEdit({
    subject: { kind: "human", context: command.actor },
    projectId: command.projectId,
    record: current,
    sameHumanPrincipal: input.sameHumanPrincipal
  });
  if (!auth.allowed) {
    return { ok: false, code: auth.code, message: auth.message };
  }

  const revision = evaluateCommentRevision({
    expectedRevision: command.expectedRevision,
    currentRevision: current.revision
  });
  if (!revision.allowed) {
    return { ok: false, code: revision.code, message: revision.message };
  }

  const next = commentRecordSchema.parse({
    ...current,
    body: command.body,
    revision: current.revision + 1,
    updatedAt: input.now.toISOString()
  });

  return { ok: true, record: next, previousRevision: current.revision };
}

export type CommentTombstoneDecision =
  | {
      ok: true;
      record: CommentRecord;
      previousRevision: number;
    }
  | {
      ok: false;
      code: CommentActivityErrorCode;
      message: string;
    };

/**
 * Pure tombstone decision. Soft-delete with audit markers; body retained on durable record.
 */
export function decideCommentTombstone(input: {
  command: CommentTombstoneCommand;
  current: CommentRecord;
  now: Date;
  sameHumanPrincipal?: (left: string, right: string) => boolean;
}): CommentTombstoneDecision {
  const { command, current } = input;

  if (current.commentId !== command.commentId) {
    return {
      ok: false,
      code: "comment_not_found",
      message: COMMENT_ACTIVITY_ERROR_MESSAGES.comment_not_found
    };
  }

  const auth = authorizeCommentTombstone({
    subject: { kind: "human", context: command.actor },
    projectId: command.projectId,
    record: current,
    sameHumanPrincipal: input.sameHumanPrincipal
  });
  if (!auth.allowed) {
    return { ok: false, code: auth.code, message: auth.message };
  }

  const revision = evaluateCommentRevision({
    expectedRevision: command.expectedRevision,
    currentRevision: current.revision
  });
  if (!revision.allowed) {
    return { ok: false, code: revision.code, message: revision.message };
  }

  const iso = input.now.toISOString();
  const next = commentRecordSchema.parse({
    ...current,
    revision: current.revision + 1,
    updatedAt: iso,
    tombstonedAt: iso,
    tombstonedBy: actorRefFromHuman(command.actor),
    tombstoneReason: command.reason
  });

  return { ok: true, record: next, previousRevision: current.revision };
}

/**
 * Build display projection from durable record + live membership/package facts.
 * Redacts body when tombstoned. Never used for authorization.
 */
export function projectCommentDisplay(input: {
  record: CommentRecord;
  authorDisplayName: string;
  authorMembershipActive: boolean;
  packageFacts: WorkItemPackageFacts;
}): CommentDisplayProjection {
  const { record } = input;
  const tombstoned = record.tombstonedAt !== undefined;
  return commentDisplayProjectionSchema.parse({
    commentId: record.commentId,
    projectId: record.projectId,
    workItem: record.workItem,
    author: {
      humanPrincipalId: record.authorHumanPrincipalId,
      displayName: input.authorDisplayName,
      membershipActive: input.authorMembershipActive
    },
    body: tombstoned ? null : record.body,
    bodyFormat: record.bodyFormat,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tombstoned,
    tombstonedAt: record.tombstonedAt,
    tombstonedBy: record.tombstonedBy,
    attachments: record.attachments.map((attachment) => ({
      digestSha256: attachment.digestSha256,
      sizeBytes: attachment.sizeBytes,
      mediaType: attachment.mediaType,
      fileName: attachment.fileName
    })),
    workItemPresence: resolveCommentWorkItemPresence(input.packageFacts)
  });
}

/**
 * Activity source idempotency key. Duplicates are not errors at the contract layer —
 * repositories treat insert of the same key as a no-op (activity_source_duplicate for diagnostics).
 */
export function activitySourceIdempotencyKey(input: {
  projectId: string;
  source: ActivitySource;
}): string {
  return `${input.projectId}\0${input.source.kind}\0${input.source.sourceId}`;
}

/**
 * Whether a human may list comments for a work item (membership on project).
 * Work item missing does not deny list — orphaned comments remain readable.
 */
export function authorizeCommentList(input: {
  subject: HumanPolicySubject;
  projectId: string;
}): CommentActivityAuthDecision {
  return authorizeCommentMutation(input);
}

export function humanSubjectForComment(context: HumanAuthContext): HumanPolicySubject {
  return { kind: "human", context };
}

export function isOwnerRole(role: ProjectMemberRole): boolean {
  return role === "owner";
}

/** Filter helper: comment belongs to exact query scope (project + WorkItemRef). */
export function commentMatchesScope(
  record: CommentRecord,
  projectId: string,
  workItem: WorkItemRef
): boolean {
  return record.projectId === projectId && workItemsEqual(record.workItem, workItem);
}

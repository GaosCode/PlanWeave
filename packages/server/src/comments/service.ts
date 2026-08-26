import { ZodError } from "zod";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CommentAttachmentRepository } from "../attachments/repository.js";
import type { CommentAttachmentService } from "../attachments/service.js";
import type { HumanIdentityRepository } from "../identity/repository.js";
import {
  humanAuthContextSchema,
  humanProjectIdSchema,
  type HumanAuthContext,
  type ProjectMemberRole
} from "../identity/schemas.js";
import { inWriteTransaction } from "../sqlite.js";
import type { WorkItemPackageFacts, WorkItemRef } from "../work/schemas.js";
import type { WorkItemPackagePort } from "../work/workItemFacts.js";
import { ActivityRepository, ActivityRepositoryError } from "./activityRepository.js";
import {
  buildAssignmentActivity,
  buildCommentActivity,
  buildMembershipActivity,
  buildRemoteRunActivity,
  type AssignmentActivityInput,
  type MembershipActivityInput,
  type RemoteRunActivityInput
} from "./activityProjection.js";
import { nextActivityCursor, nextCommentCursor } from "./cursor.js";
import { COMMENT_ACTIVITY_ERROR_MESSAGES, type CommentActivityErrorCode } from "./errors.js";
import {
  ACTIVITY_LIST_PAGE_DEFAULT,
  ACTIVITY_RETENTION_MAX_AGE_MS,
  COMMENT_LIST_PAGE_DEFAULT
} from "./limits.js";
import {
  authorizeActivityList,
  authorizeCommentList,
  decideCommentCreate,
  decideCommentEdit,
  decideCommentTombstone,
  projectCommentDisplay
} from "./policy.js";
import { CommentRepository, CommentRepositoryError } from "./repository.js";
import {
  activityListCursorSchema,
  activityListQuerySchema,
  commentCreateCommandSchema,
  commentEditCommandSchema,
  commentListQuerySchema,
  commentTombstoneCommandSchema,
  type ActivityListPage,
  type ActivityRecord,
  type CommentDisplayProjection,
  type CommentListPage,
  type CommentRecord
} from "./schemas.js";

export class CommentServiceError extends Error {
  constructor(
    readonly code: CommentActivityErrorCode,
    message: string = COMMENT_ACTIVITY_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "CommentServiceError";
  }
}

function deny(code: CommentActivityErrorCode, message?: string): never {
  throw new CommentServiceError(code, message ?? COMMENT_ACTIVITY_ERROR_MESSAGES[code]);
}

function mapUnknown(error: unknown): never {
  if (error instanceof CommentServiceError) throw error;
  if (error instanceof CommentRepositoryError) {
    throw new CommentServiceError(error.code, error.message);
  }
  if (error instanceof ActivityRepositoryError) {
    throw new CommentServiceError(error.code, error.message);
  }
  if (error instanceof ZodError) {
    throw new CommentServiceError("comment_input_invalid");
  }
  if (error instanceof Error) {
    const name = error.name;
    if (name === "CommentAttachmentServiceError" || name === "AttachmentRepositoryError") {
      const code = (error as { code?: string }).code;
      if (code === "attachment_auth_forbidden" || code === "attachment_auth_unauthenticated") {
        deny("comment_auth_forbidden");
      }
      if (code === "attachment_auth_project_mismatch") {
        deny("comment_auth_project_mismatch");
      }
      if (
        code === "attachment_pending_not_found" ||
        code === "attachment_not_found" ||
        code === "attachment_status_conflict" ||
        code === "attachment_digest_mismatch" ||
        code === "attachment_size_mismatch" ||
        code === "attachment_media_type" ||
        code === "attachment_input_invalid"
      ) {
        deny("comment_input_invalid", error.message);
      }
    }
  }
  throw error;
}

export type CommentServiceOptions = {
  /** Workspace scope for attachment finalization and binding. */
  workspaceId: string;
  comments: CommentRepository;
  activity: ActivityRepository;
  packagePort: WorkItemPackagePort;
  identity: HumanIdentityRepository;
  /** Finalize/resolve staged uploads for create. */
  attachments?: CommentAttachmentService;
  /** Unlocked bind/tombstone markers inside comment transactions. */
  attachmentRepository?: CommentAttachmentRepository;
  /** Server-owned ACL check at the exact canvas scope before any durable comment write. */
  authorizeMutation(actor: HumanAuthContext, workItem: WorkItemRef): void;
  /** Exact workspace membership projection for comment author display state. */
  authorMembershipActive(humanPrincipalId: string): boolean;
  assertMembership?: (actor: HumanAuthContext, projectId: string) => void;
  clock?: () => Date;
};

/**
 * Application service for scoped comments and activity feed reads.
 *
 * Validation order on create:
 * 1. Schema parse
 * 2. Package WorkItemRef + membership policy (via decideCommentCreate)
 * 3. Finalize staged attachments
 * 4. Transaction: comment row + attachment bindings + activity outbox/projection
 *
 * Edits/tombstones use compare-and-set revision checks. Activity projection for
 * membership/assignment/remote-run is explicit via {@link ActivityProjectionService}.
 */
export class CommentService {
  private readonly comments: CommentRepository;
  private readonly activity: ActivityRepository;
  private readonly packagePort: WorkItemPackagePort;
  private readonly identity: HumanIdentityRepository;
  private readonly attachments?: CommentAttachmentService;
  private readonly attachmentRepository?: CommentAttachmentRepository;
  private readonly authorizeMutation: CommentServiceOptions["authorizeMutation"];
  private readonly authorMembershipActive: CommentServiceOptions["authorMembershipActive"];
  private readonly membershipAssertion?: CommentServiceOptions["assertMembership"];
  private readonly workspaceId: string;
  private readonly clock: () => Date;

  constructor(options: CommentServiceOptions) {
    this.comments = options.comments;
    this.activity = options.activity;
    this.packagePort = options.packagePort;
    this.identity = options.identity;
    this.attachments = options.attachments;
    this.attachmentRepository = options.attachmentRepository;
    this.authorizeMutation = options.authorizeMutation;
    this.authorMembershipActive = options.authorMembershipActive;
    this.membershipAssertion = options.assertMembership;
    this.workspaceId = workspaceIdSchema.parse(options.workspaceId);
    this.clock = options.clock ?? (() => new Date());
  }

  createComment(commandInput: unknown): {
    record: CommentRecord;
    display: CommentDisplayProjection;
  } {
    try {
      const command = commentCreateCommandSchema.parse(commandInput);
      if (command.actor.projectId !== command.projectId) {
        deny("comment_auth_project_mismatch");
      }
      this.assertActiveMembership(command.actor, command.projectId);
      this.authorizeMutation(command.actor, command.workItem);

      const packageFacts = this.packagePort.resolveWorkItem(command.workItem);
      const now = this.clock();
      const commentId = this.comments.allocateCommentId();

      const finalized = command.attachments.map((attachment) => {
        if (!this.attachments) {
          deny("comment_input_invalid", "Attachment pipeline is not configured.");
        }
        const { metadata } = this.attachments.finalize({
          actor: command.actor,
          workspaceId: this.workspaceId,
          projectId: command.projectId,
          pendingUploadId: attachment.pendingUploadId,
          expectedDigestSha256: attachment.digestSha256
        });
        return metadata;
      });

      const decision = decideCommentCreate({
        command,
        packageFacts,
        commentId,
        now,
        finalizedAttachments: finalized
      });
      if (!decision.ok) {
        deny(decision.code, decision.message);
      }

      const stored = inWriteTransaction(this.comments.database, () => {
        const inserted = this.comments.insertUnlocked(decision.record);
        if (inserted.attachments.length > 0) {
          if (!this.attachmentRepository) {
            deny("comment_input_invalid", "Attachment repository is not configured.");
          }
          this.attachmentRepository.bindCommentAttachmentsUnlocked({
            workspaceId: this.workspaceId,
            projectId: inserted.projectId,
            commentId: inserted.commentId,
            attachments: inserted.attachments,
            createdAt: inserted.createdAt
          });
        }

        const activity = buildCommentActivity({
          activityId: this.activity.allocateActivityId(),
          projectId: inserted.projectId,
          type: "comment_created",
          commentId: inserted.commentId,
          workItem: inserted.workItem,
          authorHumanPrincipalId: inserted.authorHumanPrincipalId,
          authorDisplayName: command.actor.displayName,
          revision: inserted.revision,
          occurredAt: now.toISOString()
        });
        this.activity.enqueueAndProjectUnlocked(activity, now.toISOString());
        return inserted;
      });

      return {
        record: stored,
        display: this.projectDisplay(stored, packageFacts)
      };
    } catch (error) {
      mapUnknown(error);
    }
  }

  editComment(commandInput: unknown): {
    record: CommentRecord;
    previousRevision: number;
    display: CommentDisplayProjection;
  } {
    try {
      const command = commentEditCommandSchema.parse(commandInput);
      this.assertActiveMembership(command.actor, command.projectId);
      const current = this.comments.getRequired(command.projectId, command.commentId);
      this.authorizeMutation(command.actor, current.workItem);
      const now = this.clock();
      const decision = decideCommentEdit({
        command,
        current,
        now,
        sameHumanPrincipal: (left, right) => this.identity.areEquivalent(left, right)
      });
      if (!decision.ok) {
        deny(decision.code, decision.message);
      }

      const stored = inWriteTransaction(this.comments.database, () => {
        const updated = this.comments.applyCasUpdateUnlocked({
          record: decision.record,
          expectedRevision: decision.previousRevision
        });
        const activity = buildCommentActivity({
          activityId: this.activity.allocateActivityId(),
          projectId: updated.projectId,
          type: "comment_edited",
          commentId: updated.commentId,
          workItem: updated.workItem,
          authorHumanPrincipalId: updated.authorHumanPrincipalId,
          authorDisplayName: command.actor.displayName,
          revision: updated.revision,
          occurredAt: now.toISOString()
        });
        this.activity.enqueueAndProjectUnlocked(activity, now.toISOString());
        return updated;
      });

      const packageFacts = this.packagePort.resolveWorkItem(stored.workItem);
      return {
        record: stored,
        previousRevision: decision.previousRevision,
        display: this.projectDisplay(stored, packageFacts)
      };
    } catch (error) {
      mapUnknown(error);
    }
  }

  tombstoneComment(commandInput: unknown): {
    record: CommentRecord;
    previousRevision: number;
    display: CommentDisplayProjection;
  } {
    try {
      const command = commentTombstoneCommandSchema.parse(commandInput);
      this.assertActiveMembership(command.actor, command.projectId);
      const current = this.comments.getRequired(command.projectId, command.commentId);
      this.authorizeMutation(command.actor, current.workItem);
      const now = this.clock();
      const decision = decideCommentTombstone({
        command,
        current,
        now,
        sameHumanPrincipal: (left, right) => this.identity.areEquivalent(left, right)
      });
      if (!decision.ok) {
        deny(decision.code, decision.message);
      }

      const stored = inWriteTransaction(this.comments.database, () => {
        const updated = this.comments.applyCasUpdateUnlocked({
          record: decision.record,
          expectedRevision: decision.previousRevision
        });
        if (this.attachmentRepository && updated.tombstonedAt) {
          this.attachmentRepository.setCommentTombstoned({
            workspaceId: this.workspaceId,
            projectId: updated.projectId,
            commentId: updated.commentId,
            tombstonedAt: updated.tombstonedAt
          });
        }
        const activity = buildCommentActivity({
          activityId: this.activity.allocateActivityId(),
          projectId: updated.projectId,
          type: "comment_tombstoned",
          commentId: updated.commentId,
          workItem: updated.workItem,
          authorHumanPrincipalId: command.actor.humanPrincipalId,
          authorDisplayName: command.actor.displayName,
          revision: updated.revision,
          occurredAt: now.toISOString()
        });
        this.activity.enqueueAndProjectUnlocked(activity, now.toISOString());
        return updated;
      });

      const packageFacts = this.packagePort.resolveWorkItem(stored.workItem);
      return {
        record: stored,
        previousRevision: decision.previousRevision,
        display: this.projectDisplay(stored, packageFacts)
      };
    } catch (error) {
      mapUnknown(error);
    }
  }

  listComments(queryInput: unknown): CommentListPage {
    try {
      const query = commentListQuerySchema.parse({
        limit: COMMENT_LIST_PAGE_DEFAULT,
        includeTombstoned: false,
        ...((queryInput as object) ?? {})
      });
      this.assertActiveMembership(query.actor, query.projectId);
      const auth = authorizeCommentList({
        subject: { kind: "human", context: query.actor },
        projectId: query.projectId
      });
      if (!auth.allowed) {
        deny(auth.code, auth.message);
      }

      const fetchLimit = query.limit + 1;
      const rows = this.comments.listByWorkItem({
        projectId: query.projectId,
        workItem: query.workItem,
        limit: fetchLimit,
        cursor: query.cursor,
        includeTombstoned: query.includeTombstoned
      });
      const pageRows = rows.slice(0, query.limit);
      const packageFacts = this.packagePort.resolveWorkItem(query.workItem);
      const items = pageRows.map((record) => this.projectDisplay(record, packageFacts));
      const nextCursor =
        rows.length > query.limit ? nextCommentCursor(pageRows, query.limit) : null;
      return { items, nextCursor };
    } catch (error) {
      mapUnknown(error);
    }
  }

  listActivity(queryInput: unknown): ActivityListPage {
    try {
      const query = activityListQuerySchema.parse({
        limit: ACTIVITY_LIST_PAGE_DEFAULT,
        ...((queryInput as object) ?? {})
      });
      this.assertActiveMembership(query.actor, query.projectId);
      const auth = authorizeActivityList({
        subject: { kind: "human", context: query.actor },
        projectId: query.projectId
      });
      if (!auth.allowed) {
        deny(auth.code, auth.message);
      }

      const fetchLimit = query.limit + 1;
      const rows = this.activity.list({
        projectId: query.projectId,
        workItem: query.workItem,
        limit: fetchLimit,
        cursor: query.cursor
      });
      const pageRows = rows.slice(0, query.limit);
      const nextCursor =
        rows.length > query.limit ? nextActivityCursor(pageRows, query.limit) : null;
      return { items: pageRows, nextCursor };
    } catch (error) {
      mapUnknown(error);
    }
  }

  private projectDisplay(
    record: CommentRecord,
    packageFacts: WorkItemPackageFacts
  ): CommentDisplayProjection {
    const principal = this.identity.getPrincipal(record.authorHumanPrincipalId);
    return projectCommentDisplay({
      record,
      authorDisplayName: principal?.displayName ?? record.authorHumanPrincipalId,
      authorMembershipActive: this.authorMembershipActive(record.authorHumanPrincipalId),
      packageFacts
    });
  }

  /**
   * Re-check durable membership so stale auth contexts after remove/revoke fail closed.
   * Role on the context must still match the active membership role.
   */
  private assertActiveMembership(actor: HumanAuthContext, projectId: string): void {
    if (this.membershipAssertion) {
      this.membershipAssertion(actor, projectId);
      return;
    }
    const membership = this.identity.getActiveMembership(projectId, actor.humanPrincipalId);
    if (!membership) {
      deny("comment_auth_forbidden");
    }
    if (membership.role !== actor.role) {
      deny("comment_role_insufficient");
    }
  }
}

/**
 * Explicit activity projection for membership, assignment, and remote-run sources.
 * Call after successful domain mutations. Not an event bus; excludes ACP token/tool noise.
 */
export class ActivityProjectionService {
  private readonly activity: ActivityRepository;
  private readonly clock: () => Date;

  constructor(options: { activity: ActivityRepository; clock?: () => Date }) {
    this.activity = options.activity;
    this.clock = options.clock ?? (() => new Date());
  }

  projectMembershipEvent(
    input: Omit<MembershipActivityInput, "activityId" | "occurredAt"> & {
      occurredAt?: string;
    }
  ): { record: ActivityRecord; inserted: boolean } {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const record = buildMembershipActivity({
      ...input,
      activityId: this.activity.allocateActivityId(),
      occurredAt
    });
    const result = this.activity.enqueueAndProject(record, occurredAt);
    return { record: result.record, inserted: result.inserted };
  }

  /** Caller must already own the SQLite write transaction for the domain transition. */
  projectMembershipEventInCallerTransaction(
    input: Omit<MembershipActivityInput, "activityId" | "occurredAt"> & {
      occurredAt?: string;
    }
  ): { record: ActivityRecord; inserted: boolean } {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const record = buildMembershipActivity({
      ...input,
      activityId: this.activity.allocateActivityId(),
      occurredAt
    });
    const result = this.activity.enqueueAndProjectUnlocked(record, occurredAt);
    return { record: result.record, inserted: result.inserted };
  }

  projectAssignmentEvent(
    input: Omit<AssignmentActivityInput, "activityId" | "occurredAt"> & {
      occurredAt?: string;
    }
  ): { record: ActivityRecord; inserted: boolean } {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const record = buildAssignmentActivity({
      ...input,
      activityId: this.activity.allocateActivityId(),
      occurredAt
    });
    const result = this.activity.enqueueAndProject(record, occurredAt);
    return { record: result.record, inserted: result.inserted };
  }

  /** Caller must already own the SQLite write transaction for the domain transition. */
  projectAssignmentEventInCallerTransaction(
    input: Omit<AssignmentActivityInput, "activityId" | "occurredAt"> & {
      occurredAt?: string;
    }
  ): { record: ActivityRecord; inserted: boolean } {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const record = buildAssignmentActivity({
      ...input,
      activityId: this.activity.allocateActivityId(),
      occurredAt
    });
    const result = this.activity.enqueueAndProjectUnlocked(record, occurredAt);
    return { record: result.record, inserted: result.inserted };
  }

  projectRemoteRunEvent(
    input: Omit<RemoteRunActivityInput, "activityId" | "occurredAt"> & {
      occurredAt?: string;
    }
  ): { record: ActivityRecord; inserted: boolean } {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const record = buildRemoteRunActivity({
      ...input,
      activityId: this.activity.allocateActivityId(),
      occurredAt
    });
    const result = this.activity.enqueueAndProject(record, occurredAt);
    return { record: result.record, inserted: result.inserted };
  }

  /** Caller must already own the SQLite write transaction for the domain transition. */
  projectRemoteRunEventInCallerTransaction(
    input: Omit<RemoteRunActivityInput, "activityId" | "occurredAt"> & {
      occurredAt?: string;
    }
  ): { record: ActivityRecord; inserted: boolean } {
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const record = buildRemoteRunActivity({
      ...input,
      activityId: this.activity.allocateActivityId(),
      occurredAt
    });
    const result = this.activity.enqueueAndProjectUnlocked(record, occurredAt);
    return { record: result.record, inserted: result.inserted };
  }

  /** Recover projection gaps: flush unprojected outbox rows (idempotent). */
  reconcileOutbox(limit = 100): { processed: number; inserted: number; duplicates: number } {
    const cutoff = new Date(this.clock().getTime() - ACTIVITY_RETENTION_MAX_AGE_MS).toISOString();
    return this.activity.reconcileOutbox(limit, cutoff);
  }

  listForActor(
    actor: HumanAuthContext,
    projectId: string,
    options: { workItem?: WorkItemRef; limit?: number; cursor?: unknown } = {}
  ): ActivityListPage {
    const context = humanAuthContextSchema.parse(actor);
    const pid = humanProjectIdSchema.parse(projectId);
    const auth = authorizeActivityList({
      subject: { kind: "human", context },
      projectId: pid
    });
    if (!auth.allowed) {
      throw new CommentServiceError(auth.code, auth.message);
    }
    // Callers that need durable membership checks should use CommentService.listActivity.
    const limit = options.limit ?? ACTIVITY_LIST_PAGE_DEFAULT;
    const fetchLimit = limit + 1;
    const cursor =
      options.cursor === undefined ? undefined : activityListCursorSchema.parse(options.cursor);
    const rows = this.activity.list({
      projectId: pid,
      workItem: options.workItem,
      limit: fetchLimit,
      cursor
    });
    const pageRows = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? nextActivityCursor(pageRows, limit) : null;
    return { items: pageRows, nextCursor };
  }
}

export function membershipRoleLabel(role: ProjectMemberRole): ProjectMemberRole {
  return role;
}

import {
  activityListWireQuerySchema,
  commentCreateWireCommandSchema,
  commentEditWireCommandSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema,
  type ActivityListPage,
  type CommentDisplayProjection,
  type CommentListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";
import {
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema,
  eligibleHostBatchRequestSchema,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type EligibleAssigneesResponse,
  type EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import {
  createPendingAttachmentRequestSchema,
  type FinalizePendingAttachmentResponse,
  type PendingAttachmentView
} from "@planweave-ai/collaboration-protocol/activity/attachments";
import {
  workItemRefSchema,
  type WorkItemRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  type ResponsibilityReadModel,
  type CollaborationWorkScope
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import { type ReviewAssignmentReadModel } from "@planweave-ai/collaboration-protocol/work/review";
import { type WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import {
  collaborationResponsibilityUpdateInputSchema,
  collaborationReviewerUpdateInputSchema,
  collaborationWorkAuthorityScopeInputSchema
} from "../../shared/collaborationReadModels.js";
import {
  collaborationCommentAttachmentBodySchema,
  collaborationFinalizePendingAttachmentInputSchema,
  collaborationReadCommentAttachmentInputSchema,
  collaborationReadPendingAttachmentInputSchema,
  collaborationUploadPendingAttachmentInputSchema
} from "../../shared/collaboration.js";
import type { CollaborationCommentAttachmentBody } from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

function workItemPayload(input: unknown): { workItem: WorkItemRef } {
  if (!input || typeof input !== "object" || !("workItem" in input)) {
    throw new CollaborationClientError({
      kind: "validation",
      code: "collaboration_work_item_required",
      message: "workItem is required.",
      retryable: false
    });
  }
  return { workItem: workItemRefSchema.parse((input as { workItem: unknown }).workItem) };
}

/**
 * Assignment/comment/activity/attachment read-model and mutation seam.
 * Host supplies active-client access and authority scope resolution.
 */
export class CollaborationReadMutationsFacade {
  constructor(
    private readonly withActiveClient: <T>(
      operation: (client: CollaborationClient) => Promise<T>
    ) => Promise<T>,
    private readonly toAuthorityScope: (
      client: CollaborationClient,
      workItem: WorkItemRef
    ) => Promise<CollaborationWorkScope>
  ) {}

  listAssignments(input: unknown = {}): Promise<AssignmentListPage> {
    return this.withActiveClient((client) =>
      client.listAssignments(assignmentListQuerySchema.parse(input ?? {}))
    );
  }

  getAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    const { workItem } = workItemPayload(input);
    return this.withActiveClient((client) => client.getAssignment(workItem));
  }

  listEligibleAssignees(input: unknown): Promise<EligibleAssigneesResponse> {
    const { workItem } = workItemPayload(input);
    return this.withActiveClient((client) => client.listEligibleAssignees(workItem));
  }

  listEligibleHostsBatch(input: unknown): Promise<EligibleHostBatchResponse> {
    const request = eligibleHostBatchRequestSchema.parse(input);
    return this.withActiveClient((client) => client.listEligibleHostsBatch(request));
  }

  getWorkAuthority(input: unknown): Promise<WorkAuthorityProjection> {
    const { workItem } = collaborationWorkAuthorityScopeInputSchema.parse(input);
    return this.withActiveClient(async (client) => {
      const scope = await this.toAuthorityScope(client, workItem);
      return client.getWorkAuthority(scope);
    });
  }

  updateResponsibility(input: unknown): Promise<ResponsibilityReadModel> {
    const command = collaborationResponsibilityUpdateInputSchema.parse(input);
    return this.withActiveClient(async (client) => {
      const scope = await this.toAuthorityScope(client, command.workItem);
      return client.updateResponsibility({
        schemaVersion: "responsibility/v1",
        scope,
        principal: command.principal,
        expectedRevision: command.expectedRevision,
        ...(command.reason === undefined ? {} : { reason: command.reason })
      });
    });
  }

  updateReviewer(input: unknown): Promise<ReviewAssignmentReadModel> {
    const command = collaborationReviewerUpdateInputSchema.parse(input);
    return this.withActiveClient(async (client) => {
      const scope = await this.toAuthorityScope(client, command.workItem);
      return client.updateReviewer({
        schemaVersion: "review-assignment/v1",
        scope,
        principal: command.principal,
        expectedRevision: command.expectedRevision,
        ...(command.reason === undefined ? {} : { reason: command.reason })
      });
    });
  }

  listComments(input: unknown): Promise<CommentListPage> {
    const query = commentListWireQuerySchema.parse(input);
    return this.withActiveClient((client) => client.listComments(query));
  }

  listActivity(input: unknown = {}): Promise<ActivityListPage> {
    return this.withActiveClient((client) =>
      client.listActivity(activityListWireQuerySchema.parse(input ?? {}))
    );
  }

  updateAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    const command = assignmentUpdateWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.updateAssignment(command));
  }

  createComment(input: unknown): Promise<CommentDisplayProjection> {
    const command = commentCreateWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.createComment(command));
  }

  editComment(input: unknown): Promise<CommentDisplayProjection> {
    const command = commentEditWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.editComment(command));
  }

  tombstoneComment(input: unknown): Promise<CommentDisplayProjection> {
    const command = commentTombstoneWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.tombstoneComment(command));
  }

  createPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    const body = createPendingAttachmentRequestSchema.parse(input);
    return this.withActiveClient((client) => client.createPendingAttachment(body));
  }

  async uploadPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    const body = collaborationUploadPendingAttachmentInputSchema.parse(input);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.bodyBase64, "base64");
    } catch {
      throw new CollaborationClientError({
        kind: "validation",
        code: "collaboration_attachment_body_invalid",
        message: "Attachment body must be valid base64.",
        retryable: false
      });
    }
    if (bytes.byteLength === 0 || bytes.byteLength > 8_388_608) {
      throw new CollaborationClientError({
        kind: "validation",
        code: "collaboration_attachment_size_invalid",
        message: "Attachment body size is outside the allowed range.",
        retryable: false
      });
    }
    return this.withActiveClient((client) =>
      client.uploadPendingAttachment(body.pendingUploadId, {
        body: bytes,
        mediaType: body.mediaType,
        digestSha256: body.digestSha256
      })
    );
  }

  finalizePendingAttachment(input: unknown): Promise<FinalizePendingAttachmentResponse> {
    const body = collaborationFinalizePendingAttachmentInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.finalizePendingAttachment(body.pendingUploadId, {
        expectedDigestSha256: body.expectedDigestSha256
      })
    );
  }

  readPendingAttachment(input: unknown): Promise<CollaborationCommentAttachmentBody> {
    const body = collaborationReadPendingAttachmentInputSchema.parse(input);
    return this.withActiveClient(async (client) =>
      collaborationCommentAttachmentBodySchema.parse(
        await client.readPendingAttachment(body.pendingUploadId, body.digestSha256)
      )
    );
  }

  readCommentAttachment(input: unknown): Promise<CollaborationCommentAttachmentBody> {
    const body = collaborationReadCommentAttachmentInputSchema.parse(input);
    return this.withActiveClient(async (client) =>
      collaborationCommentAttachmentBodySchema.parse(
        await client.readCommentAttachment(body.commentId, body.digestSha256)
      )
    );
  }
}

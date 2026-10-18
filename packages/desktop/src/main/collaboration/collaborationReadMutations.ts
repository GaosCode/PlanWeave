import {
  collaborationOperationInputSchema,
  type CollaborationOperationScope
} from "../../shared/collaborationOperationScope.js";
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
    private readonly withOperationClient: <T>(
      scope: CollaborationOperationScope,
      operation: (client: CollaborationClient) => Promise<T>
    ) => Promise<T>,
    private readonly toAuthorityScope: (
      client: CollaborationClient,
      workItem: WorkItemRef
    ) => Promise<CollaborationWorkScope>
  ) {}

  listAssignments(input: unknown = {}): Promise<AssignmentListPage> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    return this.withOperationClient(operationScope, (client) =>
      client.listAssignments(assignmentListQuerySchema.parse(payload))
    );
  }

  getAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const { workItem } = workItemPayload(payload);
    return this.withOperationClient(operationScope, (client) => client.getAssignment(workItem));
  }

  listEligibleAssignees(input: unknown): Promise<EligibleAssigneesResponse> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const { workItem } = workItemPayload(payload);
    return this.withOperationClient(operationScope, (client) =>
      client.listEligibleAssignees(workItem)
    );
  }

  listEligibleHostsBatch(input: unknown): Promise<EligibleHostBatchResponse> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const request = eligibleHostBatchRequestSchema.parse(payload);
    return this.withOperationClient(operationScope, (client) =>
      client.listEligibleHostsBatch(request)
    );
  }

  getWorkAuthority(input: unknown): Promise<WorkAuthorityProjection> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const { workItem } = collaborationWorkAuthorityScopeInputSchema
      .omit({ operationScope: true })
      .parse(payload);
    return this.withOperationClient(operationScope, async (client) => {
      const scope = await this.toAuthorityScope(client, workItem);
      return client.getWorkAuthority(scope);
    });
  }

  updateResponsibility(input: unknown): Promise<ResponsibilityReadModel> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const command = collaborationResponsibilityUpdateInputSchema
      .omit({ operationScope: true })
      .parse(payload);
    return this.withOperationClient(operationScope, async (client) => {
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
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const command = collaborationReviewerUpdateInputSchema
      .omit({ operationScope: true })
      .parse(payload);
    return this.withOperationClient(operationScope, async (client) => {
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
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const query = commentListWireQuerySchema.parse(payload);
    return this.withOperationClient(operationScope, (client) => client.listComments(query));
  }

  listActivity(input: unknown = {}): Promise<ActivityListPage> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    return this.withOperationClient(operationScope, (client) =>
      client.listActivity(activityListWireQuerySchema.parse(payload))
    );
  }

  updateAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const command = assignmentUpdateWireCommandSchema.parse(payload);
    return this.withOperationClient(operationScope, (client) => client.updateAssignment(command));
  }

  createComment(input: unknown): Promise<CommentDisplayProjection> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const command = commentCreateWireCommandSchema.parse(payload);
    return this.withOperationClient(operationScope, (client) => client.createComment(command));
  }

  editComment(input: unknown): Promise<CommentDisplayProjection> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const command = commentEditWireCommandSchema.parse(payload);
    return this.withOperationClient(operationScope, (client) => client.editComment(command));
  }

  tombstoneComment(input: unknown): Promise<CommentDisplayProjection> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const command = commentTombstoneWireCommandSchema.parse(payload);
    return this.withOperationClient(operationScope, (client) => client.tombstoneComment(command));
  }

  createPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const body = createPendingAttachmentRequestSchema.parse(payload);
    return this.withOperationClient(operationScope, (client) =>
      client.createPendingAttachment(body)
    );
  }

  async uploadPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const body = collaborationUploadPendingAttachmentInputSchema
      .omit({ operationScope: true })
      .parse(payload);
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
    return this.withOperationClient(operationScope, (client) =>
      client.uploadPendingAttachment(body.pendingUploadId, {
        body: bytes,
        mediaType: body.mediaType,
        digestSha256: body.digestSha256
      })
    );
  }

  finalizePendingAttachment(input: unknown): Promise<FinalizePendingAttachmentResponse> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const body = collaborationFinalizePendingAttachmentInputSchema
      .omit({ operationScope: true })
      .parse(payload);
    return this.withOperationClient(operationScope, (client) =>
      client.finalizePendingAttachment(body.pendingUploadId, {
        expectedDigestSha256: body.expectedDigestSha256
      })
    );
  }

  readPendingAttachment(input: unknown): Promise<CollaborationCommentAttachmentBody> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const body = collaborationReadPendingAttachmentInputSchema
      .omit({ operationScope: true })
      .parse(payload);
    return this.withOperationClient(operationScope, async (client) =>
      collaborationCommentAttachmentBodySchema.parse(
        await client.readPendingAttachment(body.pendingUploadId, body.digestSha256)
      )
    );
  }

  readCommentAttachment(input: unknown): Promise<CollaborationCommentAttachmentBody> {
    const { operationScope, ...payload } = collaborationOperationInputSchema
      .passthrough()
      .parse(input);
    const body = collaborationReadCommentAttachmentInputSchema
      .omit({ operationScope: true })
      .parse(payload);
    return this.withOperationClient(operationScope, async (client) =>
      collaborationCommentAttachmentBodySchema.parse(
        await client.readCommentAttachment(body.commentId, body.digestSha256)
      )
    );
  }
}

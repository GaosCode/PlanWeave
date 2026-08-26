import { z } from "zod";
import {
  activityListWireQuerySchema,
  commentCreateWireCommandSchema,
  commentEditWireCommandSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema,
  type ActivityListPage,
  type ActivityRecord,
  type CommentDisplayProjection,
  type CommentListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";
import {
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type EligibleAssigneesResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import {
  collaborationRevisionSchema,
  workspaceMemberPrincipalSchema
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import {
  humanDeviceListQuerySchema,
  humanInvitationListQuerySchema,
  humanPageQuerySchema,
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanMemberPage,
  type HumanMembershipView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  humanObserverCatchupRequiredSchema,
  humanObserverEventSchema,
  type HumanObserverEvent
} from "@planweave-ai/collaboration-protocol/activity/observer";
import {
  opaqueIdentifierSchema,
  workItemRefSchema,
  type WorkItemRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  remoteEventQuerySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionResponseSchema,
  remoteOperationLookupQuerySchema,
  type RemoteActionView,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { type WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import { workspaceCanvasLocatorSchema } from "./canvasLocator.js";

/**
 * Renderer-facing collaboration sync lifecycle.
 * Distinct from CollaborationSessionPhase (main session/observer socket lifecycle).
 */
export type CollaborationSyncPhase =
  | "idle"
  | "loading"
  | "ready"
  | "disconnected"
  | "reconnecting"
  | "degraded"
  | "auth_expired"
  | "forbidden"
  | "stale_conflict"
  | "error";

export type CollaborationRemoteRunStatus =
  | "started"
  | "progress"
  | "succeeded"
  | "failed"
  | "interrupted";

/** Server-authoritative remote-run progress projection (not local Runtime Auto Run). */
export type CollaborationRemoteRunProjection = {
  dispatchId: string;
  projectId: string;
  workItem?: WorkItemRef;
  hostId?: string;
  status: CollaborationRemoteRunStatus;
  lastActivityId?: string;
  /** Human observer journal order; HTTP activity replay intentionally has no cursor. */
  observerCursor?: number;
  updatedAt: string;
};

export type CollaborationHostProjection = {
  hostId: string;
  projectId: string;
  displayName?: string;
  online: boolean;
  revoked: boolean;
  authorizedForProject: boolean;
  exists: boolean;
  capabilities: string[];
  capacityRemaining?: number;
};

export type CollaborationMutationKind =
  | "assignment"
  | "responsibility"
  | "reviewer"
  | "execution_target"
  | "comment_create"
  | "comment_edit"
  | "comment_tombstone";

/**
 * Mutation confirmation model — never treat unconfirmed/rejected results as success.
 */
export type CollaborationMutationStatus = "pending" | "confirmed" | "rejected" | "offline";

export type CollaborationMutationRecord = {
  mutationId: string;
  kind: CollaborationMutationKind;
  workItemKey?: string;
  status: CollaborationMutationStatus;
  expectedRevision?: number;
  confirmedRevision?: number;
  errorKind?: string;
  errorCode?: string;
  errorMessage?: string;
  submittedAt: string;
  resolvedAt?: string;
};

export type CollaborationBoundaryErrorView = {
  kind: string;
  code: string;
  message: string;
  httpStatus?: number;
  retryAfterMs?: number;
  retryable: boolean;
};

/** Push payload from main when the human observer advances or requires catch-up. */
export type CollaborationObserverSignal =
  | {
      type: "human.observer.event";
      profileId: string;
      projectId: string;
      event: HumanObserverEvent;
    }
  | {
      type: "human.observer.catchup_required";
      profileId: string;
      projectId: string;
      reason: "retention_gap" | "cursor_ahead" | "reset";
      resumeCursor: number;
      droppedThroughCursor?: number;
    }
  | {
      type: "human.observer.cursor";
      profileId: string;
      projectId: string;
      cursor: number;
    };

export const collaborationPageQueryInputSchema = humanPageQuerySchema;
export type CollaborationPageQueryInput = z.input<typeof collaborationPageQueryInputSchema>;

export const collaborationDeviceListQueryInputSchema = humanDeviceListQuerySchema;
export type CollaborationDeviceListQueryInput = z.input<
  typeof collaborationDeviceListQueryInputSchema
>;

export const collaborationInvitationListQueryInputSchema = humanInvitationListQuerySchema;
export type CollaborationInvitationListQueryInput = z.input<
  typeof collaborationInvitationListQueryInputSchema
>;

export const collaborationAssignmentListQueryInputSchema = assignmentListQuerySchema;
export type CollaborationAssignmentListQueryInput = z.input<
  typeof collaborationAssignmentListQueryInputSchema
>;

export const collaborationWorkItemInputSchema = z
  .object({
    workItem: workItemRefSchema
  })
  .strict();
export type CollaborationWorkItemInput = z.infer<typeof collaborationWorkItemInputSchema>;

export const collaborationCommentListQueryInputSchema = commentListWireQuerySchema;
export type CollaborationCommentListQueryInput = z.input<
  typeof collaborationCommentListQueryInputSchema
>;

export const collaborationActivityListQueryInputSchema = activityListWireQuerySchema;
export type CollaborationActivityListQueryInput = z.input<
  typeof collaborationActivityListQueryInputSchema
>;

export const collaborationAssignmentUpdateInputSchema = assignmentUpdateWireCommandSchema;
export type CollaborationAssignmentUpdateInput = z.input<
  typeof collaborationAssignmentUpdateInputSchema
>;

/**
 * Renderer work-item identity for authority reads/mutations.
 * Main injects workspaceId + projectId into Server scopes; renderer never supplies remote roots.
 */
export const collaborationWorkAuthorityScopeInputSchema = z
  .object({
    workItem: workItemRefSchema
  })
  .strict();
export type CollaborationWorkAuthorityScopeInput = z.infer<
  typeof collaborationWorkAuthorityScopeInputSchema
>;

const collaborationReasonInputSchema = z.string().trim().min(1).max(512).optional();

export const collaborationResponsibilityUpdateInputSchema = z
  .object({
    workItem: workItemRefSchema,
    principal: workspaceMemberPrincipalSchema.nullable(),
    expectedRevision: collaborationRevisionSchema,
    reason: collaborationReasonInputSchema
  })
  .strict();
export type CollaborationResponsibilityUpdateInput = z.infer<
  typeof collaborationResponsibilityUpdateInputSchema
>;

export const collaborationReviewerUpdateInputSchema = z
  .object({
    workItem: workItemRefSchema,
    principal: workspaceMemberPrincipalSchema.nullable(),
    expectedRevision: collaborationRevisionSchema,
    reason: collaborationReasonInputSchema
  })
  .strict();
export type CollaborationReviewerUpdateInput = z.infer<
  typeof collaborationReviewerUpdateInputSchema
>;

export const collaborationCommentCreateInputSchema = commentCreateWireCommandSchema;
export type CollaborationCommentCreateInput = z.input<typeof collaborationCommentCreateInputSchema>;

export const collaborationCommentEditInputSchema = commentEditWireCommandSchema;
export type CollaborationCommentEditInput = z.input<typeof collaborationCommentEditInputSchema>;

export const collaborationCommentTombstoneInputSchema = commentTombstoneWireCommandSchema;
export type CollaborationCommentTombstoneInput = z.input<
  typeof collaborationCommentTombstoneInputSchema
>;

export const collaborationRemoteOperationIdInputSchema = z
  .object({
    operationId: opaqueIdentifierSchema
  })
  .strict();
export type CollaborationRemoteOperationIdInput = z.infer<
  typeof collaborationRemoteOperationIdInputSchema
>;

export const collaborationRemoteOperationLookupInputSchema =
  remoteOperationLookupQuerySchema.refine(
    (value) => value.canvasId !== undefined && value.blockRef !== undefined,
    { message: "Remote operation block lookup requires canvasId and blockRef." }
  );
export type CollaborationRemoteOperationLookupInput = z.infer<
  typeof collaborationRemoteOperationLookupInputSchema
>;

const collaborationWorkspaceRemoteOperationScopeSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    blockRef: remoteOperationLookupQuerySchema.shape.blockRef.unwrap()
  })
  .strict();

export const collaborationWorkspaceRemoteOperationLookupInputSchema =
  collaborationWorkspaceRemoteOperationScopeSchema
    .extend({ operationId: opaqueIdentifierSchema.optional() })
    .strict();
export type CollaborationWorkspaceRemoteOperationLookupInput = z.infer<
  typeof collaborationWorkspaceRemoteOperationLookupInputSchema
>;

export const collaborationWorkspaceRemoteOperationIdInputSchema =
  collaborationWorkspaceRemoteOperationScopeSchema
    .extend({ operationId: opaqueIdentifierSchema })
    .strict();
export type CollaborationWorkspaceRemoteOperationIdInput = z.infer<
  typeof collaborationWorkspaceRemoteOperationIdInputSchema
>;

export const collaborationWorkspaceRemoteEventReplayInputSchema =
  collaborationWorkspaceRemoteOperationIdInputSchema
    .extend({ query: remoteEventQuerySchema.optional() })
    .strict();
export type CollaborationWorkspaceRemoteEventReplayInput = z.infer<
  typeof collaborationWorkspaceRemoteEventReplayInputSchema
>;

export const collaborationRemoteEventQueryInputSchema = remoteEventQuerySchema;
export type CollaborationRemoteEventQueryInput = z.input<
  typeof collaborationRemoteEventQueryInputSchema
>;

export const collaborationRemoteInteractionPageQueryInputSchema = remoteInteractionPageQuerySchema;
export type CollaborationRemoteInteractionPageQueryInput = z.input<
  typeof collaborationRemoteInteractionPageQueryInputSchema
>;

export const collaborationRemoteActionInputSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    action: remoteHumanExecutionActionCommandSchema
  })
  .strict();
export type CollaborationRemoteActionInput = z.infer<typeof collaborationRemoteActionInputSchema>;

export const collaborationRemoteInteractionRespondInputSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    settlement: remoteInteractionResponseSchema
  })
  .strict();
export type CollaborationRemoteInteractionRespondInput = z.infer<
  typeof collaborationRemoteInteractionRespondInputSchema
>;

export type {
  RemoteActionView,
  RemoteEventReplay,
  RemoteHumanExecutionActionCommand,
  RemoteInteractionPage,
  RemoteInteractionResponse,
  RemoteInteractionView,
  RemoteOperationObservation
};

const encodedWorkItemKeySchema = z.union([
  z.tuple([z.literal("task"), z.string(), z.string()]),
  z.tuple([z.literal("block"), z.string(), z.string()])
]);

/** Lossless renderer identity key for Task/Block work items. */
export function workItemKey(workItem: WorkItemRef): string {
  if (workItem.kind === "task") {
    return JSON.stringify([workItem.kind, workItem.canvasId, workItem.taskId]);
  }
  return JSON.stringify([workItem.kind, workItem.canvasId, workItem.blockRef]);
}

export function parseWorkItemKey(key: string): WorkItemRef | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(key);
  } catch {
    return null;
  }
  const encoded = encodedWorkItemKeySchema.safeParse(decoded);
  if (!encoded.success) return null;
  const [kind, canvasId, ref] = encoded.data;
  const parsed = workItemRefSchema.safeParse(
    kind === "task" ? { kind, canvasId, taskId: ref } : { kind, canvasId, blockRef: ref }
  );
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export type CollaborationReadModelSnapshot = {
  profileId: string | null;
  projectId: string | null;
  canvasId: string | null;
  syncPhase: CollaborationSyncPhase;
  observerCursor: number;
  members: HumanMembershipView[];
  hosts: CollaborationHostProjection[];
  assignmentsByWorkItem: Record<string, AssignmentDisplayProjection>;
  /** Independent OSS-003 authority projections keyed by workItemKey. */
  workAuthorityByWorkItem: Record<string, WorkAuthorityProjection>;
  commentsByWorkItem: Record<string, CommentDisplayProjection[]>;
  activity: ActivityRecord[];
  remoteRunsByDispatchId: Record<string, CollaborationRemoteRunProjection>;
  mutationsById: Record<string, CollaborationMutationRecord>;
  lastError: CollaborationBoundaryErrorView | null;
  loadingKinds: string[];
  updatedAt: string;
};

export type {
  ActivityListPage,
  ActivityRecord,
  AssignmentDisplayProjection,
  AssignmentListPage,
  CommentDisplayProjection,
  CommentListPage,
  EligibleAssigneesResponse,
  HumanDevicePage,
  HumanInvitationPage,
  HumanMemberPage,
  HumanMembershipView,
  HumanObserverEvent,
  WorkItemRef
};

// Re-export observer event schema for main-side validation of fan-out payloads.
export { humanObserverEventSchema, humanObserverCatchupRequiredSchema };

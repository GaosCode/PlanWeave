import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type { CommentDisplayProjection } from "@planweave-ai/collaboration-protocol/activity/comments";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workItemKey,
  type CollaborationHostProjection,
  type CollaborationMutationRecord,
  type CollaborationReadModelSnapshot,
  type CollaborationRemoteRunProjection,
  type CollaborationSyncPhase,
  type CollaborationMemberSummary
} from "../../shared/collaborationReadModels.js";

/**
 * Local Runtime graph/run facts the UI may already know.
 * Kept separate from server projections; merged only via these pure functions.
 */
export type LocalRuntimeWorkItemFacts = {
  workItem: WorkItemRef;
  /** Local graph title/label when present. */
  localTitle?: string | null;
  /** Local runtime status (claim/run) — never treated as server assignment. */
  localRuntimeStatus?: string | null;
  /** Whether the work item exists in the compiled local graph. */
  presentInLocalGraph: boolean;
};

export type CollaborationWorkItemViewModel = {
  key: string;
  workItem: WorkItemRef;
  /** Server assignment projection or null when not yet loaded / unassigned on server. */
  assignment: AssignmentDisplayProjection | null;
  comments: CommentDisplayProjection[];
  remoteRuns: CollaborationRemoteRunProjection[];
  local: LocalRuntimeWorkItemFacts | null;
  /** Pending mutations that have not been confirmed by the server. */
  pendingMutations: CollaborationMutationRecord[];
  /**
   * True only when a mutation has server confirmation.
   * Rejected/offline/pending never surface as success.
   */
  hasConfirmedMutation: boolean;
};

export type CollaborationProjectViewModel = {
  profileId: string | null;
  projectId: string | null;
  canvasId: string | null;
  syncPhase: CollaborationSyncPhase;
  observerCursor: number;
  members: CollaborationMemberSummary[];
  hosts: CollaborationHostProjection[];
  workItems: CollaborationWorkItemViewModel[];
  activity: CollaborationReadModelSnapshot["activity"];
  remoteRuns: CollaborationRemoteRunProjection[];
  lastError: CollaborationReadModelSnapshot["lastError"];
  loadingKinds: string[];
  isAuthoritative: boolean;
};

function isConfirmed(record: CollaborationMutationRecord): boolean {
  return record.status === "confirmed";
}

function isPending(record: CollaborationMutationRecord): boolean {
  return record.status === "pending";
}

export function buildWorkItemViewModel(input: {
  workItem: WorkItemRef;
  snapshot: CollaborationReadModelSnapshot;
  local?: LocalRuntimeWorkItemFacts | null;
}): CollaborationWorkItemViewModel {
  const key = workItemKey(input.workItem);
  const assignment = input.snapshot.assignmentsByWorkItem[key] ?? null;
  const comments = input.snapshot.commentsByWorkItem[key] ?? [];
  const remoteRuns = Object.values(input.snapshot.remoteRunsByDispatchId).filter((run) => {
    if (!run.workItem) return false;
    return workItemKey(run.workItem) === key;
  });
  const mutations = Object.values(input.snapshot.mutationsById).filter(
    (mutation) => mutation.workItemKey === key
  );
  return {
    key,
    workItem: input.workItem,
    assignment,
    comments,
    remoteRuns,
    local: input.local ?? null,
    pendingMutations: mutations.filter(isPending),
    hasConfirmedMutation: mutations.some(isConfirmed)
  };
}

/**
 * Combine authoritative server projections with optional local Runtime facts.
 * Local runtime never overrides server assignment/comment/activity truth.
 */
export function buildCollaborationProjectViewModel(input: {
  snapshot: CollaborationReadModelSnapshot;
  localWorkItems?: readonly LocalRuntimeWorkItemFacts[];
}): CollaborationProjectViewModel {
  const { snapshot } = input;
  const localByKey = new Map(
    (input.localWorkItems ?? []).map((item) => [workItemKey(item.workItem), item])
  );

  const workItemKeys = new Set<string>([
    ...Object.keys(snapshot.assignmentsByWorkItem),
    ...Object.keys(snapshot.commentsByWorkItem),
    ...localByKey.keys()
  ]);

  const workItems: CollaborationWorkItemViewModel[] = [];
  for (const key of workItemKeys) {
    const assignment = snapshot.assignmentsByWorkItem[key];
    const local = localByKey.get(key) ?? null;
    const workItem =
      assignment?.workItem ??
      local?.workItem ??
      (snapshot.commentsByWorkItem[key]?.[0]?.workItem as WorkItemRef | undefined);
    if (!workItem) continue;
    workItems.push(
      buildWorkItemViewModel({
        workItem,
        snapshot,
        local
      })
    );
  }

  workItems.sort((left, right) => left.key.localeCompare(right.key));

  const remoteRuns = Object.values(snapshot.remoteRunsByDispatchId).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );

  return {
    profileId: snapshot.profileId,
    projectId: snapshot.projectId,
    canvasId: snapshot.canvasId,
    syncPhase: snapshot.syncPhase,
    observerCursor: snapshot.observerCursor,
    members: snapshot.members,
    hosts: snapshot.hosts,
    workItems,
    activity: snapshot.activity,
    remoteRuns,
    lastError: snapshot.lastError,
    loadingKinds: snapshot.loadingKinds,
    isAuthoritative:
      snapshot.syncPhase === "ready" ||
      snapshot.syncPhase === "degraded" ||
      snapshot.syncPhase === "stale_conflict"
  };
}

/** Whether UI may present a mutation outcome as success. */
export function mutationAppearsSuccessful(
  record: CollaborationMutationRecord | undefined
): boolean {
  return record?.status === "confirmed";
}

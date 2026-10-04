import { collaborationNotificationIdentity } from "../notificationIdentity";
import type { ActivityRecord } from "@planweave-ai/collaboration-protocol/activity/comments";
import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workItemKey,
  type CollaborationMutationRecord,
  type CollaborationReadModelSnapshot,
  type CollaborationSyncPhase
} from "../../shared/collaborationReadModels.js";
import {
  buildAssigneeCurrentDisplay,
  DEFAULT_ASSIGNEE_DISPLAY_LABELS,
  type AssigneeCurrentDisplay,
  type AssigneeDisplayLabels,
  type AssigneeUnavailableReason
} from "./assignmentViewModels.js";

/**
 * Compact assignee chip for dense surfaces (graph cards, Todo, Search, workspace header).
 * Built only from the shared read-model snapshot — no per-surface fetch/cache.
 */
export type CompactAssigneeChip = {
  workItemKey: string;
  label: string;
  initials: string | null;
  targetKind: AssigneeCurrentDisplay["targetKind"];
  revision: number;
  issueReason: AssigneeUnavailableReason | null;
  /** Render on dense lists/cards only when assignment is informative. */
  visible: boolean;
  tone: "assigned" | "issue" | "unassigned";
};

export type AssigneeSurfaceIndex = {
  byWorkItemKey: Record<string, CompactAssigneeChip>;
  syncPhase: CollaborationSyncPhase;
  /** True when compact chips may render (connected or degraded last-known). */
  surfaceActive: boolean;
};

const SURFACE_ACTIVE_PHASES: ReadonlySet<CollaborationSyncPhase> = new Set([
  "ready",
  "degraded",
  "stale_conflict",
  "reconnecting",
  "loading"
]);

export function isAssigneeSurfaceActive(syncPhase: CollaborationSyncPhase): boolean {
  return SURFACE_ACTIVE_PHASES.has(syncPhase);
}

export function buildCompactAssigneeChip(
  assignment: AssignmentDisplayProjection | null | undefined,
  workItem: WorkItemRef,
  labels: AssigneeDisplayLabels = DEFAULT_ASSIGNEE_DISPLAY_LABELS
): CompactAssigneeChip {
  const current = buildAssigneeCurrentDisplay(assignment, labels);
  const key = workItemKey(workItem);
  const isUnassigned = current.targetKind === "unassigned";
  const hasIssue = current.issueReason != null;
  const visible = !isUnassigned || hasIssue;
  return {
    workItemKey: key,
    label: current.label,
    initials: current.initials,
    targetKind: current.targetKind,
    revision: current.revision,
    issueReason: current.issueReason,
    visible,
    tone: hasIssue ? "issue" : isUnassigned ? "unassigned" : "assigned"
  };
}

/**
 * Project-level assignee lookup keyed by stable workItemKey.
 * Consumers resolve task/block keys; they never open subscriptions.
 */
export function buildAssigneeSurfaceIndex(
  snapshot: CollaborationReadModelSnapshot,
  labels: AssigneeDisplayLabels = DEFAULT_ASSIGNEE_DISPLAY_LABELS
): AssigneeSurfaceIndex {
  const byWorkItemKey: Record<string, CompactAssigneeChip> = {};
  for (const [key, assignment] of Object.entries(snapshot.assignmentsByWorkItem)) {
    byWorkItemKey[key] = buildCompactAssigneeChip(assignment, assignment.workItem, labels);
  }
  return {
    byWorkItemKey,
    syncPhase: snapshot.syncPhase,
    surfaceActive: isAssigneeSurfaceActive(snapshot.syncPhase)
  };
}

export function taskWorkItemKey(canvasId: string, taskId: string): string {
  return workItemKey({ kind: "task", canvasId, taskId });
}

export function blockWorkItemKey(canvasId: string, blockRef: string): string {
  return workItemKey({ kind: "block", canvasId, blockRef });
}

export function lookupTaskAssigneeChip(
  index: AssigneeSurfaceIndex,
  canvasId: string,
  taskId: string
): CompactAssigneeChip | null {
  if (!index.surfaceActive) return null;
  const chip = index.byWorkItemKey[taskWorkItemKey(canvasId, taskId)];
  return chip?.visible ? chip : null;
}

export function lookupBlockAssigneeChip(
  index: AssigneeSurfaceIndex,
  canvasId: string,
  blockRef: string
): CompactAssigneeChip | null {
  if (!index.surfaceActive) return null;
  const chip = index.byWorkItemKey[blockWorkItemKey(canvasId, blockRef)];
  return chip?.visible ? chip : null;
}

/** Prefer task assignment; fall back to first visible block assignee for dense task cards. */
export function lookupTaskCardAssigneeChip(
  index: AssigneeSurfaceIndex,
  canvasId: string,
  taskId: string,
  blockRefs: readonly string[]
): CompactAssigneeChip | null {
  const taskChip = lookupTaskAssigneeChip(index, canvasId, taskId);
  if (taskChip) return taskChip;
  for (const blockRef of blockRefs) {
    const blockChip = lookupBlockAssigneeChip(index, canvasId, blockRef);
    if (blockChip) return blockChip;
  }
  return null;
}

export type CollaborationNotificationDraft = {
  id: string;
  title: string;
  detail: string;
  tone: "outline" | "secondary" | "destructive";
  kind: "collaboration";
};

const MEMBERSHIP_ACTIVITY = new Set([
  "member_joined",
  "member_left",
  "member_removed",
  "owner_promoted",
  "owner_demoted"
]);

/**
 * Derive notification drafts from authoritative activity + local mutation outcomes.
 * Does not invent success from pending/offline mutations.
 */
export function buildCollaborationNotificationDrafts(input: {
  scope: Pick<CollaborationReadModelSnapshot, "profileId" | "projectId" | "canvasId">;
  activity: readonly ActivityRecord[];
  mutations: readonly CollaborationMutationRecord[];
  labels: {
    assignmentUpdated: string;
    assignmentFailed: string;
    membershipChanged: string;
    mutationConfirmed: string;
    mutationRejected: string;
  };
  /** Cap activity-derived items to keep the notifications rail responsive. */
  activityLimit?: number;
}): CollaborationNotificationDraft[] {
  const drafts: CollaborationNotificationDraft[] = [];
  const { profileId, projectId, canvasId } = input.scope;
  if (!profileId || !projectId) return drafts;
  const activityLimit = input.activityLimit ?? 12;

  const relevantActivity = input.activity
    .filter((item) => item.type === "assignment_updated" || MEMBERSHIP_ACTIVITY.has(item.type))
    .slice(0, activityLimit);

  for (const item of relevantActivity) {
    const isAssignment = item.type === "assignment_updated";
    drafts.push({
      id: collaborationNotificationIdentity(
        "collab-activity",
        {
          profileId,
          projectId: item.projectId,
          canvasId: item.workItem?.canvasId ?? item.summary.workItem?.canvasId ?? null
        },
        item.activityId
      ),
      title: isAssignment ? input.labels.assignmentUpdated : input.labels.membershipChanged,
      detail: item.summary.headline,
      tone: isAssignment ? "outline" : "secondary",
      kind: "collaboration"
    });
  }

  for (const mutation of input.mutations) {
    if (mutation.kind !== "assignment") continue;
    if (mutation.status === "confirmed") {
      drafts.push({
        id: collaborationNotificationIdentity(
          "collab-mutation",
          { profileId, projectId, canvasId },
          mutation.mutationId
        ),
        title: input.labels.mutationConfirmed,
        detail: mutation.workItemKey
          ? `${input.labels.assignmentUpdated} · ${mutation.workItemKey}`
          : input.labels.assignmentUpdated,
        tone: "outline",
        kind: "collaboration"
      });
    } else if (mutation.status === "rejected") {
      drafts.push({
        id: collaborationNotificationIdentity(
          "collab-mutation",
          { profileId, projectId, canvasId },
          mutation.mutationId
        ),
        title: input.labels.mutationRejected,
        detail: mutation.errorMessage ?? mutation.errorCode ?? input.labels.assignmentFailed,
        tone: "destructive",
        kind: "collaboration"
      });
    }
  }

  return drafts;
}

import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type { CommentDisplayProjection } from "@planweave-ai/collaboration-protocol/activity/comments";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationStatus } from "../../shared/collaboration.js";
import type {
  CollaborationMemberSummary,
  CollaborationHostProjection,
  CollaborationReadModelSnapshot,
  CollaborationRemoteRunProjection,
  CollaborationSyncPhase,
  CollaborationBoundaryErrorView
} from "../../shared/collaborationReadModels.js";
import {
  CollaborationEventCursorWindow,
  CollaborationMutationLedger
} from "./collaborationRetention.js";
import { isCollaborationSessionConnected } from "./sessionState";

export type InternalState = {
  profileId: string | null;
  projectId: string | null;
  canvasId: string | null;
  syncPhase: CollaborationSyncPhase;
  observerCursor: number;
  members: CollaborationMemberSummary[];
  hosts: Map<string, CollaborationHostProjection>;
  assignments: Map<string, AssignmentDisplayProjection>;
  workAuthorities: Map<string, WorkAuthorityProjection>;
  comments: Map<string, CommentDisplayProjection[]>;
  commentInvalidationVersions: Map<string, number>;
  activity: CollaborationReadModelSnapshot["activity"];
  remoteRuns: Map<string, CollaborationRemoteRunProjection>;
  mutations: CollaborationMutationLedger;
  lastError: CollaborationBoundaryErrorView | null;
  loadingKinds: Map<string, number>;
  trackedCommentWorkItems: Map<string, WorkItemRef>;
  trackedAuthorityWorkItems: Map<string, WorkItemRef>;
  eventCursors: CollaborationEventCursorWindow;
  generation: number;
  updatedAt: string;
};

export function emptyState(now: string): InternalState {
  return {
    profileId: null,
    projectId: null,
    canvasId: null,
    syncPhase: "idle",
    observerCursor: 0,
    members: [],
    hosts: new Map(),
    assignments: new Map(),
    workAuthorities: new Map(),
    comments: new Map(),
    commentInvalidationVersions: new Map(),
    activity: [],
    remoteRuns: new Map(),
    mutations: new CollaborationMutationLedger(),
    lastError: null,
    loadingKinds: new Map(),
    trackedCommentWorkItems: new Map(),
    trackedAuthorityWorkItems: new Map(),
    eventCursors: new CollaborationEventCursorWindow(),
    generation: 0,
    updatedAt: now
  };
}

export function mapSessionPhaseToSync(
  status: CollaborationStatus,
  current: CollaborationSyncPhase
): CollaborationSyncPhase {
  const phase = status.session.phase;
  const detail = status.session.detail ?? "";
  if (phase === "idle" || phase === "ready") return "disconnected";
  if (phase === "connecting") {
    if (detail.includes("reconnecting")) return "reconnecting";
    return current === "ready" || current === "degraded" ? "reconnecting" : "loading";
  }
  if (phase === "error") {
    if (
      status.session.lastErrorCode === "human_device_expired" ||
      detail.includes("auth_expired")
    ) {
      return "auth_expired";
    }
    if (
      status.session.lastErrorCode?.includes("forbidden") ||
      status.session.lastErrorCode === "http_403"
    ) {
      return "forbidden";
    }
    return "error";
  }
  if (isCollaborationSessionConnected(status)) {
    if (status.session.lastErrorCode?.startsWith("collaboration_observer_")) {
      return "degraded";
    }
    if (current === "loading") return "loading";
    if (current === "stale_conflict") return "stale_conflict";
    if (current === "degraded") return "degraded";
    return current === "idle" || current === "disconnected" || current === "error"
      ? "loading"
      : current === "reconnecting"
        ? "ready"
        : current;
  }
  return current;
}

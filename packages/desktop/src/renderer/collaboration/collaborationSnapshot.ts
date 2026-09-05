import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type { CommentDisplayProjection } from "@planweave-ai/collaboration-protocol/activity/comments";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import type {
  CollaborationBoundaryErrorView,
  CollaborationHostProjection,
  CollaborationReadModelSnapshot,
  CollaborationRemoteRunProjection,
  CollaborationSyncPhase,
  CollaborationMemberSummary
} from "../../shared/collaborationReadModels.js";
import type { CollaborationMutationLedger } from "./collaborationRetention.js";

type SnapshotSource = {
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
  activity: CollaborationReadModelSnapshot["activity"];
  remoteRuns: Map<string, CollaborationRemoteRunProjection>;
  mutations: CollaborationMutationLedger;
  lastError: CollaborationBoundaryErrorView | null;
  loadingKinds: Map<string, number>;
  updatedAt: string;
};

export function buildCollaborationSnapshot(source: SnapshotSource): CollaborationReadModelSnapshot {
  return {
    profileId: source.profileId,
    projectId: source.projectId,
    canvasId: source.canvasId,
    syncPhase: source.syncPhase,
    observerCursor: source.observerCursor,
    members: source.members,
    hosts: [...source.hosts.values()],
    assignmentsByWorkItem: Object.fromEntries(source.assignments),
    workAuthorityByWorkItem: Object.fromEntries(source.workAuthorities),
    commentsByWorkItem: Object.fromEntries(source.comments),
    activity: source.activity,
    remoteRunsByDispatchId: Object.fromEntries(source.remoteRuns),
    mutationsById: Object.fromEntries(source.mutations.records),
    lastError: source.lastError,
    loadingKinds: [...source.loadingKinds.keys()],
    updatedAt: source.updatedAt
  };
}

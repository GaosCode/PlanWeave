import type { CollaborationStatus } from "../../shared/collaboration";
import type { CollaborationOperationScope } from "../../shared/collaborationOperationScope";
import { isCollaborationSessionConnected } from "./sessionState";
import type { AppView } from "../types";

export function collaborationSurfaceCanvasIdForView(
  activeView: AppView,
  selectedCanvasId: string | null
): string | null {
  return activeView === "people" ? null : selectedCanvasId;
}

export function resolveCollaborationSurfaceReadBinding(input: {
  sessionConnected: boolean;
  profileId: string | null;
  profileProjectId: string | null;
  localProjectId: string | null;
  canvasId: string | null;
}): { profileId: string | null; projectId: string | null; canvasId: string | null } {
  if (!input.sessionConnected || !input.profileId || !input.profileProjectId) {
    return { profileId: null, projectId: null, canvasId: null };
  }
  if (!input.localProjectId || input.localProjectId !== input.profileProjectId) {
    return { profileId: null, projectId: null, canvasId: null };
  }
  return {
    profileId: input.profileId,
    projectId: input.profileProjectId,
    canvasId: input.canvasId
  };
}

/** Local work items may use only the verified session for their loaded package project. */
export function resolveLocalCollaborationOperationScope(
  status: CollaborationStatus | null,
  localProjectId: string | null
): CollaborationOperationScope | null {
  const profile = status?.profiles.find((item) => item.profileId === status.activeProfileId);
  const binding = resolveCollaborationSurfaceReadBinding({
    sessionConnected: isCollaborationSessionConnected(status),
    profileId: profile?.profileId ?? null,
    profileProjectId: profile?.projectId ?? null,
    localProjectId,
    canvasId: null
  });
  const scope = status?.session.operationScope;
  return scope && binding.profileId === scope.profileId && binding.projectId === scope.projectId
    ? scope
    : null;
}

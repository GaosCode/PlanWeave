import type { CollaborationSessionPhase } from "../../shared/collaboration.js";

type CollaborationSessionStatus = {
  session: { phase: CollaborationSessionPhase };
  workspaceConnection?: { status: string };
};

/** Live collaboration APIs are available only after the client session is connected. */
export function isCollaborationSessionConnected(
  status: CollaborationSessionStatus | null | undefined
): boolean {
  return status?.session.phase === "connected";
}

/** Workspace identity APIs are available after the Server Workspace connection is live. */
export function isWorkspaceConnectionConnected(
  status: CollaborationSessionStatus | null | undefined
): boolean {
  return status?.workspaceConnection?.status === "connected";
}

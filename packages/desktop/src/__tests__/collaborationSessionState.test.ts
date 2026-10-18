import { describe, expect, it } from "vitest";
import {
  isCollaborationSessionConnected,
  isWorkspaceConnectionConnected
} from "../renderer/collaboration/sessionState";
import type { CollaborationStatus } from "../shared/collaboration";

function status(phase: CollaborationStatus["session"]["phase"]): {
  session: Pick<CollaborationStatus["session"], "phase" | "lastErrorCode">;
  workspaceConnection: Pick<CollaborationStatus["workspaceConnection"], "status">;
} {
  return {
    session: { phase, lastErrorCode: null },
    workspaceConnection: { status: "local_only" }
  };
}

describe("isCollaborationSessionConnected", () => {
  it("allows live APIs only for a connected client session", () => {
    expect(isCollaborationSessionConnected(status("connected"))).toBe(true);
    expect(isCollaborationSessionConnected(status("ready"))).toBe(false);
    expect(isCollaborationSessionConnected(status("connecting"))).toBe(false);
    expect(isCollaborationSessionConnected(status("idle"))).toBe(false);
    expect(isCollaborationSessionConnected(null)).toBe(false);
  });

  it("allows Workspace identity APIs after the Server connection is live", () => {
    const connected = status("error");
    connected.session.lastErrorCode = "live_registry_project_unavailable";
    connected.workspaceConnection = { status: "connected" };
    expect(isWorkspaceConnectionConnected(connected)).toBe(true);
    expect(isWorkspaceConnectionConnected(status("connected"))).toBe(false);
    expect(isWorkspaceConnectionConnected(null)).toBe(false);
  });
});

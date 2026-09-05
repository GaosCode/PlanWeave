import { describe, expect, it } from "vitest";
import {
  isCollaborationSessionConnected,
  isWorkspaceConnectionConnected
} from "../renderer/collaboration/sessionState";
import type { CollaborationStatus } from "../shared/collaboration";

function status(phase: CollaborationStatus["session"]["phase"]): CollaborationStatus {
  return {
    profiles: [],
    activeProfileId: null,
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase,
      activeProfileId: null,
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: {
      schemaVersion: "workspace-setup/v1",
      items: [],
      nextCursor: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z"
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
    connected.workspaceConnection = {
      ...connected.workspaceConnection,
      status: "connected",
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-1",
        displayName: "Team",
        serverBaseUrl: "http://127.0.0.1:56584/",
        workspaceId: "workspace-1",
        allowInsecureTransport: true
      },
      workspaceId: "workspace-1",
      workspaceDisplayName: "Team",
      connectedAt: "2030-01-01T00:00:00.000Z",
      error: null
    };
    expect(isWorkspaceConnectionConnected(connected)).toBe(true);
    expect(isWorkspaceConnectionConnected(status("connected"))).toBe(false);
    expect(isWorkspaceConnectionConnected(null)).toBe(false);
  });
});

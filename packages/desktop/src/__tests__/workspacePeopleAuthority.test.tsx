/* @vitest-environment jsdom */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import { toCollaborationReadBridge } from "../renderer/collaboration/collaborationReadBridge";
import { usePeoplePanelController } from "../renderer/hooks/usePeoplePanelController";

afterEach(cleanup);

it("loads Workspace identity and members without requesting project identity endpoints", async () => {
  const status: CollaborationStatus = {
    profiles: [],
    activeProfileId: "profile-one",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
    session: {
      phase: "connected",
      activeProfileId: "profile-one",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "connected",
      profile: null,
      workspaceId: "workspace-one",
      workspaceDisplayName: "Team",
      connectedAt: "2030-01-01T00:00:00.000Z",
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
  const self = {
    schemaVersion: "workspace-setup/v1",
    workspaceId: "workspace-one",
    membershipId: "member-one",
    humanPrincipalId: "human-one",
    displayName: "Win",
    role: "member",
    deviceSessionId: "device-one"
  };
  const members = [
    {
      schemaVersion: "workspace-setup/v1",
      membershipId: self.membershipId,
      humanPrincipalId: self.humanPrincipalId,
      displayName: self.displayName,
      role: self.role,
      devices: []
    }
  ];
  const legacyMembers = vi.fn().mockRejectedValue(new Error("human_auth_unauthenticated"));
  const legacyDevices = vi.fn().mockRejectedValue(new Error("human_auth_unauthenticated"));
  const legacyInvitations = vi.fn().mockRejectedValue(new Error("human_auth_unauthenticated"));
  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(status),
    getWorkspaceConnectionSelf: vi.fn().mockResolvedValue(self),
    listWorkspaceConnectionMembers: vi.fn().mockResolvedValue({ items: members, nextCursor: null }),
    listCollaborationMembers: legacyMembers,
    listCollaborationDevices: legacyDevices,
    listCollaborationInvitations: legacyInvitations
  } as PlanWeaveCollaborationApi;
  const { result } = renderHook(() =>
    usePeoplePanelController({
      api,
      status,
      members: [],
      hosts: [],
      syncPhase: "ready",
      detailsOpen: true
    })
  );
  await waitFor(() => expect(result.current.members).toHaveLength(1));
  await waitFor(() => expect(result.current.detailsLoading).toBe(false));
  expect(result.current.detailsError).toBeNull();
  expect(result.current.identity?.displayName).toBe("Win");
  const readBridge = toCollaborationReadBridge(api)!;
  await expect(readBridge.listCollaborationMembers({ cursor: 0, limit: 100 })).resolves.toEqual({
    items: members,
    nextCursor: null
  });
  expect(legacyMembers).not.toHaveBeenCalled();
  expect(legacyDevices).not.toHaveBeenCalled();
  expect(legacyInvitations).not.toHaveBeenCalled();
  vi.mocked(api.listWorkspaceConnectionMembers).mockRejectedValueOnce(
    new Error("workspace_members_unavailable")
  );
  await expect(readBridge.listCollaborationMembers({ cursor: 0, limit: 100 })).rejects.toThrow(
    "workspace_members_unavailable"
  );
  expect(legacyMembers).not.toHaveBeenCalled();
  vi.mocked(api.getCollaborationStatus).mockResolvedValue({
    ...status,
    workspaceConnection: { ...status.workspaceConnection, status: "local_only" }
  });
  await expect(readBridge.listCollaborationMembers({ cursor: 0, limit: 100 })).rejects.toThrow(
    "human_auth_unauthenticated"
  );
  expect(legacyMembers).toHaveBeenCalledTimes(1);
});

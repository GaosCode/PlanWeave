import { describe, expect, it } from "vitest";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationProfileView } from "../shared/collaboration";
import type { CollaborationStatus } from "../shared/collaboration";
import {
  isWorkspaceDeviceCredentialMissing,
  resolveWorkspaceIdentityProfile,
  workspaceIdentityStatusLabel
} from "../renderer/team/workspaceConnectionPresentation";

const t = createTranslator("en");

function profile(profileId: string, hasDeviceCredential: boolean): CollaborationProfileView {
  return {
    profileId,
    displayName: profileId,
    serverBaseUrl: "https://workspace.example.test/",
    projectId: "project-1",
    allowInsecureTransport: false,
    endpoint: {
      topology: "private_https",
      serverOrigin: "https://workspace.example.test/",
      allowedClientOrigins: ["https://workspace.example.test/"],
      tlsTrust: "system_ca"
    },
    connectionState: "ready",
    hasDeviceCredential,
    deviceCredentialPersistence: hasDeviceCredential ? "persisted" : "missing",
    deviceCredentialId: hasDeviceCredential ? "device-1" : null,
    humanPrincipalId: hasDeviceCredential ? "human-1" : null,
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}

function connection(
  status: CollaborationStatus["workspaceConnection"]["status"],
  profileId = "workspace-profile"
): CollaborationStatus["workspaceConnection"] {
  return {
    schemaVersion: "workspace-setup/v1",
    status,
    profile: {
      schemaVersion: "workspace-identity/v1",
      profileId,
      displayName: "Workspace",
      serverBaseUrl: "https://workspace.example.test/",
      workspaceId: "workspace-1",
      allowInsecureTransport: false
    },
    workspaceId: "workspace-1",
    workspaceDisplayName: "Workspace",
    connectedAt: status === "connected" ? "2030-01-01T00:00:00.000Z" : null,
    error: null
  };
}

describe("workspaceConnectionPresentation", () => {
  it("does not attribute a missing credential from an unrelated active profile", () => {
    const workspace = connection("connected");
    const identity = resolveWorkspaceIdentityProfile([profile("stale-local", false)], workspace);
    expect(identity).toBeNull();
    expect(isWorkspaceDeviceCredentialMissing(workspace, identity)).toBe(false);
    expect(workspaceIdentityStatusLabel(workspace, t, false)).toBe("Connected");
  });

  it("labels a connected Workspace without its own stored credential as waiting for authorization", () => {
    const workspace = connection("connected");
    const identity = resolveWorkspaceIdentityProfile(
      [profile("workspace-profile", false)],
      workspace
    );
    expect(isWorkspaceDeviceCredentialMissing(workspace, identity)).toBe(true);
    expect(workspaceIdentityStatusLabel(workspace, t, true)).toBe(
      "Configured · waiting for authorization"
    );
  });
});

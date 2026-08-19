/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { SettingsConnectionsSection } from "../renderer/settings/SettingsConnectionsSection";

const remoteOrigin = "https://vm-0-3-ubuntu.tailb06a1e.ts.net/";

const { useHostAdministrationController } = vi.hoisted(() => ({
  useHostAdministrationController: vi.fn()
}));

const collaborationBridge = vi.hoisted(() => ({
  getCollaborationStatus: vi.fn(),
  onCollaborationStatusChanged: vi.fn(() => () => undefined),
  getDesktopServerExposure: vi.fn(),
  getLocalCollaborationServerStatus: vi.fn(),
  listServerDataExportSources: vi.fn().mockResolvedValue({
    sources: [{ id: "this_computer", occupied: false, running: false }]
  }),
  exportServerDataArchive: vi.fn(),
  restoreServerDataArchive: vi.fn()
}));

vi.mock("../renderer/hooks/useHostAdministrationController", () => ({
  useHostAdministrationController
}));

vi.mock("../renderer/bridge", () => ({ collaborationBridge }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsConnectionsSection overview Server row", () => {
  it("shows the connected remote Server URL instead of not-connected", async () => {
    useHostAdministrationController.mockReturnValue({
      hosts: [],
      loadState: "ready",
      hostsLoading: false,
      error: null,
      hostsHasMore: false
    });
    collaborationBridge.getLocalCollaborationServerStatus.mockResolvedValue({
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    });
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      mode: "local_only",
      topology: "loopback_http",
      provider: null,
      lifecycle: "stopped",
      advertisedOrigin: null,
      errorCode: null,
      canActivate: true,
      canInvite: false
    });
    collaborationBridge.getCollaborationStatus.mockResolvedValue({
      profiles: [],
      activeProfileId: null,
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "idle",
        activeProfileId: null,
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-remote",
          displayName: "Configured workspace",
          serverBaseUrl: remoteOrigin,
          workspaceId: "workspace-1",
          allowInsecureTransport: false
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Configured workspace",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: {
        schemaVersion: "workspace-setup/v1",
        items: [],
        nextCursor: null
      },
      updatedAt: "2030-01-01T00:00:00.000Z"
    });

    render(<SettingsConnectionsSection t={createTranslator("zh-CN")} />);

    expect(await screen.findByTestId("settings-connections-server-state")).toHaveTextContent(
      remoteOrigin
    );
    expect(screen.queryByText("尚未开放")).not.toBeInTheDocument();
    expect(screen.queryByText("未连接")).not.toBeInTheDocument();
  });
});

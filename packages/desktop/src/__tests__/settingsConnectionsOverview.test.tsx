/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { SettingsConnectionsSection } from "../renderer/settings/SettingsConnectionsSection";

const remoteOrigin = "https://planweave.tailnet.ts.net/";

const { useHostAdministrationController } = vi.hoisted(() => ({
  useHostAdministrationController: vi.fn()
}));

const collaborationBridge = vi.hoisted(() => ({
  listRememberedServerConnections: vi.fn().mockResolvedValue([
    {
      profileId: "profile-remote",
      displayName: "Configured workspace",
      workspaceDisplayName: "Configured workspace",
      serverBaseUrl: "https://planweave.tailnet.ts.net/",
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://planweave.tailnet.ts.net/",
        allowedClientOrigins: ["https://planweave.tailnet.ts.net/"],
        tlsTrust: "system_ca"
      },
      hasDeviceCredential: true
    }
  ]),
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

const operatorControlBridge = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn().mockResolvedValue({
    activeProfileId: "admin",
    profiles: [
      {
        profileId: "admin",
        operatorId: "owner",
        serverBaseUrl: "https://planweave.tailnet.ts.net/"
      }
    ]
  }),
  onOperatorControlStatusChanged: vi.fn(() => () => undefined),
  getManagementAuthorization: vi.fn().mockResolvedValue({
    profileId: "admin",
    authorization: { operatorId: "owner" },
    errorCode: null
  })
}));
vi.mock("../renderer/bridge", () => ({ collaborationBridge, operatorControlBridge }));

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

    expect(await screen.findByTestId("server-connection-row")).toHaveTextContent(remoteOrigin);
    expect(screen.queryByText("尚未开放")).not.toBeInTheDocument();
    expect(screen.getByTestId("server-connection-row")).not.toHaveTextContent("未连接");
    expect(
      await within(screen.getByTestId("server-connection-row")).findByText("管理员")
    ).toBeVisible();
    expect(screen.queryByTestId("server-management-authorization")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /planweave.tailnet.ts.net/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "管理权限…" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(remoteOrigin);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { SettingsServerSection } from "../renderer/settings/SettingsServerSection";

const advertisedOrigin = "https://this-computer.tailnet.ts.net/";
const remoteOrigin = "https://vps.example.test/";

const localOnlyConnection = {
  schemaVersion: "workspace-setup/v1" as const,
  status: "local_only" as const,
  profile: null,
  workspaceId: null,
  workspaceDisplayName: null,
  connectedAt: null,
  error: null
};

const collaborationStatus = {
  profiles: [],
  activeProfileId: null,
  credentialStorage: "available" as const,
  nonPersistenceWarning: null,
  session: {
    phase: "idle" as const,
    activeProfileId: null,
    detail: null,
    lastErrorCode: null,
    lastErrorMessage: null
  },
  workspaceConnection: localOnlyConnection,
  workspacePicker: { schemaVersion: "workspace-setup/v1" as const, items: [], nextCursor: null },
  updatedAt: "2030-01-01T00:00:00.000Z"
};

const runningLocalStatus = {
  profile: {
    profileId: "planweave-local-server",
    displayName: "Local collaboration server",
    serverBaseUrl: "http://127.0.0.1:8787/",
    allowInsecureTransport: true
  },
  state: "running" as const,
  startedAt: "2030-01-01T00:00:00.000Z",
  reason: null,
  lanSharingEnabled: false,
  lanServerBaseUrl: null
};

const privateHttpsExposure = {
  mode: "private_https" as const,
  topology: "private_https" as const,
  provider: { id: "tailscale", displayName: "Tailscale" },
  lifecycle: "ready" as const,
  advertisedOrigin,
  errorCode: null,
  canActivate: true,
  canInvite: true
};

const collaborationBridge = vi.hoisted(() => ({
  getLocalCollaborationServerStatus: vi.fn(),
  getDesktopServerExposure: vi.fn(),
  getCollaborationStatus: vi.fn(),
  onCollaborationStatusChanged: vi.fn(() => () => undefined),
  getActiveWorkspaceConnection: vi.fn(),
  listRememberedServerConnections: vi.fn().mockResolvedValue([]),
  selectWorkspaceConnection: vi.fn(),
  forgetRememberedServerConnection: vi.fn(),
  retryWorkspaceConnection: vi.fn(),
  setDesktopServerExposureMode: vi.fn(),
  getDeploymentGuidance: vi.fn().mockResolvedValue({
    handoff: { state: "unsupported", reason: "not_available" }
  }),
  validateDeploymentConnectivity: vi.fn(),
  copyDeploymentComposeHandoff: vi.fn(),
  exportDeploymentComposeBundle: vi.fn(),
  listServerDataExportSources: vi.fn().mockResolvedValue({
    sources: [{ id: "this_computer", occupied: true, running: false }]
  }),
  exportServerDataArchive: vi.fn(),
  restoreServerDataArchive: vi.fn(),
  connectExistingServerByOrigin: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({ collaborationBridge }));

function installSelectDomStubs() {
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false)
  });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
}

beforeEach(() => {
  installSelectDomStubs();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockThisComputerRunning() {
  collaborationBridge.getLocalCollaborationServerStatus.mockResolvedValue(runningLocalStatus);
  collaborationBridge.getDesktopServerExposure.mockResolvedValue(privateHttpsExposure);
  collaborationBridge.getCollaborationStatus.mockResolvedValue(collaborationStatus);
  collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue(localOnlyConnection);
}

describe("SettingsServerSection", () => {
  it("shows only local maintenance controls without a redundant Server selector", async () => {
    mockThisComputerRunning();
    render(<SettingsServerSection maintenance t={createTranslator("en")} />);
    expect(await screen.findByTestId("local-server-lifecycle-status")).toHaveTextContent(
      "Connected locally"
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(screen.getByTestId("settings-server-status-detail")).toHaveTextContent(advertisedOrigin);
    expect(screen.queryByTestId("deployment-kind")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-handoff-fallback")).not.toBeInTheDocument();
    expect(screen.getByTestId("deployment-topology")).toHaveAttribute(
      "data-value",
      "private_https"
    );
    expect(collaborationBridge.setDesktopServerExposureMode).not.toHaveBeenCalled();
    expect(collaborationBridge.connectExistingServerByOrigin).not.toHaveBeenCalled();
  });

  it("shows a stopped local process while the independent remote connection remains connected", async () => {
    const remoteConnection = {
      schemaVersion: "workspace-setup/v1" as const,
      status: "connected" as const,
      profile: {
        schemaVersion: "workspace-identity/v1" as const,
        profileId: "profile-remote",
        displayName: "Hosted Server",
        serverBaseUrl: remoteOrigin,
        workspaceId: "workspace-1",
        allowInsecureTransport: false
      },
      workspaceId: "workspace-1",
      workspaceDisplayName: "Hosted Server",
      connectedAt: "2030-01-01T00:00:00.000Z",
      error: null
    };
    collaborationBridge.getLocalCollaborationServerStatus.mockResolvedValue({
      ...runningLocalStatus,
      state: "stopped",
      profile: null,
      startedAt: null
    });
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      ...privateHttpsExposure,
      mode: "custom_https",
      topology: "public_https",
      advertisedOrigin: null,
      provider: null
    });
    collaborationBridge.getCollaborationStatus.mockResolvedValue({
      ...collaborationStatus,
      workspaceConnection: remoteConnection
    });
    collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue(remoteConnection);
    collaborationBridge.listRememberedServerConnections.mockResolvedValue([
      {
        profileId: "profile-remote",
        displayName: "Hosted Server",
        workspaceDisplayName: "Hosted Server",
        serverBaseUrl: remoteOrigin,
        hasDeviceCredential: true
      }
    ]);

    render(<SettingsServerSection maintenance t={createTranslator("en")} />);

    expect(await screen.findByTestId("local-server-lifecycle-status")).toHaveTextContent("Stopped");
    expect(screen.getByText("Server on this computer")).toBeVisible();
    expect(screen.queryByTestId("deployment-kind")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByText(remoteOrigin)).not.toBeInTheDocument();
    expect(collaborationBridge.selectWorkspaceConnection).not.toHaveBeenCalled();
    expect(collaborationBridge.setDesktopServerExposureMode).not.toHaveBeenCalled();
  });

  it("does not put member invite controls on the Server page", async () => {
    mockThisComputerRunning();
    render(<SettingsServerSection maintenance t={createTranslator("en")} />);

    expect(await screen.findByTestId("settings-server-section")).toBeVisible();
    expect(screen.queryByTestId("host-admin-member-setup")).not.toBeInTheDocument();
  });
});

it("opens HTTPS deployment guidance without changing local hosting or connecting a Server", async () => {
  mockThisComputerRunning();
  collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue(localOnlyConnection);
  render(<SettingsServerSection maintenance t={createTranslator("en")} />);
  await screen.findByTestId("deployment-topology");
  await userEvent.click(screen.getByTestId("settings-server-deploy-https"));
  expect(await screen.findByTestId("deployment-custom-topology")).toBeVisible();
  await userEvent.type(screen.getByTestId("deployment-display-name"), "My Server");
  await userEvent.type(screen.getByTestId("deployment-origin"), "https://server.example/");
  await userEvent.click(
    screen.getByRole("button", { name: createTranslator("en")("deploymentReview") })
  );
  await screen.findByTestId("deployment-guidance");
  expect(collaborationBridge.getDeploymentGuidance).toHaveBeenCalledWith(
    expect.objectContaining({
      target: expect.objectContaining({
        endpoint: expect.objectContaining({ serverOrigin: "https://server.example/" })
      })
    })
  );
  expect(collaborationBridge.setDesktopServerExposureMode).not.toHaveBeenCalled();
  expect(collaborationBridge.connectExistingServerByOrigin).not.toHaveBeenCalled();
});

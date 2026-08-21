/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { DeploymentConnectionCard } from "../renderer/settings/DeploymentConnectionCard";

const defaultExposure = {
  mode: "local_only" as const,
  topology: "loopback_http" as const,
  provider: null,
  lifecycle: "ready" as const,
  advertisedOrigin: null,
  errorCode: null,
  canActivate: true,
  canInvite: true
};

const collaborationBridge = vi.hoisted(() => ({
  getActiveWorkspaceConnection: vi.fn().mockResolvedValue({ profile: null, workspaceId: null }),
  listRememberedServerConnections: vi.fn().mockResolvedValue([]),
  selectWorkspaceConnection: vi.fn(),
  forgetRememberedServerConnection: vi.fn(),
  getDesktopServerExposure: vi.fn(),
  setDesktopServerExposureMode: vi.fn(),
  getDeploymentGuidance: vi.fn().mockResolvedValue({
    handoff: { state: "unsupported", reason: "not_available" }
  }),
  validateDeploymentConnectivity: vi.fn(),
  copyDeploymentComposeHandoff: vi.fn(),
  exportDeploymentComposeBundle: vi.fn(),
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

async function chooseSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  optionName: string
) {
  await user.click(screen.getByTestId(testId));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

describe("DeploymentConnectionCard", () => {
  beforeEach(() => {
    installSelectDomStubs();
    collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue({
      profile: null,
      workspaceId: null
    });
    collaborationBridge.getDesktopServerExposure.mockResolvedValue(defaultExposure);
    collaborationBridge.getDeploymentGuidance.mockResolvedValue({
      handoff: { state: "unsupported", reason: "not_available" }
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not keep this computer's advertised origin when switching to an existing Server", async () => {
    const user = userEvent.setup();
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "ready",
      advertisedOrigin: "https://this-computer.tailnet.ts.net/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue({
      profile: {
        serverBaseUrl: "https://this-computer.tailnet.ts.net/",
        displayName: "Local collaboration server"
      },
      workspaceId: "workspace-local"
    });
    render(<DeploymentConnectionCard t={createTranslator("en")} />);
    await waitFor(() => expect(collaborationBridge.getDesktopServerExposure).toHaveBeenCalled());

    await chooseSelectOption(user, "deployment-kind", "Existing Server");
    expect(screen.getByTestId("deployment-origin")).toHaveValue("");
    expect(screen.queryByTestId("deployment-advertised-origin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-exposure-provider")).not.toBeInTheDocument();
    expect(
      screen.getByText("Use the Server host HTTPS address, not this computer's Tailscale URL.")
    ).toBeInTheDocument();
  });

  it("restores this computer's access method after leaving Existing Server", async () => {
    const user = userEvent.setup();
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "ready",
      advertisedOrigin: "https://this-computer.tailnet.ts.net/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    render(<DeploymentConnectionCard t={createTranslator("en")} />);
    await waitFor(() => expect(collaborationBridge.getDesktopServerExposure).toHaveBeenCalled());
    expect(screen.getByTestId("deployment-topology")).toHaveAttribute(
      "data-value",
      "private_https"
    );

    await chooseSelectOption(user, "deployment-kind", "Existing Server");
    expect(screen.queryByTestId("deployment-topology")).not.toBeInTheDocument();

    await chooseSelectOption(user, "deployment-kind", "This computer");
    expect(screen.getByTestId("deployment-topology")).toHaveAttribute(
      "data-value",
      "private_https"
    );
    expect(collaborationBridge.setDesktopServerExposureMode).not.toHaveBeenCalled();
  });

  it("keeps custom HTTPS guidance available without an authenticated Workspace", async () => {
    const user = userEvent.setup();
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    await chooseSelectOption(user, "deployment-kind", "Existing Server");
    await user.type(screen.getByTestId("deployment-display-name"), "Hosted Server");
    await user.type(screen.getByTestId("deployment-origin"), "https://server.example.test");

    expect(screen.getByRole("button", { name: "View deploy steps" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Validate endpoint" })).toBeEnabled();
  });

  it("uses system trust for a private HTTPS endpoint on a non-standard port", async () => {
    const user = userEvent.setup();
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    await chooseSelectOption(user, "deployment-kind", "Existing Server");
    await user.type(screen.getByTestId("deployment-display-name"), "LAN Server");
    await user.type(screen.getByTestId("deployment-origin"), "https://192.168.1.20:7443");
    await chooseSelectOption(user, "deployment-custom-topology", "Private network HTTPS");
    expect(screen.queryByTestId("deployment-tls-trust")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "HTTPS certificates must be trusted by the operating system. For a private CA, install it in the system trust store first."
      )
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));

    expect(collaborationBridge.getDeploymentGuidance).toHaveBeenCalledWith({
      action: "request_deployment_guidance",
      target: expect.objectContaining({
        endpoint: {
          topology: "private_https",
          serverOrigin: "https://192.168.1.20:7443/",
          allowedClientOrigins: ["https://192.168.1.20:7443/"],
          tlsTrust: "system_ca"
        }
      })
    });
  });

  it("activates automatic private HTTPS without asking the renderer for an Origin", async () => {
    const user = userEvent.setup();
    const onExposureChange = vi.fn();
    collaborationBridge.setDesktopServerExposureMode.mockResolvedValue({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "ready",
      advertisedOrigin: "https://planweave.example.ts.net/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    render(
      <DeploymentConnectionCard t={createTranslator("en")} onExposureChange={onExposureChange} />
    );
    await waitFor(() => expect(collaborationBridge.getDesktopServerExposure).toHaveBeenCalled());

    await chooseSelectOption(
      user,
      "deployment-topology",
      "Private network HTTPS (automatic, recommended)"
    );
    expect(screen.queryByTestId("deployment-origin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-display-name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enable this connection" }));

    expect(collaborationBridge.setDesktopServerExposureMode).toHaveBeenCalledWith({
      mode: "private_https"
    });
    expect(screen.getByTestId("deployment-advertised-origin")).toHaveTextContent(
      "https://planweave.example.ts.net/"
    );
    expect(onExposureChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "private_https", lifecycle: "ready" })
    );
  });

  it("keeps an existing Server on this page instead of sending the user to Members", async () => {
    const user = userEvent.setup();
    const onExistingServerChange = vi.fn();
    collaborationBridge.validateDeploymentConnectivity.mockResolvedValue({
      status: "reachable"
    });
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "ready",
      advertisedOrigin: "https://this-computer.tailnet.ts.net/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    render(
      <DeploymentConnectionCard
        t={createTranslator("en")}
        onExistingServerChange={onExistingServerChange}
      />
    );
    await waitFor(() => expect(collaborationBridge.getDesktopServerExposure).toHaveBeenCalled());

    await chooseSelectOption(user, "deployment-kind", "Existing Server");
    expect(onExistingServerChange).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId("deployment-advertised-origin")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("deployment-display-name"), "VPS Server");
    await user.type(screen.getByTestId("deployment-origin"), "https://planweave.tailnet.ts.net/");
    await user.click(screen.getByRole("button", { name: "Validate endpoint" }));

    expect(await screen.findByTestId("deployment-connectivity")).toHaveTextContent("Reachable");
    expect(screen.queryByRole("button", { name: "Connect in Members" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-connect-in-people")).not.toBeInTheDocument();
  });

  it("keeps existing-Server deploy fields collapsed when asked", async () => {
    const user = userEvent.setup();
    collaborationBridge.validateDeploymentConnectivity.mockResolvedValue({
      status: "reachable"
    });
    render(<DeploymentConnectionCard t={createTranslator("en")} existingServerTools="collapsed" />);

    await chooseSelectOption(user, "deployment-kind", "Existing Server");
    expect(screen.getByTestId("deployment-existing-connect-hint")).toBeVisible();
    expect(screen.getByTestId("deployment-origin")).toBeVisible();
    expect(screen.getByTestId("deployment-origin-connect")).toBeVisible();
    expect(screen.getByTestId("deployment-existing-tools")).toBeVisible();
    expect(screen.getByTestId("deployment-export-package")).toHaveTextContent("Deploy tools");
    expect(screen.getByTestId("deployment-export-package")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.getByTestId("deployment-check-connectivity")).toHaveTextContent(
      "Check connectivity"
    );
    expect(screen.queryByTestId("deployment-display-name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Validate endpoint" })).not.toBeInTheDocument();

    await user.type(screen.getByTestId("deployment-origin"), "https://server.example.test");
    await user.click(screen.getByTestId("deployment-check-connectivity"));
    await waitFor(() =>
      expect(collaborationBridge.validateDeploymentConnectivity).toHaveBeenCalledWith({
        action: "validate_connectivity",
        target: expect.objectContaining({
          displayName: "server.example.test",
          endpoint: expect.objectContaining({
            serverOrigin: "https://server.example.test/"
          })
        })
      })
    );
    expect(screen.queryByTestId("deployment-display-name")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("deployment-origin-connect"));
    await waitFor(() =>
      expect(collaborationBridge.connectExistingServerByOrigin).toHaveBeenCalledWith({
        serverBaseUrl: "https://server.example.test/"
      })
    );

    collaborationBridge.connectExistingServerByOrigin.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'planweave-collaboration:connectExistingServerByOrigin': CollaborationClientError: existing_server_admission_required"
      )
    );
    await user.click(screen.getByTestId("deployment-origin-connect"));
    expect(await screen.findByTestId("deployment-origin-connect-error")).toHaveTextContent(
      "Couldn’t connect with this address. Paste the complete connection details."
    );
    expect(screen.queryByText(/administer/i)).not.toBeInTheDocument();

    await user.click(screen.getByTestId("deployment-export-package"));
    expect(screen.getByTestId("deployment-display-name")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Validate endpoint" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View deploy steps" })).toBeVisible();
  });

  it("labels raw LAN HTTP as an advanced separate option", async () => {
    const user = userEvent.setup();
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    await user.click(screen.getByTestId("deployment-topology"));
    expect(
      await screen.findByRole("option", { name: "LAN HTTP (development only)" })
    ).toBeVisible();
  });

  it("supports a flat presentation without nesting another card", () => {
    const { container } = render(
      <DeploymentConnectionCard presentation="plain" t={createTranslator("en")} />
    );

    expect(screen.getByRole("heading", { name: "Server" })).toBeVisible();
    expect(screen.getByLabelText("Location")).toBeVisible();
    expect(
      screen.queryByText(/Changing the connection only changes how Server is reached/)
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
  });

  it("lists remembered Servers and reconnects the selected one", async () => {
    const user = userEvent.setup();
    collaborationBridge.listRememberedServerConnections.mockResolvedValue([
      {
        profileId: "profile-workspace-001",
        displayName: "Workspace collaboration server",
        workspaceDisplayName: "Configured workspace",
        serverBaseUrl: "https://planweave.tailnet.ts.net/",
        hasDeviceCredential: true
      }
    ]);
    collaborationBridge.selectWorkspaceConnection.mockResolvedValue({
      workspaceConnection: { status: "connected" }
    });
    render(<DeploymentConnectionCard t={createTranslator("en")} existingServerTools="collapsed" />);
    await waitFor(() =>
      expect(collaborationBridge.listRememberedServerConnections).toHaveBeenCalled()
    );

    await chooseSelectOption(
      user,
      "deployment-kind",
      "Configured workspace (planweave.tailnet.ts.net)"
    );
    await waitFor(() =>
      expect(collaborationBridge.selectWorkspaceConnection).toHaveBeenCalledWith({
        profileId: "profile-workspace-001"
      })
    );
    expect(screen.getByTestId("deployment-kind")).toHaveAttribute(
      "data-value",
      "profile-workspace-001"
    );
    expect(screen.getByTestId("deployment-origin")).toHaveValue(
      "https://planweave.tailnet.ts.net/"
    );
    await user.click(screen.getByTestId("deployment-kind"));
    expect(await screen.findByRole("option", { name: "Connect another Server" })).toBeVisible();
  });

  it("restores the last remote Server in Location after restart", async () => {
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "ready",
      advertisedOrigin: "https://this-computer.tailnet.ts.net/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    collaborationBridge.listRememberedServerConnections.mockResolvedValue([
      {
        profileId: "profile-workspace-001",
        displayName: "Workspace collaboration server",
        workspaceDisplayName: "Configured workspace",
        serverBaseUrl: "https://planweave.tailnet.ts.net/",
        hasDeviceCredential: true
      }
    ]);
    collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue({
      status: "connected",
      profile: {
        profileId: "profile-workspace-001",
        displayName: "Workspace collaboration server",
        serverBaseUrl: "https://planweave.tailnet.ts.net/"
      },
      workspaceId: "workspace-demo-001",
      workspaceDisplayName: "Configured workspace"
    });
    render(<DeploymentConnectionCard t={createTranslator("en")} existingServerTools="collapsed" />);

    await waitFor(() =>
      expect(screen.getByTestId("deployment-kind")).toHaveAttribute(
        "data-value",
        "profile-workspace-001"
      )
    );
    expect(collaborationBridge.selectWorkspaceConnection).not.toHaveBeenCalled();
    expect(screen.getByTestId("deployment-origin")).toHaveValue(
      "https://planweave.tailnet.ts.net/"
    );
  });

  it("forgets a remembered Server and returns Location to this computer", async () => {
    const user = userEvent.setup();
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "stopped",
      advertisedOrigin: null,
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    collaborationBridge.listRememberedServerConnections.mockResolvedValue([
      {
        profileId: "profile-workspace-001",
        displayName: "Workspace collaboration server",
        workspaceDisplayName: "Configured workspace",
        serverBaseUrl: "https://planweave.tailnet.ts.net/",
        hasDeviceCredential: true
      }
    ]);
    collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue({
      status: "connected",
      profile: {
        profileId: "profile-workspace-001",
        displayName: "Workspace collaboration server",
        serverBaseUrl: "https://planweave.tailnet.ts.net/"
      },
      workspaceId: "workspace-demo-001",
      workspaceDisplayName: "Configured workspace"
    });
    collaborationBridge.forgetRememberedServerConnection.mockResolvedValue({
      workspaceConnection: { status: "local_only", profile: null }
    });
    render(<DeploymentConnectionCard t={createTranslator("en")} existingServerTools="collapsed" />);
    await waitFor(() => expect(screen.getByTestId("deployment-forget-server")).toBeVisible());

    collaborationBridge.listRememberedServerConnections.mockResolvedValue([]);
    await user.click(screen.getByTestId("deployment-forget-server"));
    await waitFor(() =>
      expect(collaborationBridge.forgetRememberedServerConnection).toHaveBeenCalledWith({
        profileId: "profile-workspace-001"
      })
    );
    expect(screen.getByTestId("deployment-kind")).toHaveAttribute("data-value", "this_computer");
    expect(screen.getByTestId("deployment-topology")).toHaveAttribute(
      "data-value",
      "private_https"
    );
  });
});

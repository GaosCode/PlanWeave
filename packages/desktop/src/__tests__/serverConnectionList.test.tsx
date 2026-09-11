/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { activeWorkspaceConnectionViewSchema } from "@planweave-ai/collaboration-protocol/connection";
import { ServerConnectionList } from "../renderer/settings/ServerConnectionList";
import { createTranslator } from "../renderer/i18n";

const api = vi.hoisted(() => ({
  listRememberedServerConnections: vi.fn(),
  selectWorkspaceConnection: vi.fn().mockResolvedValue(undefined),
  validateDeploymentConnectivity: vi.fn().mockResolvedValue({ status: "reachable" })
}));
let connection = activeWorkspaceConnectionViewSchema.parse({
  schemaVersion: "workspace-setup/v1",
  status: "connected",
  profile: {
    schemaVersion: "workspace-identity/v1",
    profileId: "active",
    displayName: "Configured workspace",
    serverBaseUrl: "https://vps.example/",
    workspaceId: "team",
    allowInsecureTransport: false
  },
  workspaceId: "team",
  workspaceDisplayName: "Team",
  connectedAt: "2030-01-01T00:00:00.000Z",
  error: null
});
vi.mock("../renderer/bridge", () => ({ collaborationBridge: api }));
vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: { workspaceConnection: connection },
    refresh: async () => undefined
  })
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function fixture(status: "connected" | "disconnected" = "connected") {
  connection = { ...connection, status };
  api.listRememberedServerConnections.mockResolvedValue(
    ["active", "other"].map((profileId) => ({
      profileId,
      displayName: "Configured workspace",
      workspaceDisplayName: "Team",
      serverBaseUrl: "https://vps.example/",
      hasDeviceCredential: true
    }))
  );
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
}
it("shows the destination host and marks the active saved connection without reconnecting it", async () => {
  fixture();
  expect(await screen.findByTestId("server-connection-row")).toHaveTextContent("vps.example");
  await userEvent.click(screen.getByRole("button", { name: /More actions/ }));
  expect(screen.getByRole("menuitem", { name: /Current connection/ })).toHaveAttribute(
    "data-disabled"
  );
  await userEvent.click(screen.getByRole("menuitem", { name: /Use connection.*other/ }));
  await waitFor(() =>
    expect(api.selectWorkspaceConnection).toHaveBeenCalledWith({ profileId: "other" })
  );
});
it("checks the Server without changing the selected Workspace connection", async () => {
  fixture();
  await screen.findByTestId("server-connection-row");
  await userEvent.click(screen.getByRole("button", { name: "Check connectivity" }));
  await waitFor(() => expect(api.validateDeploymentConnectivity).toHaveBeenCalledOnce());
  expect(api.validateDeploymentConnectivity.mock.calls[0]?.[0].target.endpoint.serverOrigin).toBe(
    "https://vps.example/"
  );
  expect(api.selectWorkspaceConnection).not.toHaveBeenCalled();
});

it("lets the user choose a saved connection before connecting a Server with multiple records", async () => {
  fixture("disconnected");
  await screen.findByTestId("server-connection-row");
  await userEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  expect(await screen.findByRole("menu")).toBeVisible();
  expect(api.selectWorkspaceConnection).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("menuitem", { name: /Use connection.*other/ }));
  await waitFor(() =>
    expect(api.selectWorkspaceConnection).toHaveBeenCalledExactlyOnceWith({ profileId: "other" })
  );
});
it("keeps a failed switch visible without replacing the active destination", async () => {
  api.selectWorkspaceConnection.mockRejectedValueOnce(
    new Error("The configured Server could not be reached.")
  );
  fixture();
  await screen.findByTestId("server-connection-row");
  await userEvent.click(screen.getByRole("button", { name: /More actions/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Use connection.*other/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    createTranslator("en")("peopleServerUnreachable")
  );
  expect(connection.profile?.profileId).toBe("active");
});

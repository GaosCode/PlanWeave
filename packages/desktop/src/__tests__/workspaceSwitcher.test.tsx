/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { activeWorkspaceConnectionViewSchema } from "@planweave-ai/collaboration-protocol/connection";
import { WorkspaceSwitcher } from "../renderer/team/WorkspaceSwitcher";
import { createTranslator } from "../renderer/i18n";

const connection = activeWorkspaceConnectionViewSchema.parse({
  schemaVersion: "workspace-setup/v1",
  status: "connected",
  profile: {
    schemaVersion: "workspace-identity/v1",
    profileId: "remote",
    displayName: "Server",
    serverBaseUrl: "https://remote.example/",
    workspaceId: "team",
    allowInsecureTransport: false
  },
  workspaceId: "team",
  workspaceDisplayName: "Team",
  connectedAt: "2030-01-01T00:00:00.000Z",
  error: null
});
afterEach(cleanup);
function fixture() {
  const api = {
    listWorkspacePicker: vi.fn().mockResolvedValue({
      items: ["team", "other"].map((workspaceId) => ({
        workspaceId,
        displayName: workspaceId === "team" ? "Team" : "Other",
        role: "owner",
        membershipActive: true,
        archivedAt: null
      })),
      nextCursor: null
    }),
    selectWorkspaceConnection: vi.fn().mockResolvedValue(undefined)
  };
  const onJoin = vi.fn();
  const onSelected = vi.fn().mockResolvedValue(undefined);
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <WorkspaceSwitcher
        api={api}
        status={{ workspaceConnection: connection }}
        open={open}
        onOpenChange={setOpen}
        onJoin={onJoin}
        onSelected={onSelected}
        t={createTranslator("en")}
      />
    );
  }
  render(<Harness />);
  return { api, onJoin, onSelected };
}
it("opens a workspace list, treats the current owner row as a no-op, and keeps joining separate", async () => {
  const { api, onJoin } = fixture();
  await userEvent.click(screen.getByTestId("people-current-workspace-switch"));
  await userEvent.click(await screen.findByTestId("workspace-switch-team"));
  expect(api.selectWorkspaceConnection).not.toHaveBeenCalled();
  expect(screen.queryByTestId("workspace-switcher")).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId("people-current-workspace-switch"));
  await userEvent.click(screen.getByRole("button", { name: "Join another workspace…" }));
  expect(onJoin).toHaveBeenCalledOnce();
});
it("selects another Workspace and refreshes the surrounding page", async () => {
  const { api, onSelected } = fixture();
  await userEvent.click(screen.getByTestId("people-current-workspace-switch"));
  await userEvent.click(await screen.findByTestId("workspace-switch-other"));
  await waitFor(() => expect(onSelected).toHaveBeenCalledOnce());
  expect(api.selectWorkspaceConnection).toHaveBeenCalledWith({ workspaceId: "other" });
});
it("keeps the current selection visible when a switch fails and shows a localized status", async () => {
  const { api, onSelected } = fixture();
  api.selectWorkspaceConnection.mockRejectedValue(
    new Error("The configured Server could not be reached.")
  );
  await userEvent.click(screen.getByTestId("people-current-workspace-switch"));
  await userEvent.click(await screen.findByTestId("workspace-switch-other"));
  expect(await screen.findByRole("status")).toHaveTextContent(
    createTranslator("en")("peopleServerUnreachable")
  );
  expect(screen.getByTestId("people-current-workspace-switch")).toHaveTextContent("Team");
  expect(onSelected).not.toHaveBeenCalled();
});

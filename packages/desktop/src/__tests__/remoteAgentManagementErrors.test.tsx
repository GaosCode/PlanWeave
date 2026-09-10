/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ExecutorInventory } from "../renderer/executors/ExecutorInventory";
import { useRemoteAgentManagementController } from "../renderer/hooks/useRemoteAgentManagementController";
import { RemoteAgentManagementCard } from "../renderer/settings/RemoteAgentManagementCard";
import { createTranslator } from "../renderer/i18n";

const mocks = vi.hoisted(() => ({
  listOperatorRemoteAgents: vi.fn(),
  owner: { humanPrincipalId: "human-1", operatorProfileId: "profile-1" }
}));

vi.mock("../renderer/bridge", () => ({
  operatorControlBridge: { listOperatorRemoteAgents: mocks.listOperatorRemoteAgents },
  collaborationBridge: null
}));
vi.mock("../renderer/hooks/useOwnerControlPlaneAvailability", () => ({
  useOwnerControlPlaneAvailability: () => mocks.owner
}));
vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({ status: null })
}));

beforeEach(() => {
  mocks.listOperatorRemoteAgents.mockReset();
});
afterEach(cleanup);

describe("Remote Agent management failures", () => {
  it("keeps the local executor configurable when the remote Server is offline", async () => {
    mocks.listOperatorRemoteAgents.mockRejectedValue(new Error("operator_offline"));
    const configure = vi.fn();
    function Inventory() {
      const remote = useRemoteAgentManagementController();
      return (
        <ExecutorInventory
          agents={[
            {
              kind: "codex",
              runnerKind: "cli",
              name: "Codex",
              command: "codex",
              versionArgs: [],
              execArgs: [],
              fullAccessArgs: [],
              installed: true,
              version: null,
              unavailableReason: null
            }
          ]}
          transport="cli"
          hosts={[]}
          remote={remote}
          refreshing={false}
          onRefresh={vi.fn()}
          onConfigure={configure}
          t={createTranslator("en")}
        />
      );
    }
    render(<Inventory />);
    expect(screen.getByTestId("executor-local-row")).toHaveTextContent("Codex");
    expect(await screen.findByText(createTranslator("en")("hostAdminOffline"))).toBeVisible();
    expect(screen.queryByText(/operator_offline|Error invoking/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(configure).toHaveBeenCalledOnce();
  });

  it.each([
    ["operator_offline", "hostAdminOffline"],
    ["operator_timeout", "hostAdminOffline"],
    ["operator_unauthorized", "hostAdminUnauthorized"],
    ["unexpected database detail", "hostAdminErrorGeneric"]
  ] as const)("humanizes serialized IPC failure %s without a false empty list", async (code, key) => {
    const t = createTranslator("zh-CN");
    mocks.listOperatorRemoteAgents.mockRejectedValue(
      new Error(
        `Error invoking remote method 'planweave-operator:listRemoteAgents': OperatorControlError: ${code}`
      )
    );
    render(<RemoteAgentManagementCard t={t} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(t(key));
    expect(screen.queryByTestId("remote-agent-management-empty")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Error invoking|OperatorControlError|operator_offline|database detail/)
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-refresh")).toBeEnabled();
  });

  it("shows an empty list only after a successful retry", async () => {
    const t = createTranslator("en");
    let resolve!: (value: { items: [] }) => void;
    mocks.listOperatorRemoteAgents
      .mockRejectedValueOnce(new Error("operator_offline"))
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
    render(<RemoteAgentManagementCard t={t} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByTestId("remote-agent-management-refresh"));
    expect(screen.queryByTestId("remote-agent-management-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-refresh")).toBeDisabled();
    await act(async () => resolve({ items: [] }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-empty")).toHaveTextContent(
      t("remoteAgentManagementEmpty")
    );
  });

  it("does not report an empty fleet while the first request is pending", () => {
    mocks.listOperatorRemoteAgents.mockImplementation(() => new Promise(() => {}));
    render(<RemoteAgentManagementCard t={createTranslator("en")} />);
    expect(screen.queryByTestId("remote-agent-management-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-refresh")).toBeDisabled();
  });
});

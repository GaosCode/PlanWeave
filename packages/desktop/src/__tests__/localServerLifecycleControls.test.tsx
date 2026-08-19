/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalServerLifecycleControls } from "../renderer/collaboration/LocalServerLifecycleControls";
import { createTranslator } from "../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

const advertisedOrigin = "https://this-computer.tailnet.ts.net/";

const runningStatus = {
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

const stoppedStatus = {
  profile: null,
  state: "stopped" as const,
  startedAt: null,
  reason: null,
  lanSharingEnabled: false,
  lanServerBaseUrl: null
};

afterEach(cleanup);

function api(overrides: Partial<PlanWeaveCollaborationApi> = {}): PlanWeaveCollaborationApi {
  return {
    getLocalCollaborationServerStatus: vi.fn().mockResolvedValue(stoppedStatus),
    getDesktopServerExposure: vi.fn().mockResolvedValue({
      mode: "local_only",
      topology: "loopback_http",
      provider: null,
      lifecycle: "ready",
      advertisedOrigin: null,
      errorCode: null,
      canActivate: true,
      canInvite: true
    }),
    startLocalCollaborationServer: vi.fn().mockResolvedValue(runningStatus),
    stopLocalCollaborationServer: vi.fn().mockResolvedValue(stoppedStatus),
    ...overrides
  } as PlanWeaveCollaborationApi;
}

describe("LocalServerLifecycleControls", () => {
  it("starts and stops the local Server process", async () => {
    let serverState: "stopped" | "running" = "stopped";
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn(async () =>
        serverState === "running" ? runningStatus : stoppedStatus
      ),
      startLocalCollaborationServer: vi.fn(async () => {
        serverState = "running";
        return runningStatus;
      })
    });

    render(<LocalServerLifecycleControls api={collaborationApi} t={createTranslator("en")} />);

    expect(screen.getByTestId("local-server-lifecycle")).not.toHaveClass(
      "rounded-md",
      "shadow-sm",
      "bg-surface-raised"
    );
    expect(await screen.findByTestId("local-server-lifecycle-status")).toHaveTextContent(
      "Not connected"
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(collaborationApi.startLocalCollaborationServer).toHaveBeenCalledOnce()
    );
    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();
    expect(screen.getByTestId("local-server-lifecycle-status")).toHaveTextContent(
      "Connected locally"
    );

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(collaborationApi.stopLocalCollaborationServer).toHaveBeenCalledOnce()
    );
  });

  it("keeps this-computer controls when Workspace is the local origin", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue(runningStatus),
      getDesktopServerExposure: vi.fn().mockResolvedValue({
        mode: "private_https",
        topology: "private_https",
        provider: { id: "tailscale", displayName: "Tailscale" },
        lifecycle: "ready",
        advertisedOrigin,
        errorCode: null,
        canActivate: true,
        canInvite: true
      })
    });

    render(
      <LocalServerLifecycleControls
        api={collaborationApi}
        t={createTranslator("en")}
        workspace={{
          status: "connected",
          serverBaseUrl: advertisedOrigin,
          displayName: "Local collaboration server"
        }}
      />
    );

    expect(await screen.findByTestId("local-server-lifecycle-status")).toHaveTextContent(
      "Connected locally"
    );
    expect(screen.getByTestId("settings-server-status-detail")).toHaveTextContent(advertisedOrigin);
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });

  it("shows a remote connection without local start or stop", async () => {
    render(
      <LocalServerLifecycleControls
        api={api()}
        t={createTranslator("en")}
        workspace={{
          status: "connected",
          serverBaseUrl: "https://vm.example.test/",
          displayName: "Configured workspace"
        }}
      />
    );

    expect(await screen.findByText("Server status")).toBeVisible();
    expect(screen.getByTestId("local-server-lifecycle-status")).toHaveTextContent(
      "Connected remotely"
    );
    expect(screen.getByTestId("settings-server-status-detail")).toHaveTextContent(
      "https://vm.example.test/"
    );
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("retries a failed remote Server without starting this computer", async () => {
    const retryWorkspaceConnection = vi.fn().mockResolvedValue(undefined);
    const onRetried = vi.fn();
    render(
      <LocalServerLifecycleControls
        api={api({ retryWorkspaceConnection })}
        t={createTranslator("en")}
        onRetried={onRetried}
        workspace={{
          status: "error",
          serverBaseUrl: "https://vm.example.test/",
          displayName: "Configured workspace"
        }}
      />
    );

    expect(await screen.findByTestId("local-server-lifecycle-status")).toHaveTextContent(
      "Remote connection failed"
    );
    expect(screen.getByTestId("settings-server-status-detail")).toHaveTextContent(
      "https://vm.example.test/"
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retryWorkspaceConnection).toHaveBeenCalledOnce());
    expect(onRetried).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("hides start when idle start is disabled", async () => {
    render(
      <LocalServerLifecycleControls api={api()} t={createTranslator("en")} showIdleStart={false} />
    );

    expect(await screen.findByTestId("local-server-lifecycle-status")).toHaveTextContent(
      "Not connected"
    );
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });
});

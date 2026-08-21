/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCollaborationServerPanel } from "../renderer/collaboration/LocalCollaborationServerPanel";
import { createTranslator } from "../renderer/i18n";
import {
  parseCollaborationInvitationHandoff,
  serializeCollaborationInvitationHandoff
} from "../renderer/team/collaborationInvitationHandoff";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import type { DesktopServerExposureView } from "../shared/deploymentExposure";

const profile = {
  profileId: "planweave-local-server",
  displayName: "Local collaboration server",
  serverBaseUrl: "http://127.0.0.1:8787/",
  allowInsecureTransport: true
};
const expandedScopeLayout = {
  collapsed: false,
  expandedProjectIds: ["desktop-project-1"]
};
const onScopeLayoutChange = vi.fn();
const copyText = vi.fn(async () => undefined);
const remoteServerExposure: DesktopServerExposureView = {
  mode: "private_https",
  topology: "private_https",
  provider: { id: "private-network", displayName: "Private network" },
  lifecycle: "ready",
  advertisedOrigin: "https://planweave.example.test/",
  errorCode: null,
  canActivate: true,
  canInvite: true
};
afterEach(cleanup);

function invitationHandoff(invitationToken: string, invitationId = "invitation-default") {
  return {
    invitationToken,
    invitation: { invitationId },
    handoff: serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:8787/",
        allowedClientOrigins: ["http://192.168.1.20:8787/"],
        tlsTrust: "not_applicable"
      },
      projectId: "authority-project-1",
      invitationToken
    })
  };
}

function LocalCollaborationServerPanelHarness({
  serverExposure = remoteServerExposure,
  ...props
}: Omit<
  ComponentProps<typeof LocalCollaborationServerPanel>,
  "invitationHandoff" | "onInvitationHandoffChange" | "serverExposure"
> & { serverExposure?: DesktopServerExposureView | null }) {
  const [invitationHandoff, setInvitationHandoff] = useState<string | null>(null);
  return (
    <LocalCollaborationServerPanel
      {...props}
      invitationHandoff={invitationHandoff}
      onInvitationHandoffChange={setInvitationHandoff}
      serverExposure={serverExposure}
    />
  );
}

function api(overrides: Partial<PlanWeaveCollaborationApi> = {}): PlanWeaveCollaborationApi {
  const catalog = {
    projects: [
      {
        projectId: "desktop-project-1",
        name: "Project One",
        selectedCanvasCount: 1,
        canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: true, current: true }]
      }
    ],
    selectedCount: 1
  };
  return {
    getDesktopServerExposure: vi.fn().mockResolvedValue({
      mode: "lan_http",
      topology: "lan_http",
      provider: null,
      lifecycle: "ready",
      advertisedOrigin: "http://192.168.1.20:8787/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    }),
    getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    }),
    startLocalCollaborationServer: vi.fn().mockResolvedValue({
      profile,
      state: "running",
      startedAt: "2030-01-01T00:00:00.000Z",
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    }),
    stopLocalCollaborationServer: vi.fn().mockResolvedValue({
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    }),
    setLocalCollaborationLanSharing: vi.fn().mockResolvedValue({
      profile,
      state: "running",
      startedAt: "2030-01-01T00:00:00.000Z",
      reason: null,
      lanSharingEnabled: true,
      lanServerBaseUrl: "http://192.168.1.20:8787/"
    }),
    listLocalCollaborationTrustedScopes: vi
      .fn()
      .mockResolvedValue([
        { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" }
      ]),
    getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue(catalog),
    setLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue(catalog),
    bootstrapCollaborationOwner: vi.fn().mockResolvedValue({
      deviceCredentialPersistence: "persisted",
      nonPersistenceWarning: null
    }),
    registerLocalCollaborationCurrentProject: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      profileId: profile.profileId,
      registeredAt: "2030-01-01T00:00:01.000Z"
    }),
    createCollaborationInvitationHandoff: vi
      .fn()
      .mockResolvedValue(invitationHandoff(`pw_inv_${"B".repeat(43)}`)),
    ...overrides
  } as PlanWeaveCollaborationApi;
}

describe("LocalCollaborationServerPanel", () => {
  it("applies an explicit canvas selection and lets main start the internal service", async () => {
    const emptyCatalog = {
      projects: [
        {
          projectId: "desktop-project-1",
          name: "Project One",
          selectedCanvasCount: 0,
          canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: false, current: true }]
        }
      ],
      selectedCount: 0
    };
    const selectedCatalog = {
      ...emptyCatalog,
      selectedCount: 1,
      projects: [
        {
          ...emptyCatalog.projects[0],
          selectedCanvasCount: 1,
          canvases: [{ ...emptyCatalog.projects[0]!.canvases[0]!, selected: true }]
        }
      ]
    };
    const collaborationApi = api({
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue(emptyCatalog),
      setLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue(selectedCatalog)
    });
    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Project One / Canvas One" })
    );
    expect(
      screen.getByTestId("local-collaboration-scope-status-desktop-project-1-canvas-1")
    ).toHaveTextContent("Pending apply");
    expect(screen.queryByText("Hosted here")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    await waitFor(() =>
      expect(collaborationApi.setLocalCollaborationTrustedScopes).toHaveBeenCalledWith({
        scopes: [{ projectId: "desktop-project-1", canvasId: "canvas-1" }]
      })
    );
    expect(collaborationApi.startLocalCollaborationServer).not.toHaveBeenCalled();
  });

  it("keeps a failed local hosting change pending instead of presenting it as applied", async () => {
    const emptyCatalog = {
      projects: [
        {
          projectId: "desktop-project-1",
          name: "Project One",
          selectedCanvasCount: 0,
          canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: false, current: true }]
        }
      ],
      selectedCount: 0
    };
    const collaborationApi = api({
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue(emptyCatalog),
      setLocalCollaborationTrustedScopes: vi.fn().mockRejectedValue(new Error("apply failed"))
    });
    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="desktop-project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Project One / Canvas One" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("apply failed");
    expect(screen.getByText("0 hosted")).toBeVisible();
    expect(
      screen.getByTestId("local-collaboration-scope-status-desktop-project-1-canvas-1")
    ).toHaveTextContent("Pending apply");
    expect(screen.queryByText("Hosted here")).not.toBeInTheDocument();
  });

  it("keeps start and stop off the canvas panel and explains a stopped local Server", async () => {
    const onManageServer = vi.fn();
    const collaborationApi = api();
    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="desktop-project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
        scopesRequireRunning
        onManageServer={onManageServer}
      />
    );

    expect(await screen.findByTestId("local-collaboration-server-status")).toHaveTextContent(
      "Stopped"
    );
    expect(screen.getByTestId("local-collaboration-server-provider")).toHaveTextContent(
      "These canvases are provided by the Server on this computer"
    );
    expect(screen.getByTestId("local-collaboration-scope-readonly")).toBeVisible();
    expect(
      await screen.findByRole("checkbox", { name: "Project One / Canvas One" })
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Start$/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-collaboration-server-start")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-collaboration-server-stop")).not.toBeInTheDocument();
    expect(collaborationApi.startLocalCollaborationServer).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Manage Server" }));
    expect(onManageServer).toHaveBeenCalledOnce();
  });

  it("hides start and stop when this device does not host the Workspace Server", async () => {
    const collaborationApi = api();
    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="desktop-project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
        canControlLocalServer={false}
      />
    );

    expect(await screen.findByTestId("local-collaboration-server-status")).toHaveTextContent(
      "Stopped"
    );
    expect(screen.queryByTestId("local-collaboration-server-start")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-collaboration-server-stop")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start/ })).not.toBeInTheDocument();
  });

  it("shows an automatically activated canvas without a second initialization action", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    });
    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="desktop-project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );
    await waitFor(() =>
      expect(collaborationApi.listLocalCollaborationTrustedScopes).toHaveBeenCalled()
    );
    expect(screen.getByText("Current canvas collaboration is active")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable current canvas" })).not.toBeInTheDocument();
    expect(collaborationApi.registerLocalCollaborationCurrentProject).not.toHaveBeenCalled();
  });

  it("persists the catalog and per-project disclosure state", async () => {
    const collaborationApi = api();
    const onLayoutChange = vi.fn();
    const { rerender } = render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onLayoutChange}
        copyText={copyText}
      />
    );

    expect(
      await screen.findByRole("checkbox", { name: "Project One / Canvas One" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("local-collaboration-server-panel")).not.toHaveClass(
      "rounded-xl",
      "shadow-sm",
      "bg-background"
    );
    expect(screen.getByTestId("local-collaboration-scope-section")).not.toHaveClass("border-t");
    expect(screen.getByTestId("local-collaboration-scope-section")).not.toHaveClass("border-y");
    expect(screen.getByRole("heading", { name: "Canvases hosted on this computer" })).toHaveClass(
      "text-base"
    );
    await userEvent.click(screen.getByRole("button", { name: "Hide local hosting selection" }));
    expect(onLayoutChange).toHaveBeenLastCalledWith({ collapsed: true });

    rerender(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={{ collapsed: true, expandedProjectIds: [] }}
        onScopeLayoutChange={onLayoutChange}
        copyText={copyText}
      />
    );
    expect(screen.queryByTestId("local-collaboration-scope-catalog")).not.toBeInTheDocument();

    rerender(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={{ collapsed: false, expandedProjectIds: [] }}
        onScopeLayoutChange={onLayoutChange}
        copyText={copyText}
      />
    );
    expect(screen.getByRole("button", { name: "Show canvases in Project One" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(
      screen.queryByRole("checkbox", { name: "Project One / Canvas One" })
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show canvases in Project One" }));
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      expandedProjectIds: ["desktop-project-1"]
    });
  });

  it("uses Server connection as the only remote-access control", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    });
    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );

    expect(
      await screen.findByRole("heading", { name: "Canvases hosted on this computer" })
    ).toBeVisible();
    expect(screen.getByText("Invite collaborators")).toBeVisible();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address only" })).not.toBeInTheDocument();
    expect(collaborationApi.setLocalCollaborationLanSharing).not.toHaveBeenCalled();
  });

  it("creates and displays a complete invitation only after an explicit user action", async () => {
    const invitationToken = `pw_inv_${"A".repeat(43)}`;
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:8787/"
      }),
      registerLocalCollaborationCurrentProject: vi.fn().mockImplementation(async (input) => {
        const requestedSelection = (
          input as { selection?: { projectId?: string; canvasId?: string } } | undefined
        )?.selection;
        if (
          requestedSelection?.projectId !== "desktop-project-1" ||
          requestedSelection.canvasId !== "canvas-1"
        ) {
          throw new Error("local_collaboration_selection_required");
        }
        return {
          workspaceId: "workspace-1",
          projectId: "authority-project-1",
          canvasId: "canvas-1",
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:01.000Z"
        };
      }),
      createCollaborationInvitationHandoff: vi
        .fn()
        .mockResolvedValue(invitationHandoff(invitationToken, "invitation-1"))
    });
    const copy = vi.fn(async () => undefined);
    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="desktop-project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copy}
      />
    );

    expect(await screen.findByText("Invite collaborators")).toBeVisible();
    expect(collaborationApi.registerLocalCollaborationCurrentProject).not.toHaveBeenCalled();
    expect(collaborationApi.createCollaborationInvitationHandoff).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Create complete invitation" }));

    const invitationField = await screen.findByRole("textbox", {
      name: "Complete invitation (shown on this page only)"
    });
    expect(copy).not.toHaveBeenCalled();
    expect(collaborationApi.registerLocalCollaborationCurrentProject).toHaveBeenCalledWith({
      selection: { projectId: "desktop-project-1", canvasId: "canvas-1" }
    });
    expect(collaborationApi.createCollaborationInvitationHandoff).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String)
    });

    const invitation = (invitationField as HTMLTextAreaElement).value;
    const parsed = parseCollaborationInvitationHandoff(invitation);
    expect(parsed).toMatchObject({
      serverBaseUrl: "http://192.168.1.20:8787/",
      projectId: "authority-project-1",
      invitationToken,
      allowInsecureTransport: true
    });

    await userEvent.click(screen.getByRole("button", { name: "Copy complete invitation" }));
    expect(copy).toHaveBeenCalledWith(invitation);
    expect(screen.getByText("Complete invitation copied.")).toBeVisible();
  });

  it("creates the invitation for the only hosted canvas when another project is open", async () => {
    const hostedCatalog = {
      projects: [
        {
          projectId: "open-project",
          name: "Open Project",
          selectedCanvasCount: 0,
          canvases: [
            { canvasId: "open-canvas", name: "Open Canvas", selected: false, current: true }
          ]
        },
        {
          projectId: "hosted-project",
          name: "Hosted Project",
          selectedCanvasCount: 1,
          canvases: [
            {
              canvasId: "hosted-canvas",
              name: "Hosted Canvas",
              selected: true,
              current: false
            }
          ]
        }
      ],
      selectedCount: 1
    };
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:8787/"
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue(hostedCatalog),
      registerLocalCollaborationCurrentProject: vi.fn().mockImplementation(async (input) => {
        expect(input).toEqual({
          selection: { projectId: "hosted-project", canvasId: "hosted-canvas" }
        });
        return {
          workspaceId: "workspace-1",
          projectId: "authority-hosted-project",
          canvasId: "hosted-canvas",
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:01.000Z"
        };
      })
    });

    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="open-project"
        canvasId="open-canvas"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Create complete invitation" })
    );
    expect(
      await screen.findByRole("textbox", {
        name: "Complete invitation (shown on this page only)"
      })
    ).toBeVisible();
    expect(collaborationApi.registerLocalCollaborationCurrentProject).toHaveBeenCalledTimes(1);
  });

  it("shows the invitation action before a hosted canvas becomes the active route", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    });

    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="another-project"
        canvasId="another-canvas"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
        serverExposure={{ ...remoteServerExposure, canInvite: false }}
      />
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Create complete invitation" })
    );
    expect(collaborationApi.registerLocalCollaborationCurrentProject).toHaveBeenCalledWith({
      selection: { projectId: "desktop-project-1", canvasId: "canvas-1" }
    });
    expect(collaborationApi.createCollaborationInvitationHandoff).toHaveBeenCalledOnce();
  });

  it("shows localized guidance instead of a raw rate-limit error", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:8787/"
      }),
      createCollaborationInvitationHandoff: vi.fn().mockRejectedValue({
        kind: "rate_limited",
        code: "human_rate_limited",
        message: "Raw Electron rate-limit envelope text",
        retryable: true
      })
    });

    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="desktop-project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Create complete invitation" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many invitations were created recently. Wait a moment, then try again."
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("Raw Electron");
  });

  it("shows actionable localized guidance instead of a raw open-invitation limit code", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:8787/"
      }),
      createCollaborationInvitationHandoff: vi.fn().mockRejectedValue({
        kind: "conflict",
        code: "human_limit_exceeded",
        message: "human_limit_exceeded",
        httpStatus: 409,
        retryable: false
      })
    });

    render(
      <LocalCollaborationServerPanelHarness
        api={collaborationApi}
        t={createTranslator("zh-CN")}
        projectId="desktop-project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建完整邀请" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "开放邀请已达到上限。请在协作空间的邀请列表中撤销不再使用的邀请，然后重试。"
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("human_limit_exceeded");
  });
});

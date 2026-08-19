/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { formatPeoplePanelError, PeopleView } from "../renderer/views/PeopleView";
import { serializeCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

const { useHostAdministrationController } = vi.hoisted(() => ({
  useHostAdministrationController: vi.fn()
}));

vi.mock("../renderer/hooks/useHostAdministrationController", () => ({
  useHostAdministrationController
}));

const idleHostController = {
  activeProfile: null,
  busy: false,
  copyMemberSetupCode: vi.fn().mockResolvedValue(null),
  dismissMemberSetupCodeHandoff: vi.fn(),
  memberSetupCodeHandoff: null
};

const scopeLayout = { collapsed: true, expandedProjectIds: [] };
const onScopeLayoutChange = () => undefined;

function peopleIdentityReads() {
  return {
    listCollaborationMembers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationDevices: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationInvitations: vi.fn().mockResolvedValue({ items: [], nextCursor: null })
  };
}

function invitationHandoff(invitationToken: string, invitationId = "invitation-1") {
  return {
    invitationToken,
    invitation: { invitationId },
    handoff: serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:56584/",
        allowedClientOrigins: ["http://192.168.1.20:56584/"],
        tlsTrust: "not_applicable"
      },
      projectId: "authority-project-1",
      invitationToken
    })
  };
}

beforeEach(() => {
  useHostAdministrationController.mockReturnValue(idleHostController);
});

afterEach(cleanupRendererTestEnvironment);

describe("PeopleView", () => {
  it("localizes structured People rate limits without Electron IPC text", () => {
    const message = formatPeoplePanelError(createTranslator("zh-CN"), {
      kind: "rate_limited",
      code: "human_rate_limited",
      message:
        "Error invoking remote method 'planweave-collaboration:listInvitations': human_rate_limited",
      httpStatus: 429,
      retryAfterMs: 2_000,
      retryable: true
    });

    expect(message).toBe("协作请求过于频繁。请稍候再试。");
    expect(message).not.toContain("Error invoking remote method");
    expect(message).not.toContain("listInvitations");
  });

  it("keeps People network failures visible and adds the raw IPC text in developer mode", () => {
    const t = createTranslator("zh-CN");
    const ipcError = new Error(
      "Error invoking remote method 'planweave-collaboration:listCollaborationDevices': CollaborationClientError: Network request failed."
    );
    const structured = {
      kind: "offline",
      code: "collaboration_offline",
      message: "Network request failed.",
      retryable: true
    };

    expect(formatPeoplePanelError(t, ipcError)).toBe("Network request failed.");
    expect(formatPeoplePanelError(t, structured)).toBe(
      "collaboration_offline: Network request failed."
    );
    expect(formatPeoplePanelError(t, ipcError, true)).toContain(
      "Error invoking remote method 'planweave-collaboration:listCollaborationDevices'"
    );
    expect(formatPeoplePanelError(t, structured, true)).toBe(
      "collaboration_offline: Network request failed."
    );
  });

  it("keeps the connected workspace visible during a transient disconnected status event", async () => {
    let emitStatus: ((status: unknown) => void) | null = null;
    const connectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "https://collaboration.example.test",
          projectId: "project-1",
          allowInsecureTransport: false,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      activeProfileId: "profile-1",
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-1",
          displayName: "Team",
          serverBaseUrl: "http://127.0.0.1:56584/",
          workspaceId: "workspace-1",
          allowInsecureTransport: true
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus),
      onCollaborationStatusChanged: vi.fn((listener: (status: unknown) => void) => {
        emitStatus = listener;
        return () => undefined;
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("people-section-nav")).not.toBeInTheDocument();

    emitStatus?.({
      ...connectedStatus,
      session: { ...connectedStatus.session, phase: "idle" },
      workspaceConnection: { ...connectedStatus.workspaceConnection, status: "disconnected" },
      updatedAt: "2030-01-01T00:00:01.000Z"
    });

    await waitFor(() => expect(screen.getByTestId("people-workspace-section")).toBeVisible());
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("keeps a newer configured status when the initial status request finishes late", async () => {
    let emitStatus: ((status: CollaborationStatus) => void) | null = null;
    let resolveInitialStatus: ((status: CollaborationStatus) => void) | null = null;
    const localOnlyStatus = {
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
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } satisfies CollaborationStatus;
    const configuredStatus = {
      ...localOnlyStatus,
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Local workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      activeProfileId: "profile-1",
      session: { ...localOnlyStatus.session, activeProfileId: "profile-1" },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "disconnected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-1",
          displayName: "Local workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          workspaceId: "workspace-1",
          allowInsecureTransport: true
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Local workspace",
        connectedAt: null,
        error: null
      },
      updatedAt: "2030-01-01T00:00:01.000Z"
    } satisfies CollaborationStatus;
    const api = {
      getCollaborationStatus: vi.fn(
        () =>
          new Promise<CollaborationStatus>((resolve) => {
            resolveInitialStatus = resolve;
          })
      ),
      onCollaborationStatusChanged: vi.fn((listener: (status: CollaborationStatus) => void) => {
        emitStatus = listener;
        return () => undefined;
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );
    await waitFor(() => expect(api.onCollaborationStatusChanged).toHaveBeenCalledOnce());

    act(() => emitStatus?.(configuredStatus));
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();

    await act(async () => resolveInitialStatus?.(localOnlyStatus));
    expect(screen.getByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("separates member administration from Workspace management", async () => {
    const connectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      activeProfileId: "profile-1",
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-1",
          displayName: "Team",
          serverBaseUrl: "http://127.0.0.1:56584/",
          workspaceId: "workspace-1",
          allowInsecureTransport: true
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const getCollaborationStatus = vi.fn().mockResolvedValue(connectedStatus);
    const api = {
      getCollaborationStatus,
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      getDesktopServerExposure: vi.fn().mockResolvedValue({
        mode: "lan_http",
        topology: "lan_http",
        provider: null,
        lifecycle: "ready",
        advertisedOrigin: "http://192.168.1.20:56584/",
        errorCode: null,
        canActivate: true,
        canInvite: true
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: {
          profileId: "planweave-local-server",
          displayName: "Local collaboration server",
          serverBaseUrl: "http://127.0.0.1:56584/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [],
        selectedCount: 0
      }),
      listLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue([]),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.getByTestId("people-section-members")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("host-admin-member-setup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-workspace-management")).not.toBeInTheDocument();
    expect(screen.queryByTestId("content-authority-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-connection")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("people-section-workspace"));
    expect(await screen.findByTestId("people-workspace-management")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Workspace management" })).not.toBeInTheDocument();
    expect(screen.getByTestId("people-workspace-hosting-section")).not.toHaveClass("border-t");
    expect(screen.getByTestId("people-workspace-connection-status")).toHaveAttribute(
      "data-status",
      "connected"
    );
    expect(screen.getByTestId("people-workspace-connection-status")).not.toHaveClass("border-y");
    expect(screen.getByText("http://127.0.0.1:56584/")).toBeVisible();
    expect(screen.getByTestId("people-workspace-change-connection")).toBeVisible();
    expect(screen.queryByTestId("people-workspace-disconnect")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-active-profile")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-submit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-invite-trust-note")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("people-workspace-change-connection"));
    expect(screen.getByTestId("people-connect-invitation-details")).toBeVisible();
    expect(screen.getByTestId("people-connect-submit")).toBeVisible();
    expect(screen.getByTestId("people-workspace-change-connection")).toHaveTextContent("Cancel");
    expect(screen.queryByTestId("people-connect-mode-setup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-mode-connect")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-mode-bootstrap")).not.toBeInTheDocument();
    expect(screen.getByTestId("local-collaboration-server-panel")).toBeVisible();
    expect(screen.getByTestId("content-authority-panel")).toBeVisible();
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("current-canvas-access-panel")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create complete invitation" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Invite collaborators")).not.toBeInTheDocument();
    expect(getCollaborationStatus).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("puts member computer invite on the Members tab, not Workspace management", async () => {
    useHostAdministrationController.mockReturnValue({
      ...idleHostController,
      activeProfile: {
        profileId: "profile-a",
        displayName: "Production admin",
        serverBaseUrl: "http://127.0.0.1:56584/",
        allowInsecureTransport: true,
        hostedByThisDesktop: true,
        endpoint: {
          topology: "lan_http" as const,
          serverOrigin: "http://127.0.0.1:56584",
          allowedClientOrigins: ["http://127.0.0.1:56584"],
          tlsTrust: "not_applicable" as const
        },
        operatorId: "operator-a",
        hasOperatorCredential: true,
        operatorCredentialPersistence: "persisted" as const,
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    });
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue({
        profiles: [
          {
            profileId: "profile-1",
            displayName: "Team workspace",
            serverBaseUrl: "http://127.0.0.1:56584/",
            projectId: "project-1",
            allowInsecureTransport: true,
            hasDeviceCredential: true,
            deviceCredentialPersistence: "persisted",
            deviceCredentialId: "device-1",
            humanPrincipalId: "human-1",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        activeProfileId: "profile-1",
        credentialStorage: "available",
        nonPersistenceWarning: null,
        session: {
          phase: "connected",
          activeProfileId: "profile-1",
          detail: null,
          lastErrorCode: null,
          lastErrorMessage: null
        },
        workspaceConnection: {
          schemaVersion: "workspace-setup/v1",
          status: "connected",
          profile: {
            schemaVersion: "workspace-identity/v1",
            profileId: "profile-1",
            displayName: "Team workspace",
            serverBaseUrl: "http://127.0.0.1:56584/",
            workspaceId: "workspace-1",
            allowInsecureTransport: true
          },
          workspaceId: "workspace-1",
          workspaceDisplayName: "Team",
          connectedAt: "2030-01-01T00:00:00.000Z",
          error: null
        },
        workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("host-admin-member-setup")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Invite another computer" })).toBeVisible();
    await userEvent.click(screen.getByTestId("people-section-workspace"));
    expect(screen.queryByTestId("host-admin-member-setup")).not.toBeInTheDocument();
  });

  it("keeps invitation creation out of Workspace management after a persisted restart", async () => {
    const user = userEvent.setup();
    const invitationToken = `pw_inv_${"P".repeat(43)}`;
    const restoredStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      activeProfileId: "profile-1",
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "idle",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "disconnected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          workspaceId: "workspace-1",
          allowInsecureTransport: true
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team workspace",
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const createInvitation = vi.fn().mockResolvedValue(invitationHandoff(invitationToken));
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue(restoredStatus),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      getDesktopServerExposure: vi.fn().mockResolvedValue({
        mode: "lan_http",
        topology: "lan_http",
        provider: null,
        lifecycle: "ready",
        advertisedOrigin: "http://192.168.1.20:56584/",
        errorCode: null,
        canActivate: true,
        canInvite: true
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: {
          profileId: "planweave-local-server",
          displayName: "Local collaboration server",
          serverBaseUrl: "http://127.0.0.1:56584/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:56584/"
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [
          {
            projectId: "project-1",
            name: "Project One",
            selectedCanvasCount: 1,
            canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: true, current: true }]
          }
        ],
        selectedCount: 1
      }),
      listLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue([]),
      registerLocalCollaborationCurrentProject: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        projectId: "authority-project-1",
        canvasId: "canvas-1",
        profileId: "profile-1",
        registeredAt: "2030-01-01T00:00:01.000Z"
      }),
      createCollaborationInvitationHandoff: createInvitation,
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    await user.click(screen.getByTestId("people-section-workspace"));
    expect(await screen.findByTestId("people-workspace-management")).toBeVisible();
    expect(screen.queryByText("Invite collaborators")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create complete invitation" })
    ).not.toBeInTheDocument();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("does not expose invitation management from Workspace management", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      activeProfileId: "profile-1",
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      getDesktopServerExposure: vi.fn().mockResolvedValue({
        mode: "lan_http",
        topology: "lan_http",
        provider: null,
        lifecycle: "ready",
        advertisedOrigin: "http://192.168.1.20:56584/",
        errorCode: null,
        canActivate: true,
        canInvite: true
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: {
          profileId: "planweave-local-server",
          displayName: "Local collaboration server",
          serverBaseUrl: "http://127.0.0.1:56584/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:56584/"
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [
          {
            projectId: "project-1",
            name: "Project One",
            selectedCanvasCount: 1,
            canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: true, current: true }]
          }
        ],
        selectedCount: 1
      }),
      listLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue([]),
      registerLocalCollaborationCurrentProject: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: "profile-1",
        registeredAt: "2030-01-01T00:00:01.000Z"
      }),
      createCollaborationInvitationHandoff: vi.fn().mockRejectedValue({
        kind: "conflict",
        code: "human_limit_exceeded",
        message: "human_limit_exceeded",
        httpStatus: 409,
        retryable: false
      }),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("zh-CN")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    await user.click(screen.getByTestId("people-section-workspace"));
    expect(await screen.findByTestId("people-workspace-management")).toBeVisible();
    expect(screen.queryByRole("button", { name: "新建完整邀请" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理开放邀请" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
  });

  it("does not flash first-time onboarding while persisted collaboration status is loading", () => {
    const api = {
      getCollaborationStatus: vi.fn(() => new Promise(() => undefined)),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn(() => new Promise(() => undefined))
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Working");
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("shows a progressive create-or-join entry before a workspace is connected", () => {
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.getByTestId("people-view")).toHaveAccessibleName("Project members");
    expect(screen.getByTestId("people-view")).not.toHaveClass("border");
    expect(screen.getByTestId("people-view")).toHaveClass("[scrollbar-gutter:stable]");
    expect(screen.queryByRole("heading", { name: "Project people" })).not.toBeInTheDocument();
    expect(screen.getByTestId("collaboration-workspace-onboarding")).toBeInTheDocument();
    expect(screen.getByTestId("collaboration-onboarding-create")).toHaveTextContent(
      "Create a collaboration workspace"
    );
    expect(screen.getByTestId("collaboration-onboarding-join")).toHaveTextContent(
      "Join a collaboration workspace"
    );
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-section-hosting")).not.toBeInTheDocument();
  });

  it("reveals only the selected create or join flow", async () => {
    const user = userEvent.setup();
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    await user.click(screen.getByTestId("collaboration-onboarding-create"));
    expect(screen.getByTestId("collaboration-onboarding-host-locally")).toBeVisible();
    expect(screen.getByTestId("collaboration-onboarding-existing-server")).toBeVisible();
    expect(screen.queryByTestId("people-connect-form")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("collaboration-onboarding-existing-server"));
    expect(screen.getByTestId("people-connect-form")).toBeVisible();
    expect(screen.getByTestId("people-connect-setup-details")).toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-mode-join")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByTestId("collaboration-onboarding-join"));
    expect(screen.getByTestId("people-connect-invitation-details")).toBeVisible();
    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-project-id")).not.toBeInTheDocument();
  });

  it("leaves local hosting onboarding after workspace connection succeeds", async () => {
    const user = userEvent.setup();
    const localOnlyStatus = {
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
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const connectedStatus = {
      ...localOnlyStatus,
      profiles: [
        {
          profileId: "planweave-local-project-1",
          displayName: "Project One",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted" as const,
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      activeProfileId: "planweave-local-project-1",
      session: {
        phase: "connected" as const,
        activeProfileId: "planweave-local-project-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        ...localOnlyStatus.workspaceConnection,
        status: "connected" as const,
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Local workspace",
        connectedAt: "2030-01-01T00:00:01.000Z"
      },
      updatedAt: "2030-01-01T00:00:01.000Z"
    };
    const getCollaborationStatus = vi
      .fn()
      .mockResolvedValueOnce(localOnlyStatus)
      .mockResolvedValue(connectedStatus);
    const api = {
      getCollaborationStatus,
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: {
          profileId: "planweave-local-server",
          displayName: "Local collaboration server",
          serverBaseUrl: "http://127.0.0.1:56584/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:56584/"
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [
          {
            projectId: "project-1",
            name: "Project One",
            selectedCanvasCount: 1,
            canvases: [
              {
                canvasId: "canvas-1",
                name: "Canvas One",
                selected: true,
                current: true
              }
            ]
          }
        ],
        selectedCount: 1
      }),
      listLocalCollaborationTrustedScopes: vi
        .fn()
        .mockResolvedValue([
          { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" }
        ]),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    await user.click(await screen.findByTestId("collaboration-onboarding-create"));
    await user.click(screen.getByTestId("collaboration-onboarding-host-locally"));

    await waitFor(() => expect(getCollaborationStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-collaboration-server-panel")).not.toBeInTheDocument();
  });

  it("hides remote content authority while the project is local only", () => {
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.queryByTestId("content-authority-panel")).not.toBeInTheDocument();
  });

  it("keeps a stored credential workspace visible while it is disconnected", async () => {
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue({
        profiles: [
          {
            profileId: "profile-1",
            displayName: "Team workspace",
            serverBaseUrl: "https://collaboration.example.test",
            projectId: "project-1",
            allowInsecureTransport: false,
            hasDeviceCredential: true,
            deviceCredentialPersistence: "persisted",
            deviceCredentialId: "device-1",
            humanPrincipalId: "human-1",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        activeProfileId: "profile-1",
        credentialStorage: "available",
        nonPersistenceWarning: null,
        session: {
          phase: "idle",
          activeProfileId: "profile-1",
          detail: null,
          lastErrorCode: null,
          lastErrorMessage: null
        },
        workspaceConnection: {
          schemaVersion: "workspace-setup/v1",
          status: "disconnected",
          profile: {
            schemaVersion: "workspace-identity/v1",
            profileId: "profile-1",
            displayName: "Team workspace",
            serverBaseUrl: "https://collaboration.example.test",
            workspaceId: "workspace-1",
            allowInsecureTransport: false
          },
          workspaceId: "workspace-1",
          workspaceDisplayName: "Team workspace",
          connectedAt: null,
          error: null
        },
        workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.getByTestId("people-panel")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("keeps a persisted workspace visible when no sidebar project profile is active", async () => {
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue({
        profiles: [
          {
            profileId: "profile-persisted",
            displayName: "Persisted workspace",
            serverBaseUrl: "https://collaboration.example.test/",
            projectId: "workspace-project",
            allowInsecureTransport: false,
            hasDeviceCredential: true,
            deviceCredentialPersistence: "persisted",
            deviceCredentialId: "device-1",
            humanPrincipalId: "human-1",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
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
          status: "disconnected",
          profile: {
            schemaVersion: "workspace-identity/v1",
            profileId: "profile-persisted",
            displayName: "Persisted workspace",
            serverBaseUrl: "https://collaboration.example.test/",
            workspaceId: "workspace-persisted",
            allowInsecureTransport: false
          },
          workspaceId: "workspace-persisted",
          workspaceDisplayName: "Persisted workspace",
          connectedAt: null,
          error: null
        },
        workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("reconnects a stored project session when refresh is clicked while disconnected", async () => {
    const user = userEvent.setup();
    const disconnectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://192.168.123.23:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      activeProfileId: "profile-1",
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "error",
        activeProfileId: "profile-1",
        detail: "connect_preflight_failed",
        lastErrorCode: "collaboration_offline",
        lastErrorMessage: "Network request failed."
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "disconnected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://192.168.123.23:56584/",
          workspaceId: "workspace-1",
          allowInsecureTransport: true
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team workspace",
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } satisfies CollaborationStatus;
    const connectedStatus = {
      ...disconnectedStatus,
      session: {
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      updatedAt: "2030-01-01T00:00:01.000Z"
    } satisfies CollaborationStatus;
    const connectCollaborationSession = vi.fn().mockResolvedValue(connectedStatus);
    const getCollaborationStatus = vi
      .fn()
      .mockResolvedValueOnce(disconnectedStatus)
      .mockResolvedValue(connectedStatus);
    const api = {
      getCollaborationStatus,
      connectCollaborationSession,
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    await user.click(await screen.findByTestId("people-refresh-details"));

    await waitFor(() =>
      expect(connectCollaborationSession).toHaveBeenCalledWith({ profileId: "profile-1" })
    );
    expect(getCollaborationStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps onboarding visible when a failed join left only an uncredentialed profile", async () => {
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue({
        profiles: [
          {
            profileId: "profile-failed-join",
            displayName: "Failed join",
            serverBaseUrl: "https://collaboration.example.test",
            projectId: "project-1",
            allowInsecureTransport: false,
            hasDeviceCredential: false,
            deviceCredentialPersistence: "missing",
            deviceCredentialId: null,
            humanPrincipalId: null,
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
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
          status: "local_only",
          profile: null,
          workspaceId: null,
          workspaceDisplayName: null,
          connectedAt: null,
          error: null
        },
        workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("collaboration-workspace-onboarding")).toBeVisible();
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
  });
});

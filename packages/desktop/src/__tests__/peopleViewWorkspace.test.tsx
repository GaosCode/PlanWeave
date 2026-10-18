import { collaborationOperationScopeFixture } from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { PeopleView } from "../renderer/views/PeopleView";
import { serializeCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

const { useOperatorControlStatusSnapshot } = vi.hoisted(() => ({
  useOperatorControlStatusSnapshot: vi.fn()
}));

vi.mock("../renderer/hooks/useOperatorControlStatusSnapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../renderer/hooks/useOperatorControlStatusSnapshot")>()),
  useOperatorControlStatusSnapshot
}));
vi.mock("../renderer/hooks/useMemberSetupCode", () => ({
  useMemberSetupCode: (_snapshot: unknown, target: unknown) => ({
    busy: false,
    identity: JSON.stringify(target),
    copy: async () => Boolean(await idleHostController.copyMemberSetupCode(target))
  })
}));

const idleHostController = {
  activeProfile: null,
  busy: false,
  copyMemberSetupCode: vi.fn().mockResolvedValue(null),
  dismissMemberSetupCodeHandoff: vi.fn(),
  memberSetupCodeHandoff: null
};

import { peopleIdentityReads } from "./helpers/peopleViewFixtures";

const scopeLayout = { collapsed: true, expandedProjectIds: [] };
const onScopeLayoutChange = () => undefined;

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
  useOperatorControlStatusSnapshot.mockReset();
  useOperatorControlStatusSnapshot.mockReturnValue(idleHostController);
});

afterEach(cleanupRendererTestEnvironment);

describe("PeopleView workspace", () => {
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
        operationScope: {
          ...collaborationOperationScopeFixture(),
          serverBaseUrl: "http://127.0.0.1:56584/"
        },
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
    expect(screen.getByTestId("people-section-workspace")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("workspace-canvas-directory")).toBeVisible();
    expect(screen.getByTestId("people-current-workspace-switch")).toHaveTextContent("Team");
    expect(screen.queryByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-member-setup")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Share canvas", exact: true }));
    expect(await screen.findByTestId("workspace-canvas-sharing")).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Share canvas");
    await userEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    await userEvent.click(screen.getByTestId("people-section-members"));
    expect(await screen.findByTestId("people-panel")).toBeVisible();
    expect(screen.queryByTestId("workspace-canvas-directory")).not.toBeInTheDocument();
    expect(screen.queryByTestId("canvas-access-panel")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Canvas permissions", exact: true })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("people-current-workspace-switch"));
    expect(screen.getByTestId("workspace-switcher")).toBeVisible();
    expect(screen.queryByTestId("people-connect-invitation-details")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Join another workspace…" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Join another workspace…");
    expect(screen.getByTestId("people-connect-invitation-details")).toBeVisible();
    expect(screen.queryByTestId("local-collaboration-server-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("puts member computer invite on the Members tab, not Workspace management", async () => {
    useOperatorControlStatusSnapshot.mockReturnValue({
      ...idleHostController,
      status: {
        profiles: [
          {
            profileId: "profile-a",
            serverBaseUrl: "http://127.0.0.1:56584/",
            hasOperatorCredential: true
          }
        ]
      },
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
          operationScope: {
            ...collaborationOperationScopeFixture(),
            serverBaseUrl: "http://127.0.0.1:56584/"
          },
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

    await userEvent.click(await screen.findByTestId("people-section-members"));
    expect(screen.queryByTestId("host-admin-member-setup")).not.toBeInTheDocument();
    idleHostController.copyMemberSetupCode.mockResolvedValueOnce({ workspaceId: "workspace-1" });
    await userEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(await screen.findByText("Copied · send it to the other person to join")).toBeVisible();
    expect(screen.getByTestId("people-section-members")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("workspace-information")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
        operationScope: null,
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
    expect(
      screen.getByText("Workspace is disconnected. Reconnect to view shared canvases.")
    ).toBeVisible();
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
        operationScope: {
          ...collaborationOperationScopeFixture(),
          serverBaseUrl: "http://127.0.0.1:56584/"
        },
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
    expect(await screen.findByTestId("workspace-canvas-directory")).toBeVisible();
    expect(screen.queryByRole("button", { name: "新建完整邀请" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理开放邀请" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
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
          operationScope: null,
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
    await userEvent.click(screen.getByTestId("people-section-members"));
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
          operationScope: null,
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
        operationScope: null,
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
        operationScope: {
          ...collaborationOperationScopeFixture(),
          serverBaseUrl: "http://192.168.123.23:56584/"
        },
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

    await user.click(await screen.findByTestId("people-section-members"));
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
          operationScope: null,
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

  it("shows this device's profile after joining a Workspace with no shared project", async () => {
    const identity = peopleIdentityReads();
    const status = {
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
      activeProfileId: null,
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        operationScope: null,
        phase: "idle",
        activeProfileId: null,
        detail: "workspace_no_shared_projects",
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
      getCollaborationStatus: vi.fn().mockResolvedValue(status),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      ...identity
    } as unknown as PlanWeaveCollaborationApi;

    useOperatorControlStatusSnapshot.mockReturnValue({
      ...idleHostController,
      activeProfile: {
        profileId: "sidebar-operator",
        hasOperatorCredential: true,
        serverBaseUrl: "https://another-server.example/"
      },
      status: {
        profiles: [
          {
            profileId: "workspace-operator",
            hasOperatorCredential: true,
            serverBaseUrl: "http://127.0.0.1:56584/"
          },
          {
            profileId: "sidebar-operator",
            hasOperatorCredential: true,
            serverBaseUrl: "https://another-server.example/"
          }
        ]
      }
    });
    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("people-current-workspace-switch")).toHaveTextContent("Team");
    await userEvent.click(screen.getByTestId("people-section-members"));
    await userEvent.click(await screen.findByRole("button", { name: "More actions: Ada Member" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Your profile" }));
    expect(await screen.findByTestId("people-profile-card")).toHaveTextContent("Ada Member");
    expect(screen.getByTestId("people-profile-device")).toHaveTextContent("This device");
    expect(screen.getByTestId("people-presence-summary")).toHaveTextContent("1 member");
    expect(screen.getByTestId("people-member-row")).toHaveTextContent("Ada Member");
    expect(identity.getWorkspaceConnectionSelf).toHaveBeenCalled();
    expect(identity.listWorkspaceConnectionMembers).toHaveBeenCalled();
    expect(identity.listCollaborationMembers).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    await userEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(screen.queryByTestId("workspace-information")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(idleHostController.copyMemberSetupCode).toHaveBeenLastCalledWith({
      profileId: "workspace-operator",
      workspaceId: "workspace-1",
      serverBaseUrl: "http://127.0.0.1:56584/"
    });

    await userEvent.click(screen.getByTestId("people-section-members"));
    identity.getWorkspaceConnectionSelf.mockResolvedValue({
      schemaVersion: "workspace-setup/v1",
      workspaceId: "workspace-2",
      membershipId: "membership-2",
      humanPrincipalId: "human-2",
      displayName: "Second Workspace Member",
      role: "member",
      deviceSessionId: "device-session-2"
    });
    identity.listWorkspaceConnectionMembers.mockResolvedValue({
      schemaVersion: "workspace-setup/v1",
      items: [],
      nextCursor: null
    });
    const changed = vi.mocked(api.onCollaborationStatusChanged).mock.calls[0]?.[0];
    if (!changed) throw new Error("status_listener_missing");
    act(() =>
      changed({
        ...status,
        workspaceConnection: {
          ...status.workspaceConnection,
          workspaceId: "workspace-2",
          workspaceDisplayName: "Second Workspace",
          profile: { ...status.workspaceConnection.profile, workspaceId: "workspace-2" }
        }
      })
    );
    expect(screen.queryByText("Ada Member")).not.toBeInTheDocument();
    expect(await screen.findByTestId("people-profile-card")).toHaveTextContent(
      "Second Workspace Member"
    );
    expect(screen.queryByTestId("people-member-row")).not.toBeInTheDocument();
  });
});

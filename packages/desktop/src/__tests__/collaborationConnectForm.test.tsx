/* @vitest-environment jsdom */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "@testing-library/jest-dom/vitest";
import {
  accessCapabilityFlags,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { serializeCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { buildCollaborationDiagnosticReport } from "../renderer/team/collaborationDiagnostics";
import { serializeCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore";
import { CollaborationService } from "../main/collaboration/collaborationService";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function joinApi() {
  return {
    upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
    consumeCollaborationInvitation: vi.fn().mockResolvedValue({
      deviceCredentialPersistence: "persisted",
      nonPersistenceWarning: null
    }),
    connectCollaborationSession: vi.fn().mockResolvedValue(undefined)
  } as unknown as PlanWeaveCollaborationApi;
}

function setupApi() {
  return {
    redeemCollaborationSetupCode: vi.fn().mockResolvedValue(undefined)
  } as unknown as PlanWeaveCollaborationApi;
}

describe("CollaborationConnectForm Server setup onboarding", () => {
  it("redeems one complete setup handoff without exposing manual fields", async () => {
    const user = userEvent.setup();
    const api = setupApi();
    const handoff = serializeCollaborationSetupHandoffV1({
      serverBaseUrl: "http://192.168.1.20:56584/",
      setupCode: `pw_setup_${"A".repeat(43)}`,
      allowInsecureTransport: true
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-setup-code")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("people-connect-setup-details"), {
      target: { value: handoff }
    });
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() =>
      expect(api.redeemCollaborationSetupCode).toHaveBeenCalledWith({
        serverBaseUrl: "http://192.168.1.20:56584/",
        setupCode: `pw_setup_${"A".repeat(43)}`,
        allowInsecureTransport: true,
        displayName: "Collaboration"
      })
    );
    expect(screen.getByTestId("people-connect-setup-details")).toHaveValue("");
  });

  it("keeps the previous fields behind an explicit manual disclosure", async () => {
    const user = userEvent.setup();

    render(
      <CollaborationConnectForm
        api={setupApi()}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.click(screen.getByTestId("people-connect-setup-manual-toggle"));

    expect(screen.getByTestId("people-connect-display-name")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-server-url")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-setup-code")).toBeInTheDocument();
  });

  it("rejects malformed complete setup details before invoking the bridge", async () => {
    const user = userEvent.setup();
    const api = setupApi();

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.type(screen.getByTestId("people-connect-setup-details"), "not setup details");
    await user.click(screen.getByTestId("people-connect-submit"));

    expect(await screen.findByTestId("people-connect-error")).toHaveTextContent(
      "These Server connection details are incomplete or invalid"
    );
    expect(api.redeemCollaborationSetupCode).not.toHaveBeenCalled();
  });
});

describe("CollaborationConnectForm invitation onboarding", () => {
  it("joins a Tailscale invitation without asking for the Server Origin", async () => {
    const user = userEvent.setup();
    const api = joinApi();
    const invitationToken = `pw_inv_${"A".repeat(43)}`;
    const handoff = serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://planweave.example.ts.net",
        allowedClientOrigins: ["https://planweave.example.ts.net"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    expect(screen.getByLabelText("Your name or nickname")).toBeInTheDocument();

    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("people-connect-invitation-details"), {
      target: { value: handoff }
    });
    await user.type(screen.getByTestId("people-connect-display-name"), "Windows member");
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() =>
      expect(api.upsertCollaborationProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "Windows member",
          serverBaseUrl: "https://planweave.example.ts.net",
          projectId: "project-1",
          allowInsecureTransport: false,
          endpoint: expect.objectContaining({ topology: "private_https" })
        })
      )
    );
    expect(api.consumeCollaborationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { invitationToken, displayName: "Windows member" }
      })
    );
    expect(api.connectCollaborationSession).toHaveBeenCalledTimes(1);
  });

  it("shows a private-network reachability recovery without exposing transport details", async () => {
    const user = userEvent.setup();
    const api = joinApi();
    vi.mocked(api.consumeCollaborationInvitation).mockRejectedValue({
      kind: "offline",
      code: "PRIVATE_NETWORK_UNREACHABLE",
      message: "The Server could not be reached through the configured tailnet endpoint.",
      retryable: true
    });
    const handoff = serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://planweave.example.ts.net",
        allowedClientOrigins: ["https://planweave.example.ts.net"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken: `pw_inv_${"C".repeat(43)}`
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
      />
    );
    fireEvent.change(screen.getByTestId("people-connect-invitation-details"), {
      target: { value: handoff }
    });
    await user.click(screen.getByTestId("people-connect-submit"));

    const error = await screen.findByTestId("people-connect-error");
    expect(error).toHaveTextContent(
      "Could not reach the shared Server through the private network"
    );
    expect(error).not.toHaveTextContent("permission for this Workspace");
    expect(error).not.toHaveTextContent("planweave.example.ts.net");
  });

  it("shows reached-Server Workspace denial separately from private-network reachability", async () => {
    const user = userEvent.setup();
    const api = joinApi();
    vi.mocked(api.consumeCollaborationInvitation).mockRejectedValue({
      kind: "forbidden",
      code: "WORKSPACE_FORBIDDEN",
      message: "The Server is reachable, but this identity cannot access the Workspace.",
      httpStatus: 403,
      retryable: false
    });
    const handoff = serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://planweave.example.ts.net",
        allowedClientOrigins: ["https://planweave.example.ts.net"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken: `pw_inv_${"D".repeat(43)}`
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
      />
    );
    fireEvent.change(screen.getByTestId("people-connect-invitation-details"), {
      target: { value: handoff }
    });
    await user.click(screen.getByTestId("people-connect-submit"));

    const error = await screen.findByTestId("people-connect-error");
    expect(error).toHaveTextContent("The Server is reachable");
    expect(error).toHaveTextContent("permission for this Workspace");
    expect(error).not.toHaveTextContent("through Tailscale");
  });

  it("creates a separate member profile and waits for the connected workspace refresh", async () => {
    const user = userEvent.setup();
    const api = joinApi();
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const invitationToken = `pw_inv_${"B".repeat(43)}`;
    const handoff = serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:56584",
        allowedClientOrigins: ["http://192.168.1.20:56584"],
        tlsTrust: "not_applicable"
      },
      projectId: "shared-project",
      invitationToken
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          activeProfileId: "existing-project-profile",
          profiles: [
            {
              profileId: "existing-project-profile",
              displayName: "Existing project",
              serverBaseUrl: "https://server.example",
              projectId: "existing-project",
              allowInsecureTransport: false,
              hasDeviceCredential: true,
              deviceCredentialPersistence: "persisted",
              deviceCredentialId: "device-existing",
              humanPrincipalId: "human-existing",
              updatedAt: "2030-01-01T00:00:00.000Z"
            }
          ],
          session: {
            phase: "connected",
            activeProfileId: "existing-project-profile",
            detail: "observer:connected",
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
          workspacePicker: {
            schemaVersion: "workspace-setup/v1",
            items: [],
            nextCursor: null
          },
          credentialStorage: "available",
          nonPersistenceWarning: null,
          updatedAt: "2030-01-01T00:00:00.000Z"
        }}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
        onConnected={onConnected}
      />
    );

    fireEvent.change(screen.getByTestId("people-connect-invitation-details"), {
      target: { value: handoff }
    });
    await user.type(screen.getByTestId("people-connect-display-name"), "Windows member");
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    const profileInput = vi.mocked(api.upsertCollaborationProfile).mock.calls[0]?.[0];
    expect(profileInput?.profileId).toBeTruthy();
    expect(profileInput?.profileId).not.toBe("existing-project-profile");
    expect(api.consumeCollaborationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: profileInput?.profileId })
    );
    expect(api.connectCollaborationSession).toHaveBeenCalledWith({
      profileId: profileInput?.profileId
    });
    expect(api.connectCollaborationSession.mock.invocationCallOrder[0]).toBeLessThan(
      onConnected.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("keeps malformed invitation details out of the profile bridge", async () => {
    const user = userEvent.setup();
    const api = joinApi();

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.type(screen.getByTestId("people-connect-invitation-details"), "not an invite");
    await user.click(screen.getByTestId("people-connect-submit"));

    expect(await screen.findByTestId("people-connect-error")).toHaveTextContent(
      "This invitation is incomplete or invalid"
    );
    expect(api.upsertCollaborationProfile).not.toHaveBeenCalled();
  });
});

describe("CollaborationConnectForm connection diagnostics", () => {
  const diagnosticStatus: CollaborationStatus = {
    activeProfileId: "profile-windows",
    profiles: [
      {
        profileId: "profile-windows",
        displayName: "Windows member",
        serverBaseUrl: "http://192.168.123.23:62060/",
        projectId: "project-1",
        allowInsecureTransport: true,
        endpoint: {
          topology: "lan_http",
          serverOrigin: "http://192.168.123.23:62060/",
          allowedClientOrigins: ["http://192.168.123.23:62060/"],
          tlsTrust: "not_applicable"
        },
        connectionState: "ready",
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connecting",
      activeProfileId: "profile-windows",
      detail: "observer:reconnecting:attempt=3:delay_ms=2000",
      lastErrorCode: null,
      lastErrorMessage: `Bearer pw_hdev_${"S".repeat(43)}`
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
    workspacePicker: {
      schemaVersion: "workspace-setup/v1",
      items: [],
      nextCursor: null
    },
    updatedAt: "2030-01-01T00:00:03.000Z"
  };

  function statusWithWorkspaceIdentity(
    status: CollaborationStatus["workspaceConnection"]["status"],
    error: CollaborationStatus["workspaceConnection"]["error"] = null
  ): CollaborationStatus {
    return {
      ...diagnosticStatus,
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status,
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-windows",
          displayName: "Apollo Studio",
          serverBaseUrl: "https://owner-device.example.ts.net/",
          workspaceId: "workspace-1",
          allowInsecureTransport: false
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Apollo Studio",
        connectedAt:
          status === "connected" || status === "reconnecting" ? "2030-01-01T00:00:00.000Z" : null,
        error
      }
    };
  }

  it.each([
    ["connected", "Connected"],
    ["disconnected", "Configured · waiting to connect"],
    ["connecting", "Checking connection…"],
    ["reconnecting", "Checking connection again…"]
  ] as const)("presents the %s Workspace connection state", (connectionStatus, expectedLabel) => {
    render(
      <CollaborationConnectForm
        api={joinApi()}
        status={statusWithWorkspaceIdentity(connectionStatus)}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    expect(screen.getByTestId("people-workspace-current-name")).toHaveTextContent("Apollo Studio");
    expect(screen.getByTestId("people-workspace-identity-status")).toHaveTextContent(expectedLabel);
    expect(screen.queryByText("Workspace disconnected")).not.toBeInTheDocument();
  });

  it("allows a configured Workspace identity to be verified explicitly", async () => {
    const user = userEvent.setup();
    const retryWorkspaceConnection = vi.fn().mockResolvedValue(undefined);

    render(
      <CollaborationConnectForm
        api={{ retryWorkspaceConnection } as unknown as PlanWeaveCollaborationApi}
        status={statusWithWorkspaceIdentity("disconnected")}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    await user.click(screen.getByTestId("people-workspace-retry"));
    expect(retryWorkspaceConnection).toHaveBeenCalledOnce();
  });

  it("does not offer identity verification when the configured Workspace credential is missing", () => {
    const status = statusWithWorkspaceIdentity("disconnected");
    status.profiles = status.profiles.map((profile) => ({
      ...profile,
      hasDeviceCredential: false,
      deviceCredentialPersistence: "missing",
      deviceCredentialId: null,
      humanPrincipalId: null
    }));

    render(
      <CollaborationConnectForm
        api={joinApi()}
        status={status}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    expect(screen.queryByTestId("people-workspace-retry")).not.toBeInTheDocument();
    expect(screen.getByTestId("people-workspace-credential-missing")).toHaveTextContent(
      "No device credential stored for this profile"
    );
  });

  it("restores a missing local-owner credential through local activation", async () => {
    const user = userEvent.setup();
    const status = statusWithWorkspaceIdentity("disconnected");
    status.activeProfileId = "planweave-local-project-1";
    status.profiles = status.profiles.map((profile) => ({
      ...profile,
      profileId: "planweave-local-project-1",
      hasDeviceCredential: false,
      deviceCredentialPersistence: "missing",
      deviceCredentialId: null,
      humanPrincipalId: null
    }));
    if (status.workspaceConnection.profile) {
      status.workspaceConnection.profile.profileId = "planweave-local-project-1";
    }
    const registerLocalCollaborationCurrentProject = vi.fn().mockResolvedValue(undefined);
    const retryWorkspaceConnection = vi.fn().mockResolvedValue(undefined);

    render(
      <CollaborationConnectForm
        api={
          {
            registerLocalCollaborationCurrentProject,
            retryWorkspaceConnection
          } as unknown as PlanWeaveCollaborationApi
        }
        status={status}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    await user.click(screen.getByTestId("people-workspace-restore-local-owner"));
    expect(registerLocalCollaborationCurrentProject).toHaveBeenCalledWith({
      profileId: "planweave-local-project-1"
    });
    expect(retryWorkspaceConnection).not.toHaveBeenCalled();
  });

  it("shows Workspace connection failures without calling them disconnects", () => {
    render(
      <CollaborationConnectForm
        api={joinApi()}
        status={statusWithWorkspaceIdentity("error", {
          code: "WORKSPACE_UNAUTHORIZED",
          message: "The device credential was rejected.",
          retryable: false
        })}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    expect(screen.getByTestId("people-workspace-identity-status")).toHaveTextContent(
      "Workspace connection failed"
    );
    expect(screen.getByTestId("people-workspace-connection-error")).toHaveTextContent(
      "The device credential was rejected."
    );
    expect(screen.queryByText("Workspace disconnected")).not.toBeInTheDocument();
  });

  it.each([
    {
      topology: "private_https" as const,
      serverOrigin: "https://planweave.example.ts.net/",
      tlsTrust: "system_ca" as const
    },
    {
      topology: "public_https" as const,
      serverOrigin: "https://collab.example.com/",
      tlsTrust: "system_ca" as const
    },
    {
      topology: "private_https" as const,
      serverOrigin: "https://192.168.1.20:7443/",
      tlsTrust: "system_ca" as const
    },
    {
      topology: "loopback_https" as const,
      serverOrigin: "https://127.0.0.1:7443/",
      tlsTrust: "system_ca" as const
    }
  ])("connects an existing $topology profile through the strict Main service", async (endpoint) => {
    const root = await mkdtemp(join(tmpdir(), "planweave-connect-endpoint-"));
    const profileStore = new CollaborationProfileStore({
      profilesPath: join(root, "profiles.json")
    });
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    };
    const service = new CollaborationService({
      profileStore,
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage,
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: vi.fn((handlers) =>
            handlers.onStatus?.({ state: "connected", cursor: 0 })
          ),
          stopObserver: vi.fn(),
          stopPresence: vi.fn(),
          dispose: vi.fn()
        }) as never
    });
    const profile = {
      profileId: `profile-${endpoint.topology}`,
      displayName: endpoint.topology,
      serverBaseUrl: endpoint.serverOrigin,
      projectId: "project-1",
      allowInsecureTransport: false,
      endpoint: {
        ...endpoint,
        allowedClientOrigins: [endpoint.serverOrigin]
      }
    };
    await service.upsertProfile(profile);
    await service.importDeviceCredential({
      profileId: profile.profileId,
      deviceToken: exampleHumanDeviceToken
    });
    const api = {
      upsertCollaborationProfile: (input: unknown) => service.upsertProfile(input),
      setActiveCollaborationProfile: (input: unknown) => service.setActiveProfile(input),
      connectCollaborationSession: (input: unknown) => service.connectSession(input)
    } as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={await service.getStatus()}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );
    await userEvent.click(screen.getByTestId("people-connect-submit"));

    await waitFor(async () => expect((await service.getStatus()).session.phase).toBe("connected"));
    expect(
      (
        await new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }).get(
          profile.profileId
        )
      )?.endpoint
    ).toEqual(profile.endpoint);
    await service.shutdown();
  });

  it("connects the Workspace and the active project session as one user action", async () => {
    const user = userEvent.setup();
    const connectWorkspaceConnection = vi.fn().mockResolvedValue(undefined);
    const setActiveCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const api = {
      upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceConnection,
      setActiveCollaborationProfile,
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          session: {
            ...diagnosticStatus.session,
            phase: "error",
            detail: "observer:failed",
            lastErrorCode: "network_unreachable",
            lastErrorMessage: "network_unreachable"
          },
          workspaceConnection: {
            ...diagnosticStatus.workspaceConnection,
            status: "disconnected"
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
        onConnected={onConnected}
      />
    );

    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(connectWorkspaceConnection).toHaveBeenCalledTimes(1);
    expect(setActiveCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(connectCollaborationSession).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(connectWorkspaceConnection.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveCollaborationProfile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(setActiveCollaborationProfile.mock.invocationCallOrder[0]).toBeLessThan(
      connectCollaborationSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("explains how to recover when the configured Server is unreachable", async () => {
    const user = userEvent.setup();
    const api = {
      upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceConnection: vi.fn().mockResolvedValue(undefined),
      setActiveCollaborationProfile: vi.fn().mockResolvedValue(undefined),
      connectCollaborationSession: vi.fn().mockRejectedValue({
        kind: "offline",
        code: "collaboration_offline",
        message: "Network request failed.",
        retryable: true
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          session: {
            ...diagnosticStatus.session,
            phase: "error",
            detail: "connect_preflight_failed",
            lastErrorCode: "collaboration_offline",
            lastErrorMessage: "Network request failed."
          },
          workspaceConnection: {
            ...diagnosticStatus.workspaceConnection,
            status: "disconnected"
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    await user.click(screen.getByTestId("people-connect-submit"));

    expect(await screen.findByTestId("people-connect-error")).toHaveTextContent(
      "Could not reach the shared Server. Make sure it is running and this device can access its address, then try again."
    );
  });

  it("reconnects Main-owned local profiles without renderer upsert", async () => {
    const user = userEvent.setup();
    const upsertCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const registerLocalCollaborationCurrentProject = vi.fn().mockResolvedValue(undefined);
    const connectWorkspaceConnection = vi.fn().mockResolvedValue(undefined);
    const setActiveCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const api = {
      upsertCollaborationProfile,
      registerLocalCollaborationCurrentProject,
      connectWorkspaceConnection,
      setActiveCollaborationProfile,
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          activeProfileId: "planweave-local-server",
          profiles: [
            {
              ...diagnosticStatus.profiles[0]!,
              profileId: "planweave-local-server",
              displayName: "Local PlanWeave Server",
              serverBaseUrl: "https://owner-device.example.ts.net/",
              allowInsecureTransport: false,
              endpoint: {
                topology: "private_https",
                serverOrigin: "https://owner-device.example.ts.net/",
                allowedClientOrigins: ["https://owner-device.example.ts.net/"],
                tlsTrust: "system_ca"
              }
            }
          ],
          session: {
            ...diagnosticStatus.session,
            phase: "disconnected",
            activeProfileId: "planweave-local-server",
            detail: null,
            lastErrorCode: null,
            lastErrorMessage: null
          },
          workspaceConnection: {
            ...diagnosticStatus.workspaceConnection,
            status: "disconnected",
            workspaceId: "workspace-local-1",
            workspaceDisplayName: "Local workspace",
            profile: {
              schemaVersion: "workspace-identity/v1",
              profileId: "planweave-local-server",
              displayName: "Local PlanWeave Server",
              serverBaseUrl: "https://owner-device.example.ts.net/",
              workspaceId: "workspace-local-1",
              allowInsecureTransport: false
            }
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() =>
      expect(registerLocalCollaborationCurrentProject).toHaveBeenCalledWith({
        profileId: "planweave-local-server"
      })
    );
    expect(upsertCollaborationProfile).not.toHaveBeenCalled();
    expect(connectWorkspaceConnection).not.toHaveBeenCalled();
    expect(connectCollaborationSession).not.toHaveBeenCalled();
  });

  it("resubmits the unchanged validated endpoint before connecting", async () => {
    const user = userEvent.setup();
    const upsertCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const setActiveCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const api = {
      upsertCollaborationProfile,
      setActiveCollaborationProfile,
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          session: {
            ...diagnosticStatus.session,
            phase: "error",
            detail: "observer:connect_timeout",
            lastErrorCode: "collaboration_observer_connect_timeout",
            lastErrorMessage: "The collaboration observer could not connect before the deadline."
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    const serverUrlInput = screen.getByTestId("people-connect-existing-server-url");
    expect(serverUrlInput).toHaveValue("http://192.168.123.23:62060/");
    expect(serverUrlInput).toHaveAttribute("readonly");
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(connectCollaborationSession).toHaveBeenCalledTimes(1));
    expect(upsertCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows",
      displayName: "Windows member",
      serverBaseUrl: "http://192.168.123.23:62060/",
      projectId: "project-1",
      allowInsecureTransport: true,
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.123.23:62060/",
        allowedClientOrigins: ["http://192.168.123.23:62060/"],
        tlsTrust: "not_applicable"
      }
    });
    expect(setActiveCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(upsertCollaborationProfile.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveCollaborationProfile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("keeps the validated server authority read-only", async () => {
    const upsertCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const api = {
      upsertCollaborationProfile,
      setActiveCollaborationProfile: vi.fn().mockResolvedValue(undefined),
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={diagnosticStatus}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    const serverUrlInput = screen.getByTestId("people-connect-existing-server-url");
    expect(serverUrlInput).toHaveAttribute("readonly");
    expect(screen.getByText(/new invitation or the deployment connection flow/i)).toBeVisible();
    expect(upsertCollaborationProfile).not.toHaveBeenCalled();
    expect(connectCollaborationSession).not.toHaveBeenCalled();
  });

  it("still connects the active project when the optional Workspace connection fails", async () => {
    const user = userEvent.setup();
    const connectWorkspaceConnection = vi
      .fn()
      .mockRejectedValue(new Error("workspace_connection_unauthorized"));
    const setActiveCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const api = {
      upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
      connectWorkspaceConnection,
      setActiveCollaborationProfile,
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          session: {
            ...diagnosticStatus.session,
            phase: "error",
            detail: "workspace_connect_failed",
            lastErrorCode: "workspace_connection_unauthorized",
            lastErrorMessage: "workspace_connection_unauthorized"
          },
          workspaceConnection: {
            ...diagnosticStatus.workspaceConnection,
            status: "error",
            error: {
              code: "workspace_connection_unauthorized",
              message: "Workspace authorization failed.",
              retryable: false
            }
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
        onConnected={onConnected}
      />
    );

    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(connectCollaborationSession).toHaveBeenCalledTimes(1));
    expect(setActiveCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(connectCollaborationSession).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("builds an allowlisted report with the observer target and redacted secrets", () => {
    const accessView: CurrentCanvasAccessView = {
      scope: {
        scopeKind: "canvas",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default"
      },
      projectVisibility: "private",
      canvasVisibility: "shared",
      projectAclRevision: 1,
      canvasAclRevision: 2,
      project: {
        scope: {
          scopeKind: "project",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: null
        },
        aclRevision: 1,
        effectiveRole: null,
        roleSource: "none",
        capabilities: accessCapabilityFlags(null),
        disabledReason: "role_missing"
      },
      canvas: {
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default"
        },
        aclRevision: 2,
        effectiveRole: "viewer",
        roleSource: "shared_visibility",
        capabilities: accessCapabilityFlags("viewer"),
        disabledReason: null
      },
      people: []
    };
    const report = buildCollaborationDiagnosticReport(
      diagnosticStatus,
      "Win32",
      {
        profileId: "profile-windows",
        projectId: "project-1",
        canvasId: "default",
        syncPhase: "error",
        observerCursor: 42,
        members: [],
        loadingKinds: ["members"],
        lastError: {
          kind: "rate_limit",
          code: "human_rate_limited",
          message: `Bearer pw_hdev_${"T".repeat(43)}`,
          httpStatus: 429,
          retryAfterMs: 1500,
          retryable: true
        },
        updatedAt: "2030-01-01T00:00:04.000Z"
      },
      accessView
    );

    expect(report).toContain("platform=Win32");
    expect(report).toContain(
      "profile.observer_url=ws://192.168.123.23:62060/api/v1/projects/project-1/human/observe"
    );
    expect(report).toContain("session.detail=observer:reconnecting:attempt=3:delay_ms=2000");
    expect(report).toContain(
      "profile.members_url=http://192.168.123.23:62060/api/v1/projects/project-1/human/members"
    );
    expect(report).toContain("read_model.loading_kinds=members");
    expect(report).toContain("read_model.error_code=human_rate_limited");
    expect(report).toContain("read_model.error_http_status=429");
    expect(report).toContain("read_model.error_retry_after_ms=1500");
    expect(report).toContain("access.workspace_id=workspace-1");
    expect(report).toContain("access.project_visibility=private");
    expect(report).toContain("access.project_role=none");
    expect(report).toContain("access.project_disabled_reason=role_missing");
    expect(report).toContain("access.canvas_visibility=shared");
    expect(report).toContain("access.canvas_role=viewer");
    expect(report).toContain("access.canvas_role_source=shared_visibility");
    expect(report).toContain("session.error_message=[REDACTED]");
    expect(report).not.toContain("pw_hdev_");
  });

  it("keeps diagnostics collapsed and copies the redacted report on demand", async () => {
    const user = userEvent.setup();
    const copyText = vi.fn().mockResolvedValue(undefined);

    render(
      <CollaborationConnectForm
        api={joinApi()}
        status={diagnosticStatus}
        t={createTranslator("en")}
        fixedMode="connect"
        copyText={copyText}
        diagnosticsEnabled
      />
    );

    expect(screen.getByTestId("people-connection-diagnostics")).not.toHaveAttribute("open");
    await user.click(screen.getByText("Connection diagnostics"));
    await user.click(screen.getByTestId("people-connection-diagnostics-copy"));

    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText.mock.calls[0]?.[0]).toContain("planweave.collaboration.diagnostics/v1");
    expect(copyText.mock.calls[0]?.[0]).not.toContain("pw_hdev_");
    expect(screen.getByTestId("people-connection-diagnostics-copy")).toHaveTextContent(
      "Diagnostics copied"
    );
  });
});

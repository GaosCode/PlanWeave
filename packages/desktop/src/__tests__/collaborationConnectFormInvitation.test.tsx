/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { serializeCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { joinApi } from "./collaborationConnectFormTestSupport";

afterEach(cleanupRendererTestEnvironment);

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

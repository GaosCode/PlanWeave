/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeCollaborationInvitationHandoffV2 } from "@planweave-ai/collaboration-protocol/handoff/invitation";
import { createTranslator } from "../renderer/i18n";
import { PeoplePanel } from "../renderer/team/PeoplePanel";
import type {
  PeopleDeviceRow,
  PeopleInvitationRow,
  PeopleMemberRow,
  PeoplePresenceSummary
} from "../renderer/collaboration/peopleViewModels";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

const presence: PeoplePresenceSummary = {
  memberCount: 2,
  hostCount: 1,
  onlineHostCount: 1,
  avatarMembers: [
    { humanPrincipalId: "human-1", displayName: "Owner", initials: "OW" },
    { humanPrincipalId: "human-2", displayName: "Member", initials: "ME" }
  ],
  sessionPhase: "connected",
  syncPhase: "ready",
  currentUserIsOwner: true,
  credentialPersistence: "persisted",
  nonPersistenceWarning: null
};

const members: PeopleMemberRow[] = [
  {
    membershipId: "m-1",
    humanPrincipalId: "human-1",
    displayName: "Owner",
    role: "owner",
    isCurrentUser: true,
    initials: "OW",
    actions: [
      { action: "promote", allowed: false, reason: "already_owner" },
      { action: "demote", allowed: false, reason: "last_owner" },
      { action: "remove", allowed: false, reason: "last_owner" }
    ]
  },
  {
    membershipId: "m-2",
    humanPrincipalId: "human-2",
    displayName: "Member",
    role: "member",
    isCurrentUser: false,
    initials: "ME",
    actions: [
      { action: "promote", allowed: true, reason: "ok" },
      { action: "demote", allowed: false, reason: "already_member" },
      { action: "remove", allowed: true, reason: "ok" }
    ]
  }
];

const invitations: PeopleInvitationRow[] = [
  {
    invitationId: "inv-1",
    role: "member",
    createdAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-08T00:00:00.000Z",
    open: true
  }
];

const devices: PeopleDeviceRow[] = [
  {
    deviceCredentialId: "device-1",
    humanPrincipalId: "human-1",
    label: "Desktop",
    createdAt: "2030-01-01T00:00:00.000Z",
    lastSeenAt: "2030-01-02T00:00:00.000Z",
    isRevoked: false
  }
];

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("PeoplePanel", () => {
  it("renders full-width member rows with inline access and supports owner invite/copy-once", async () => {
    const onCreateInvitation = vi.fn().mockResolvedValue({
      invitation: {
        invitationId: "inv-new",
        projectId: "project-1",
        role: "member",
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-08T00:00:00.000Z"
      },
      invitationToken: `pw_inv_${"A".repeat(43)}`
    });
    const onViewInvitation = vi.fn().mockResolvedValue(null);
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const onPromote = vi.fn().mockResolvedValue(true);
    const onRemove = vi.fn().mockResolvedValue(true);
    const onRevokeInvitation = vi.fn().mockResolvedValue(true);
    const onRevokeDevice = vi.fn().mockResolvedValue(true);
    const onUpdateOwnDisplayName = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { rerender } = render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        invitations={invitations}
        devices={devices}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={onCreateInvitation}
        onViewInvitation={onViewInvitation}
        onCopyInvitationToken={onCopy}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={onRevokeInvitation}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={onUpdateOwnDisplayName}
        onPromoteMember={onPromote}
        onDemoteMember={vi.fn()}
        onRemoveMember={onRemove}
        onRevokeDevice={onRevokeDevice}
        onRefreshDetails={vi.fn()}
        renderMemberAccess={(member) => (
          <div data-testid="member-access-slot">{member.displayName} access</div>
        )}
      />
    );

    expect(screen.getByTestId("people-panel")).toHaveAttribute("data-mode", "ready");
    expect(screen.getByTestId("people-toolbar")).not.toHaveClass("rounded-xl", "bg-background");
    const membersSection = screen.getByTestId("people-members-section");
    expect(membersSection).toBeVisible();
    expect(membersSection).toHaveAccessibleName("Members");
    expect(
      within(membersSection).queryByRole("heading", { name: "Members" })
    ).not.toBeInTheDocument();
    expect(membersSection).not.toHaveClass("rounded-xl", "border");
    expect(screen.queryByTestId("people-hosts-section")).not.toBeInTheDocument();
    expect(screen.getByTestId("people-presence-summary")).toHaveTextContent("2 members");
    expect(screen.getByTestId("people-presence-summary")).not.toHaveTextContent("host");
    expect(screen.getByTestId("people-workspace-summary")).toHaveTextContent(
      "Project collaboration connected"
    );
    expect(screen.getAllByTestId("people-member-devices-toggle")).toHaveLength(2);
    expect(screen.getByText("Login devices (1)")).toBeVisible();
    expect(screen.getByText("Login devices (0)")).toBeVisible();
    await userEvent.click(screen.getAllByTestId("people-member-devices-toggle")[0]!);
    expect(screen.getByTestId("people-member-devices")).toBeVisible();
    expect(screen.getByTestId("people-device-row")).toHaveTextContent("Desktop");
    await userEvent.click(screen.getAllByTestId("people-member-devices-toggle")[1]!);
    expect(screen.getAllByTestId("people-member-devices")).toHaveLength(2);
    expect(screen.getAllByTestId("people-member-devices-toggle")[0]).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getAllByTestId("people-member-devices-toggle")[1]).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getAllByTestId("people-member-access-toggle")).toHaveLength(1);
    await userEvent.click(screen.getByTestId("people-member-access-toggle"));
    expect(screen.getByTestId("member-access-slot")).toHaveTextContent("Member access");
    expect(screen.getByTestId("people-last-owner-guard")).toHaveTextContent("Last owner protected");
    expect(screen.getByTestId("people-owner-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("people-owner-section")).not.toHaveClass("rounded-xl", "border");
    expect(screen.getByTestId("people-owner-section")).not.toHaveClass("border-b");

    await userEvent.click(screen.getByTestId("people-edit-own-name"));
    const ownNameInput = screen.getByTestId("people-own-name-input");
    await userEvent.clear(ownNameInput);
    await userEvent.type(ownNameInput, "Ada Owner");
    await userEvent.click(screen.getByTestId("people-save-own-name"));
    expect(onUpdateOwnDisplayName).toHaveBeenCalledWith("Ada Owner");

    await userEvent.click(screen.getByTestId("people-create-invitation"));
    expect(onCreateInvitation).toHaveBeenCalled();
    expect(screen.getByTestId("people-owner-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("people-invitations-list")).toBeVisible();
    expect(screen.getByTestId("people-invitations-list")).not.toHaveClass("rounded-lg", "border");

    await userEvent.click(screen.getByTestId("people-member-promote"));
    expect(onPromote).toHaveBeenCalledWith("human-2");

    await userEvent.click(screen.getByTestId("people-invitation-view"));
    expect(onViewInvitation).toHaveBeenCalledWith("inv-1");

    rerender(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        invitations={invitations}
        devices={devices}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={{
          invitation: {
            invitationId: "inv-1",
            projectId: "project-1",
            role: "member",
            createdByHumanPrincipalId: "human-1",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z"
          },
          invitationToken: `pw_inv_${"A".repeat(43)}`,
          handoff: serializeCollaborationInvitationHandoffV2({
            endpoint: {
              topology: "public_https",
              serverOrigin: "https://server.example.test/",
              allowedClientOrigins: ["https://server.example.test/"],
              tlsTrust: "system_ca"
            },
            projectId: "project-1",
            invitationToken: `pw_inv_${"A".repeat(43)}`
          })
        }}
        t={t}
        onCreateInvitation={onCreateInvitation}
        onViewInvitation={onViewInvitation}
        onCopyInvitationToken={onCopy}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={onRevokeInvitation}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={onPromote}
        onDemoteMember={vi.fn()}
        onRemoveMember={onRemove}
        onRevokeDevice={onRevokeDevice}
        onRefreshDetails={vi.fn()}
      />
    );

    const secret = screen.getByTestId("people-invitation-secret-once");
    expect(secret).toBeVisible();
    expect(
      (within(secret).getByTestId("people-invitation-token-value") as HTMLInputElement).value
    ).toContain("planweave-collaboration-invitation/v2:");
    await userEvent.click(screen.getByTestId("people-invitation-copy"));
    expect(onCopy).toHaveBeenCalledWith(
      expect.stringContaining("planweave-collaboration-invitation/v2:")
    );

    await userEvent.click(screen.getByTestId("people-invitation-revoke"));
    expect(onRevokeInvitation).toHaveBeenCalledWith("inv-1");
    await userEvent.click(screen.getByTestId("people-device-sign-out"));
    expect(onRevokeDevice).toHaveBeenCalledWith("device-1");
  });

  it("shows the connect slot without surfacing disconnected API noise", () => {
    render(
      <PeoplePanel
        mode="disconnected"
        presence={{ ...presence, memberCount: 0, currentUserIsOwner: false }}
        members={[]}
        invitations={[
          {
            invitationId: "inv-new",
            role: "member",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            open: true
          }
        ]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onViewInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
        connectSlot={<div data-testid="people-connect-form">connect</div>}
      />
    );

    expect(screen.getByTestId("people-panel")).toHaveAttribute("data-mode", "disconnected");
    expect(screen.getByTestId("people-connect-form")).toBeVisible();
    expect(screen.queryByText(/Not connected/i)).not.toBeInTheDocument();
  });

  it("shows a reconnect action when a page shell hides the title and has no connect slot", async () => {
    const onRefreshDetails = vi.fn().mockResolvedValue(undefined);
    render(
      <PeoplePanel
        mode="disconnected"
        presence={{ ...presence, memberCount: 0, currentUserIsOwner: false }}
        members={[]}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onViewInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={onRefreshDetails}
        showTitle={false}
      />
    );

    expect(screen.getByTestId("people-panel-disconnected")).toBeVisible();
    await userEvent.click(screen.getByTestId("people-refresh-details"));
    expect(onRefreshDetails).toHaveBeenCalledOnce();
  });

  it("keeps an empty workspace neutral and keeps advanced recovery collapsed", async () => {
    const connectSlot = <div data-testid="people-connect-form">connect</div>;
    const commonProps = {
      presence: { ...presence, memberCount: 0, hostCount: 0, onlineHostCount: 0 },
      members: [],
      invitations: [],
      devices: [],
      detailsLoading: false,
      detailsError: null,
      actionError: null,
      actionBusy: false,
      pendingInvitation: null,
      t,
      onCreateInvitation: vi.fn(),
      onViewInvitation: vi.fn(),
      onCopyInvitationToken: vi.fn(),
      onDismissPendingInvitation: vi.fn(),
      onRevokeInvitation: vi.fn(),
      onRevokeInvitations: vi.fn(),
      onUpdateOwnDisplayName: vi.fn(),
      onPromoteMember: vi.fn(),
      onDemoteMember: vi.fn(),
      onRemoveMember: vi.fn(),
      onRevokeDevice: vi.fn(),
      onRefreshDetails: vi.fn(),
      connectSlot
    };

    const { rerender } = render(<PeoplePanel {...commonProps} mode="empty" />);

    expect(screen.getByTestId("people-members-empty")).toHaveTextContent("No members yet.");
    expect(screen.getAllByText("No members yet.")).toHaveLength(1);
    expect(screen.queryByTestId("people-empty")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(<PeoplePanel {...commonProps} mode="error" />);

    expect(screen.getByTestId("people-error")).toBeVisible();
    expect(screen.getByTestId("people-error")).toHaveClass("text-muted-foreground");
    expect(screen.getByTestId("people-error")).not.toHaveAttribute("role", "alert");
    expect(screen.getByTestId("people-presence-summary")).toHaveTextContent(
      "Could not load collaboration people"
    );
    expect(screen.getByTestId("people-presence-summary")).not.toHaveTextContent("0 members");
    expect(screen.getByTestId("people-members-empty")).toHaveTextContent(
      "Could not load collaboration people"
    );
    expect(screen.getByTestId("people-members-empty")).not.toHaveTextContent("No members");
    expect(screen.queryByTestId("people-connect-form")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("people-toggle-connection-settings"));
    expect(screen.getByTestId("people-connect-form")).toBeVisible();
  });

  it("exposes copyable read diagnostics when member loading fails", async () => {
    const onCopyDiagnostics = vi.fn().mockResolvedValue(undefined);
    render(
      <PeoplePanel
        mode="error"
        presence={{ ...presence, memberCount: 0, hostCount: 0, onlineHostCount: 0 }}
        members={[]}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        diagnosticReport={[
          "planweave.collaboration.diagnostics/v1",
          "profile.project_id=project-1",
          "read_model.error_code=human_rate_limited"
        ].join("\n")}
        diagnosticsEnabled
        onCopyDiagnostics={onCopyDiagnostics}
        t={t}
        onCreateInvitation={vi.fn()}
        onViewInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    expect(screen.getByTestId("people-read-diagnostics")).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("Connection diagnostics"));
    expect(screen.getByTestId("people-read-diagnostics-report")).toHaveTextContent(
      "read_model.error_code=human_rate_limited"
    );
    await userEvent.click(screen.getByTestId("people-read-diagnostics-copy"));

    expect(onCopyDiagnostics).toHaveBeenCalledWith(
      expect.stringContaining("profile.project_id=project-1")
    );
    expect(screen.getByTestId("people-read-diagnostics-copy")).toHaveTextContent(
      "Diagnostics copied"
    );
  });

  it("opens invitation management after a lone owner finishes initialization", () => {
    render(
      <PeoplePanel
        mode="ready"
        presence={{ ...presence, memberCount: 1, hostCount: 0, onlineHostCount: 0 }}
        members={[members[0]!]}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    expect(screen.getByTestId("people-owner-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("people-create-invitation")).toBeVisible();
  });

  it("copies a complete cross-device invitation handoff when connection details exist", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        invitations={[
          {
            invitationId: "inv-new",
            role: "member",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            open: true
          }
        ]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={{
          invitation: {
            invitationId: "inv-new",
            projectId: "project-1",
            role: "member",
            createdByHumanPrincipalId: "human-1",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z"
          },
          invitationToken: `pw_inv_${"A".repeat(43)}`,
          handoff: serializeCollaborationInvitationHandoffV2({
            endpoint: {
              topology: "public_https",
              serverOrigin: "https://server.example.test/",
              allowedClientOrigins: ["https://server.example.test/"],
              tlsTrust: "system_ca"
            },
            projectId: "project-1",
            invitationToken: `pw_inv_${"A".repeat(43)}`
          })
        }}
        revealInvitationManagement
        t={t}
        onCreateInvitation={vi.fn()}
        onViewInvitation={vi.fn()}
        onCopyInvitationToken={onCopy}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    const visibleInvitation = screen.getByTestId("people-invitation-token-value");
    expect((visibleInvitation as HTMLInputElement).value).toContain(
      "planweave-collaboration-invitation/v2:"
    );

    await userEvent.click(screen.getByTestId("people-invitation-copy"));

    const copiedInvitation = onCopy.mock.calls[0]?.[0];
    expect(copiedInvitation).toEqual(
      expect.stringContaining("planweave-collaboration-invitation/v2:")
    );
  });

  it("uses readable invitation and device summaries instead of raw identifiers", () => {
    const invitationId = "24e269e7-2c6a-43cc-995f-6e73db44fb1c";
    const deviceId = "369c6c7c-dace-4f0b-a8b9-16da98374eac";
    render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        invitations={[
          {
            invitationId,
            role: "member",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            open: true
          }
        ]}
        devices={[
          {
            deviceCredentialId: deviceId,
            humanPrincipalId: "human-1",
            label: deviceId,
            createdAt: "2030-01-01T00:00:00.000Z",
            lastSeenAt: "2030-01-02T00:00:00.000Z",
            isRevoked: false
          }
        ]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("people-owner-toggle"));
    fireEvent.click(screen.getAllByTestId("people-member-devices-toggle")[0]!);

    expect(screen.getByTestId("people-invitation-row")).toHaveTextContent("Waiting for a member");
    expect(screen.getByTestId("people-invitation-row")).toHaveTextContent(
      "Invite ID 24e269e7…fb1c"
    );
    expect(screen.getByTestId("people-device-row")).toHaveTextContent("Unnamed device 1");
    expect(screen.getByTestId("people-device-row")).toHaveTextContent("Device ID 369c6c7c…4eac");
    expect(screen.queryByText(invitationId)).not.toBeInTheDocument();
    expect(screen.queryByText(deviceId)).not.toBeInTheDocument();
  });

  it("selects and revokes multiple open invitations in one action", async () => {
    const onRevokeInvitations = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        invitations={[
          { ...invitations[0]!, invitationId: "inv-1" },
          { ...invitations[0]!, invitationId: "inv-2" },
          {
            ...invitations[0]!,
            invitationId: "inv-closed",
            open: false,
            revokedAt: "2030-01-02T00:00:00.000Z"
          }
        ]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={onRevokeInvitations}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("people-owner-toggle"));
    await userEvent.click(screen.getByTestId("people-invitation-select-all"));

    expect(screen.getByTestId("people-invitation-revoke-selected")).toHaveTextContent(
      "Revoke selected (2)"
    );
    await userEvent.click(screen.getByTestId("people-invitation-revoke-selected"));

    expect(window.confirm).toHaveBeenCalledWith(
      "Revoke the 2 selected invitations? This action cannot be undone."
    );
    expect(onRevokeInvitations).toHaveBeenCalledWith(["inv-1", "inv-2"]);
  });

  it("selects one invitation without crashing the People renderer", async () => {
    render(
      <StrictMode>
        <PeoplePanel
          mode="ready"
          presence={presence}
          members={members}
          invitations={[
            { ...invitations[0]!, invitationId: "inv-1" },
            { ...invitations[0]!, invitationId: "inv-2" }
          ]}
          devices={[]}
          detailsLoading={false}
          detailsError={null}
          actionError={null}
          actionBusy={false}
          pendingInvitation={null}
          t={t}
          onCreateInvitation={vi.fn()}
          onCopyInvitationToken={vi.fn()}
          onDismissPendingInvitation={vi.fn()}
          onRevokeInvitation={vi.fn()}
          onRevokeInvitations={vi.fn()}
          onUpdateOwnDisplayName={vi.fn()}
          onPromoteMember={vi.fn()}
          onDemoteMember={vi.fn()}
          onRemoveMember={vi.fn()}
          onRevokeDevice={vi.fn()}
          onRefreshDetails={vi.fn()}
        />
      </StrictMode>
    );

    fireEvent.click(screen.getByTestId("people-owner-toggle"));
    await userEvent.click(screen.getAllByTestId("people-invitation-select")[0]!);

    expect(screen.getByTestId("people-panel")).toBeVisible();
    expect(screen.getByTestId("people-invitation-revoke-selected")).toHaveTextContent(
      "Revoke selected (1)"
    );
  });

  it("lets a regular member edit their name and sign out only their own devices", async () => {
    const onUpdateOwnDisplayName = vi.fn().mockResolvedValue(true);
    const onRevokeDevice = vi.fn().mockResolvedValue(true);
    render(
      <PeoplePanel
        mode="ready"
        presence={{ ...presence, currentUserIsOwner: false }}
        members={[
          { ...members[0]!, isCurrentUser: false },
          { ...members[1]!, isCurrentUser: true }
        ]}
        invitations={[]}
        devices={[{ ...devices[0]!, humanPrincipalId: "human-2" }]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={onUpdateOwnDisplayName}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={onRevokeDevice}
        onRefreshDetails={vi.fn()}
      />
    );

    expect(screen.queryByTestId("people-owner-section")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("people-edit-own-name")).toHaveLength(1);
    expect(screen.getAllByTestId("people-member-devices-toggle")).toHaveLength(1);
    await userEvent.click(screen.getByTestId("people-member-devices-toggle"));
    expect(screen.getByTestId("people-device-row")).toHaveTextContent("Desktop");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByTestId("people-device-sign-out"));
    expect(onRevokeDevice).toHaveBeenCalledWith("device-1");

    await userEvent.click(screen.getByTestId("people-edit-own-name"));
    const input = screen.getByTestId("people-own-name-input");
    await userEvent.clear(input);
    await userEvent.type(input, "Ada Member");
    await userEvent.click(screen.getByTestId("people-save-own-name"));

    expect(onUpdateOwnDisplayName).toHaveBeenCalledWith("Ada Member");
  });

  it("shows forbidden state without owner mutation controls", () => {
    render(
      <PeoplePanel
        mode="forbidden"
        presence={{ ...presence, currentUserIsOwner: false }}
        members={members}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError="human_forbidden: not allowed"
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onUpdateOwnDisplayName={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    expect(screen.getByTestId("people-panel-auth-error")).toHaveTextContent(/permission/i);
    expect(screen.queryByTestId("people-owner-section")).not.toBeInTheDocument();
  });
});

/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { PeoplePanel, type PeoplePanelProps } from "../renderer/team/PeoplePanel";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { serializeCollaborationInvitationHandoffV2 } from "@planweave-ai/collaboration-protocol/handoff/invitation";

import {
  workspaceIdSchema,
  humanPrincipalIdSchema,
  projectInvitationIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { StrictMode } from "react";
import { PeopleView } from "../renderer/views/PeopleView";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import type {
  OperatorControlStatus,
  OperatorMemberSetupCodeHandoffView
} from "../shared/operatorControl";
import { peopleIdentityReads } from "./helpers/peopleViewFixtures";

const invitationToken = `pw_inv_${"A".repeat(43)}`;
const t = createTranslator("en");

function pendingInvitation(invitationId: string, token: string) {
  return {
    invitation: {
      invitationId: projectInvitationIdSchema.parse(invitationId),
      projectId: "project-1",
      role: "member" as const,
      createdByHumanPrincipalId: humanPrincipalIdSchema.parse("human-1"),
      createdAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-08T00:00:00.000Z"
    },
    invitationToken: token,
    handoff: serializeCollaborationInvitationHandoffV2({
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example.test/",
        allowedClientOrigins: ["https://server.example.test/"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken: token
    })
  };
}

function createProps(
  pendingInvitationValue: PeoplePanelProps["pendingInvitation"],
  onCopyInvitationToken: PeoplePanelProps["onCopyInvitationToken"]
): PeoplePanelProps {
  return {
    mode: "ready",
    presence: {
      memberCount: 1,
      hostCount: 0,
      onlineHostCount: 0,
      avatarMembers: [],
      sessionPhase: "connected",
      syncPhase: "ready",
      currentUserIsOwner: true,
      credentialPersistence: "persisted",
      nonPersistenceWarning: null
    },
    members: [],
    invitations: pendingInvitationValue
      ? [
          {
            invitationId: pendingInvitationValue.invitation.invitationId,
            role: "member",
            createdAt: pendingInvitationValue.invitation.createdAt,
            expiresAt: pendingInvitationValue.invitation.expiresAt,
            open: true
          }
        ]
      : [],
    devices: [],
    detailsLoading: false,
    detailsError: null,
    actionError: null,
    actionBusy: false,
    pendingInvitation: pendingInvitationValue,
    t,
    onCreateInvitation: vi.fn(),
    onViewInvitation: vi.fn(),
    onCopyInvitationToken,
    onDismissPendingInvitation: vi.fn(),
    onRevokeInvitation: vi.fn(),
    onRevokeInvitations: vi.fn(),
    onUpdateOwnDisplayName: vi.fn(),
    onPromoteMember: vi.fn(),
    onDemoteMember: vi.fn(),
    onRemoveMember: vi.fn(),
    onRevokeDevice: vi.fn(),
    onRefreshDetails: vi.fn()
  };
}

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("PeoplePanel invitation copy", () => {
  it("shows a localized clipboard error and resets copy feedback for each pending invitation", async () => {
    const onCopyInvitationToken = vi
      .fn<PeoplePanelProps["onCopyInvitationToken"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("clipboard_denied"));
    const first = pendingInvitation("inv-first", invitationToken);
    const second = pendingInvitation("inv-second", `pw_inv_${"B".repeat(43)}`);
    const third = pendingInvitation("inv-third", `pw_inv_${"C".repeat(43)}`);
    const { rerender } = render(<PeoplePanel {...createProps(first, onCopyInvitationToken)} />);

    await userEvent.click(screen.getByTestId("people-invitation-copy"));
    expect(screen.getByTestId("people-invitation-copy")).toHaveTextContent("Copied");

    rerender(<PeoplePanel {...createProps(second, onCopyInvitationToken)} />);
    expect(screen.getByTestId("people-invitation-copy")).toHaveTextContent(
      "Copy complete join details"
    );
    expect(screen.queryByTestId("people-invitation-copy-error")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("people-invitation-copy"));
    expect(await screen.findByTestId("people-invitation-copy-error")).toHaveTextContent(
      "Could not copy the invitation. Try again."
    );
    expect(screen.getByTestId("people-invitation-copy")).toHaveTextContent(
      "Copy complete join details"
    );

    rerender(<PeoplePanel {...createProps(third, onCopyInvitationToken)} />);
    expect(screen.queryByTestId("people-invitation-copy-error")).not.toBeInTheDocument();
  });
});

const operatorBridge = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  onOperatorControlStatusChanged: vi.fn(),
  copyOperatorMemberSetupCode: vi.fn(),
  listOperatorHosts: vi.fn(),
  getOperatorLocalAgentHostStatus: vi.fn()
}));
vi.mock("../renderer/bridge", () => ({
  collaborationBridge: null,
  operatorControlBridge: operatorBridge,
  bridge: null,
  settingsBridge: null
}));

function operatorStatus(
  revision = 0,
  activeProfileId = "operator-a",
  authorized = true
): OperatorControlStatus {
  return {
    profiles: [
      {
        profileId: activeProfileId,
        displayName: "Server operator",
        serverBaseUrl: "https://server.example.test/",
        allowInsecureTransport: false,
        hostedByThisDesktop: false,
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://server.example.test",
          allowedClientOrigins: ["https://server.example.test"],
          tlsTrust: "system_ca"
        },
        operatorId: activeProfileId,
        humanPrincipalId: "operator-human",
        hasOperatorCredential: authorized,
        operatorCredentialPersistence: authorized ? "persisted" : "missing",
        updatedAt: `2030-01-01T00:00:0${revision}.000Z`,
        credentialRevision: `credential-${revision}`
      }
    ],
    activeProfileId,
    credentialStorage: "available",
    nonPersistenceWarning: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: `2030-01-01T00:00:0${revision}.000Z`
  };
}
function collaborationStatus(workspaceIdValue = "workspace-1", revision = 0): CollaborationStatus {
  const workspaceId = workspaceIdSchema.parse(workspaceIdValue);
  return {
    profiles: [],
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
      credentialRevision: `workspace-credential-${revision}`,
      schemaVersion: "workspace-setup/v1",
      status: "connected",
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: workspaceId,
        displayName: "Team",
        serverBaseUrl: "https://server.example.test/",
        workspaceId,
        allowInsecureTransport: false
      },
      workspaceId,
      workspaceDisplayName: "Team",
      connectedAt: "2030-01-01T00:00:00.000Z",
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
    updatedAt: `2030-01-01T00:00:0${revision}.000Z`
  };
}
function pendingCopy() {
  let resolve!: (value: OperatorMemberSetupCodeHandoffView) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<OperatorMemberSetupCodeHandoffView>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const copied = {
  state: "ready",
  workspaceId: "workspace-1",
  expiresAt: "2030-01-08T00:00:00.000Z",
  copiedAt: "2030-01-01T00:00:00.000Z"
} as const;
function mountPeople(strict = false) {
  let emitOperator!: (next: OperatorControlStatus) => void;
  let emitWorkspace!: (next: CollaborationStatus) => void;
  const unsubscribe = vi.fn();
  operatorBridge.getOperatorControlStatus.mockResolvedValue(operatorStatus());
  operatorBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    emitOperator = listener;
    return unsubscribe;
  });
  operatorBridge.listOperatorHosts.mockResolvedValue({ items: [], nextCursor: null });
  operatorBridge.getOperatorLocalAgentHostStatus.mockResolvedValue({
    supported: true,
    state: "not_registered",
    agents: []
  });
  operatorBridge.copyOperatorMemberSetupCode.mockResolvedValue(copied);
  const api: Partial<PlanWeaveCollaborationApi> = {
    ...peopleIdentityReads(),
    getCollaborationStatus: vi.fn().mockResolvedValue(collaborationStatus()),
    onCollaborationStatusChanged: vi.fn((listener: (next: CollaborationStatus) => void) => {
      emitWorkspace = listener;
      return unsubscribe;
    }),
    onCollaborationObserverSignal: vi.fn(() => unsubscribe),
    getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    })
  };
  const view = (
    <PeopleView
      api={api as PlanWeaveCollaborationApi}
      t={t}
      collaborationScopeLayout={{ collapsed: true, expandedProjectIds: [] }}
      onCollaborationScopeLayoutChange={() => undefined}
    />
  );
  const mounted = render(strict ? <StrictMode>{view}</StrictMode> : view);
  return {
    ...mounted,
    unsubscribe,
    emitOperator: (next: OperatorControlStatus) => emitOperator(next),
    emitWorkspace: (next: CollaborationStatus) => emitWorkspace(next)
  };
}
async function openMembers() {
  await act(async () => {});
  fireEvent.keyDown(screen.getByTestId("people-section-members"), { key: "Enter" });
  await act(async () => {});
}
beforeEach(() => {
  Object.values(operatorBridge).forEach((mock) => {
    mock.mockReset();
  });
});

describe("People workspace invitation capability", () => {
  it("does not poll Host inventory or local service across three five-second periods", async () => {
    vi.useFakeTimers();
    const mounted = mountPeople();
    await openMembers();
    for (let cycle = 0; cycle < 3; cycle += 1)
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect.soft(operatorBridge.listOperatorHosts).not.toHaveBeenCalled();
    expect.soft(operatorBridge.getOperatorLocalAgentHostStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("workspace-copy-invitation"));
    await act(async () => {});
    expect(operatorBridge.copyOperatorMemberSetupCode).toHaveBeenCalledWith({
      profileId: "operator-a",
      workspaceId: "workspace-1",
      serverBaseUrl: "https://server.example.test/"
    });
    expect(screen.getByText("Copied · send it to the other person to join")).toBeVisible();
    mounted.unmount();
    expect(mounted.unsubscribe).toHaveBeenCalled();
  });

  it("releases busy after a readable failure, guards duplicate clicks and permits retry", async () => {
    mountPeople();
    await openMembers();
    const pending = pendingCopy();
    operatorBridge.copyOperatorMemberSetupCode.mockReturnValueOnce(pending.promise);
    const button = screen.getByTestId("workspace-copy-invitation");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(operatorBridge.copyOperatorMemberSetupCode).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("clipboard_denied")));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not copy");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await act(async () => {});
    expect(screen.getByText("Copied · send it to the other person to join")).toBeVisible();
  });

  it.each([
    "profile",
    "workspace",
    "credential",
    "credential-refresh"
  ] as const)("drops late success after %s changes", async (change) => {
    const mounted = mountPeople();
    await openMembers();
    const pending = pendingCopy();
    operatorBridge.copyOperatorMemberSetupCode.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByTestId("workspace-copy-invitation"));
    await act(async () => {
      if (change === "workspace") mounted.emitWorkspace(collaborationStatus("workspace-2", 1));
      else
        mounted.emitOperator(
          operatorStatus(
            1,
            change === "profile" ? "operator-b" : "operator-a",
            change !== "credential"
          )
        );
    });
    await act(async () => pending.resolve(copied));
    expect(
      screen.queryByText("Copied · send it to the other person to join")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    if (change !== "credential") {
      fireEvent.click(screen.getByTestId("workspace-copy-invitation"));
      await act(async () => {});
      expect(operatorBridge.copyOperatorMemberSetupCode).toHaveBeenLastCalledWith({
        profileId: change === "profile" ? "operator-b" : "operator-a",
        workspaceId: change === "workspace" ? "workspace-2" : "workspace-1",
        serverBaseUrl: "https://server.example.test/"
      });
    }
  });

  it("drops late errors after workspace replacement and completion after unmount under StrictMode", async () => {
    const mounted = mountPeople(true);
    await openMembers();
    const pending = pendingCopy();
    operatorBridge.copyOperatorMemberSetupCode.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByTestId("workspace-copy-invitation"));
    await act(async () => mounted.emitWorkspace(collaborationStatus("workspace-2", 1)));
    await act(async () => pending.reject(new Error("clipboard_denied")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const late = pendingCopy();
    operatorBridge.copyOperatorMemberSetupCode.mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByTestId("workspace-copy-invitation"));
    mounted.unmount();
    await act(async () => late.resolve(copied));
    expect(
      screen.queryByText("Copied · send it to the other person to join")
    ).not.toBeInTheDocument();
    expect(mounted.unsubscribe.mock.calls.length).toBeGreaterThanOrEqual(2);
    const fresh = mountPeople(true);
    await openMembers();
    expect(screen.getByTestId("workspace-copy-invitation")).toBeEnabled();
    fresh.unmount();
  });

  it.each([
    "success",
    "error"
  ] as const)("retries with refreshed workspace credentials while dropping the previous %s", async (outcome) => {
    const mounted = mountPeople();
    await openMembers();
    const previous = pendingCopy();
    operatorBridge.copyOperatorMemberSetupCode.mockReturnValueOnce(previous.promise);
    fireEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(screen.getByTestId("workspace-copy-invitation")).toBeDisabled();

    await act(async () => mounted.emitWorkspace(collaborationStatus("workspace-1", 1)));
    expect(screen.getByTestId("workspace-copy-invitation")).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Copied · send it to the other person to join")
    ).not.toBeInTheDocument();

    const current = pendingCopy();
    operatorBridge.copyOperatorMemberSetupCode.mockReturnValueOnce(current.promise);
    fireEvent.click(screen.getByTestId("workspace-copy-invitation"));
    expect(operatorBridge.copyOperatorMemberSetupCode).toHaveBeenCalledTimes(2);
    expect(operatorBridge.copyOperatorMemberSetupCode).toHaveBeenLastCalledWith({
      profileId: "operator-a",
      workspaceId: "workspace-1",
      serverBaseUrl: "https://server.example.test/"
    });

    await act(async () => {
      if (outcome === "success") previous.resolve(copied);
      else previous.reject(new Error("clipboard_denied"));
    });
    expect(screen.getByTestId("workspace-copy-invitation")).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Copied · send it to the other person to join")
    ).not.toBeInTheDocument();

    await act(async () => current.resolve(copied));
    expect(screen.getByTestId("workspace-copy-invitation")).toBeEnabled();
    expect(screen.getByText("Copied · send it to the other person to join")).toBeVisible();
  });
});

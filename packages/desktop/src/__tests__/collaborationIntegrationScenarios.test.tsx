/* @vitest-environment jsdom */

/**
 * End-to-end Desktop collaboration scenarios for DX-003 surfaces.
 * Uses stable data-testid selectors and the mock collaboration bridge.
 * Does not rely on Chinese copy or ReactFlow internals.
 */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleObserverCatchupRequired } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { type WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { createTranslator } from "../renderer/i18n";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { serializeCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import { PeoplePanel } from "../renderer/team/PeoplePanel";
import { RemoteRunPanel } from "../renderer/team/RemoteRunPanel";
import { WorkItemCollaborationPanel } from "../renderer/team/WorkItemCollaborationPanel";
import type {
  CollaborationObserverSignal,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../shared/collaboration";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
};

const taskItem: WorkItemRef = { kind: "task", canvasId: "default", taskId: "T-1" };

function connectedStatus(
  phase: CollaborationStatus["session"]["phase"] = "connected"
): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: phase === "idle" ? null : "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase,
      activeProfileId: phase === "idle" ? null : "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

type ScenarioState = {
  observationState: "running" | "interrupted" | "completed" | "cancelled" | "failed";
  comments: Array<{
    commentId: string;
    body: string | null;
    revision: number;
    tombstoned: boolean;
  }>;
  activity: Array<{
    activityId: string;
    type: string;
    sourceKind: "membership" | "assignment" | "comment" | "remote_run";
    headline: string;
  }>;
};

function createScenarioApi(state: ScenarioState) {
  const statusListeners: Array<(status: CollaborationStatus) => void> = [];
  const signalListeners: Array<(signal: CollaborationObserverSignal) => void> = [];
  let status = connectedStatus("connected");

  const emitStatus = (next: CollaborationStatus) => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };

  const emitSignal = (signal: CollaborationObserverSignal) => {
    for (const listener of signalListeners) listener(signal);
  };

  const observation = () => {
    const interrupted = state.observationState === "interrupted";
    return {
      operationId: "op-1",
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-1#B-1",
      state: state.observationState,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: state.observationState,
        hostId: "host-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2030-01-01T01:00:00.000Z",
        stateVersion: 2
      },
      dispatchStatus: state.observationState === "running" ? ("running" as const) : undefined,
      runtime: {
        ref: "T-1#B-1",
        status:
          state.observationState === "completed"
            ? "completed"
            : state.observationState === "failed" || state.observationState === "cancelled"
              ? "failed"
              : "in_progress",
        interruption: interrupted
          ? {
              reason: "transport_lost",
              resumable: true,
              recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
            }
          : undefined
      }
    };
  };

  const listComments = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return { items: [], nextCursor: null };
    }
    return {
      items: state.comments.map((comment, index) => ({
        commentId: comment.commentId,
        projectId: "project-1",
        workItem: taskItem,
        author: {
          humanPrincipalId: "human-1",
          displayName: "Ada",
          membershipActive: true
        },
        body: comment.body,
        bodyFormat: "markdown" as const,
        revision: comment.revision,
        createdAt: `2030-01-01T00:00:0${index}.000Z`,
        updatedAt: `2030-01-01T00:00:0${index}.000Z`,
        tombstoned: comment.tombstoned,
        attachments:
          comment.commentId === "comment-1"
            ? [
                {
                  digestSha256: "a".repeat(64),
                  fileName: "notes.txt",
                  mediaType: "text/plain" as const,
                  sizeBytes: 12
                }
              ]
            : [],
        workItemPresence: "present" as const
      })),
      nextCursor:
        state.comments.length > 1
          ? { createdAt: "2030-01-01T00:00:00.000Z", commentId: "comment-1" }
          : null
    };
  });

  const listActivity = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return { items: [], nextCursor: null };
    }
    return {
      items: state.activity.map((row, index) => ({
        activityId: row.activityId,
        projectId: "project-1",
        type: row.type,
        source: { kind: row.sourceKind, sourceId: row.activityId },
        summary: { headline: row.headline, workItem: taskItem },
        subjects: [{ kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }],
        workItem: taskItem,
        occurredAt: `2030-01-01T00:10:0${index}.000Z`
      })),
      nextCursor: null
    };
  });

  const createComment = vi.fn().mockImplementation(async (input: { body: string }) => {
    const created = {
      commentId: `comment-${state.comments.length + 1}`,
      projectId: "project-1",
      workItem: taskItem,
      author: {
        humanPrincipalId: "human-1",
        displayName: "Ada",
        membershipActive: true
      },
      body: input.body,
      bodyFormat: "markdown" as const,
      revision: 1,
      createdAt: "2030-01-01T00:20:00.000Z",
      updatedAt: "2030-01-01T00:20:00.000Z",
      tombstoned: false,
      attachments: [],
      workItemPresence: "present" as const
    };
    state.comments.unshift({
      commentId: created.commentId,
      body: created.body,
      revision: 1,
      tombstoned: false
    });
    return created;
  });

  const dispatch = vi.fn().mockImplementation(async () => {
    state.observationState = "running";
    return observation();
  });

  const executeAction = vi.fn().mockImplementation(async (input: { action: { kind: string } }) => {
    if (input.action.kind === "cancel") state.observationState = "cancelled";
    if (input.action.kind === "resume_same_session") state.observationState = "running";
    if (input.action.kind === "retry_new_attempt") state.observationState = "running";
    if (input.action.kind === "fail_interruption") state.observationState = "failed";
    return {
      request: {
        kind: input.action.kind,
        actionId: "a1",
        operationId: "op-1",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        expectedAttemptVersion: 2,
        leaseId: "lease-1",
        reason: "scenario"
      },
      state: "recorded",
      createdAt: "2030-01-01T00:02:00.000Z"
    };
  });

  const settle = vi.fn().mockResolvedValue({
    request: {
      type: "interaction.permission_requested",
      title: "Write",
      description: "Allow write",
      actionId: "ia-1",
      dispatchId: "dispatch-1",
      leaseId: "lease-1",
      executionAttemptId: "attempt-1",
      acpSessionId: "session-1",
      expiresAt: "2030-01-01T02:00:00.000Z"
    },
    operationId: "op-1",
    hostId: "host-1",
    status: "settled",
    createdAt: "2030-01-01T00:30:00.000Z"
  });

  const updateAssignment = vi.fn().mockResolvedValue({
    projectId: "project-1",
    workItem: blockItem,
    target: { kind: "exact_host", hostId: "host-1" },
    revision: 2,
    availability: { status: "ready", reason: "ready" },
    host: {
      hostId: "host-1",
      displayName: "Host One",
      online: true,
      authorizedForProject: true,
      revoked: false,
      capabilitiesSatisfied: true
    }
  });

  const api = {
    getCollaborationStatus: vi.fn().mockImplementation(async () => status),
    onCollaborationStatusChanged: vi.fn((listener: (status: CollaborationStatus) => void) => {
      statusListeners.push(listener);
      return () => {
        const index = statusListeners.indexOf(listener);
        if (index >= 0) statusListeners.splice(index, 1);
      };
    }),
    onCollaborationObserverSignal: vi.fn(
      (listener: (signal: CollaborationObserverSignal) => void) => {
        signalListeners.push(listener);
        return () => {
          const index = signalListeners.indexOf(listener);
          if (index >= 0) signalListeners.splice(index, 1);
        };
      }
    ),
    upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
    consumeCollaborationInvitation: vi.fn().mockResolvedValue({
      deviceCredentialPersistence: "persisted",
      nonPersistenceWarning: null
    }),
    bootstrapCollaborationOwner: vi.fn().mockResolvedValue({
      deviceCredentialPersistence: "persisted",
      nonPersistenceWarning: null
    }),
    setActiveCollaborationProfile: vi.fn().mockResolvedValue(undefined),
    connectCollaborationSession: vi.fn().mockImplementation(async () => {
      emitStatus(connectedStatus("connected"));
    }),
    disconnectCollaborationSession: vi.fn().mockImplementation(async () => {
      emitStatus(connectedStatus("idle"));
    }),
    listCollaborationMembers: vi.fn().mockResolvedValue({
      items: [
        {
          membershipId: "m-1",
          projectId: "project-1",
          humanPrincipalId: "human-1",
          displayName: "Ada",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        },
        {
          membershipId: "m-2",
          projectId: "project-1",
          humanPrincipalId: "human-2",
          displayName: "Grace",
          role: "member",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({
      items: [
        {
          projectId: "project-1",
          workItem: blockItem,
          target: { kind: "exact_host", hostId: "host-1" },
          revision: 1,
          availability: { status: "ready", reason: "ready" },
          host: {
            hostId: "host-1",
            displayName: "Host One",
            online: true,
            authorizedForProject: true,
            revoked: false,
            capabilitiesSatisfied: true
          }
        },
        {
          projectId: "project-1",
          workItem: taskItem,
          target: { kind: "human", humanPrincipalId: "human-2" },
          revision: 1,
          availability: { status: "assigned", reason: "assigned" }
        }
      ],
      nextCursor: null
    }),
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({
      workItem: blockItem,
      humans: [
        {
          membershipId: "m-2",
          projectId: "project-1",
          humanPrincipalId: "human-2",
          displayName: "Grace",
          role: "member",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      hosts: [
        {
          projectId: "project-1",
          hostId: "host-1",
          exists: true,
          revoked: false,
          authorizedForProject: true,
          online: true,
          capabilities: ["acp"],
          displayName: "Host One"
        }
      ],
      nextHumanCursor: null,
      nextHostCursor: null
    }),
    listCollaborationComments: listComments,
    listCollaborationActivity: listActivity,
    createCollaborationComment: createComment,
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    getCollaborationWorkAuthority: vi.fn().mockImplementation(async ({ workItem }) => {
      const scope =
        workItem.kind === "task"
          ? {
              kind: "task" as const,
              workspaceId: "workspace-1",
              projectId: "project-1",
              canvasId: workItem.canvasId,
              taskId: workItem.taskId
            }
          : {
              kind: "block" as const,
              workspaceId: "workspace-1",
              projectId: "project-1",
              canvasId: workItem.canvasId,
              blockRef: workItem.blockRef
            };
      return {
        schemaVersion: "work-authority/v1",
        scope,
        responsibility: {
          schemaVersion: "responsibility/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        reviewer: {
          schemaVersion: "review-assignment/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        executionTarget:
          workItem.kind === "block"
            ? {
                schemaVersion: "execution-target/v1",
                scope,
                target: { kind: "unassigned" },
                revision: 0,
                updatedAt: "2030-01-01T00:00:00.000Z",
                availability: { status: "unassigned", reason: "unassigned" }
              }
            : null,
        revisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 0
        },
        selectedHost: null,
        evaluatedAt: "2030-01-01T00:00:00.000Z"
      };
    }),
    updateCollaborationResponsibility: vi.fn(),
    updateCollaborationReviewer: vi.fn(),
    updateCollaborationAssignment: updateAssignment,
    createCollaborationPendingAttachment: vi.fn(),
    uploadCollaborationPendingAttachment: vi.fn(),
    finalizeCollaborationPendingAttachment: vi.fn(),
    readCollaborationCommentAttachment: vi.fn().mockResolvedValue({
      digestSha256: "a".repeat(64),
      mediaType: "image/png",
      sizeBytes: 4,
      bodyBase64: "iVBORw=="
    }),
    listCollaborationInvitations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationDevices: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    createCollaborationInvitation: vi.fn(),
    revokeCollaborationInvitation: vi.fn(),
    promoteCollaborationOwner: vi.fn(),
    demoteCollaborationOwner: vi.fn(),
    removeCollaborationMember: vi.fn(),
    revokeCollaborationDevice: vi.fn(),
    observeCollaborationRemoteOperation: vi.fn().mockImplementation(async () => observation()),
    dispatchCollaborationRemoteOperation: dispatch,
    executeCollaborationRemoteOperationAction: executeAction,
    replayCollaborationRemoteOperationEvents: vi.fn().mockResolvedValue({
      executionAttemptId: "attempt-1",
      afterCursor: 0,
      cursor: 2,
      highWatermark: 2,
      hasMore: true,
      events: [
        { cursor: 1, kind: "agent_message", text: "remote hello" },
        { cursor: 2, kind: "tool_call", title: "edit", status: "completed" }
      ]
    }),
    listCollaborationRemoteOperationInteractions: vi.fn().mockImplementation(async () => {
      if (state.observationState !== "running") {
        return { items: [], nextCursor: null };
      }
      return {
        items: [
          {
            request: {
              type: "interaction.permission_requested",
              title: "Write",
              description: "Allow write",
              actionId: "ia-1",
              dispatchId: "dispatch-1",
              leaseId: "lease-1",
              executionAttemptId: "attempt-1",
              acpSessionId: "session-1",
              expiresAt: "2030-01-01T02:00:00.000Z"
            },
            operationId: "op-1",
            hostId: "host-1",
            status: "pending",
            createdAt: "2030-01-01T00:30:00.000Z"
          }
        ],
        nextCursor: null
      };
    }),
    settleCollaborationRemoteOperationInteraction: settle
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;

  return {
    api,
    emitStatus,
    emitSignal,
    listComments,
    listActivity,
    createComment,
    dispatch,
    executeAction,
    settle,
    updateAssignment
  };
}

const trackedApis: CollaborationReadBridgePort[] = [];

afterEach(() => {
  while (trackedApis.length > 0) {
    resetCollaborationReadModelHubForTests(trackedApis.pop());
  }
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("collaboration integration scenarios", () => {
  it("covers connect/join with stable selectors", async () => {
    const user = userEvent.setup();
    const { api } = createScenarioApi({
      observationState: "running",
      comments: [],
      activity: []
    });
    const invitationToken = `pw_inv_${"A".repeat(43)}`;
    const invitationHandoff = serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://planweave.example.ts.net/",
        allowedClientOrigins: ["https://planweave.example.ts.net/"],
        tlsTrust: "system_ca"
      },
      projectId: "project-1",
      invitationToken
    });

    const onConnected = vi.fn();
    render(
      <CollaborationConnectForm
        api={api}
        status={{
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
        }}
        t={t}
        onConnected={onConnected}
      />
    );

    expect(screen.getByTestId("people-connect-form")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-submit")).toHaveTextContent("Redeem setup code");
    await user.click(screen.getByTestId("people-connect-mode-join"));
    expect(screen.getByTestId("people-connect-submit")).toHaveTextContent("Join Workspace");
    await user.type(screen.getByTestId("people-connect-display-name"), "Ada");
    fireEvent.change(screen.getByTestId("people-connect-invitation-details"), {
      target: { value: invitationHandoff }
    });
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    const profileInput = vi.mocked(api.upsertCollaborationProfile).mock.calls[0]?.[0];
    expect(profileInput?.profileId).toBeTruthy();
    expect(profileInput).toEqual(
      expect.objectContaining({
        displayName: "Ada",
        serverBaseUrl: "https://planweave.example.ts.net/",
        projectId: "project-1",
        allowInsecureTransport: false,
        endpoint: expect.objectContaining({ topology: "private_https" })
      })
    );
    expect(api.consumeCollaborationInvitation).toHaveBeenCalledWith({
      profileId: profileInput?.profileId,
      request: { invitationToken, displayName: "Ada" }
    });
    expect(api.connectCollaborationSession).toHaveBeenCalledWith({
      profileId: profileInput?.profileId
    });
    expect(api.upsertCollaborationProfile.mock.invocationCallOrder[0]).toBeLessThan(
      api.consumeCollaborationInvitation.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(api.consumeCollaborationInvitation.mock.invocationCallOrder[0]).toBeLessThan(
      api.connectCollaborationSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(api.connectCollaborationSession.mock.invocationCallOrder[0]).toBeLessThan(
      onConnected.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("redeems a setup code without retaining it in renderer state", async () => {
    const user = userEvent.setup();
    const redeemCollaborationSetupCode = vi.fn().mockResolvedValue(undefined);
    const api = { redeemCollaborationSetupCode } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
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
        }}
        t={t}
      />
    );

    await user.click(screen.getByTestId("people-connect-setup-manual-toggle"));
    const setupCodeInput = screen.getByTestId("people-connect-setup-code");
    await user.clear(screen.getByTestId("people-connect-server-url"));
    await user.type(screen.getByTestId("people-connect-server-url"), "https://example.test");
    const setupCode = `pw_setup_${"A".repeat(43)}`;
    await user.type(setupCodeInput, setupCode);
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => {
      expect(redeemCollaborationSetupCode).toHaveBeenCalledWith(
        expect.objectContaining({ setupCode })
      );
    });
    expect(setupCodeInput).toHaveValue("");
  });

  it("does not send incomplete setup-code fields to the main process", async () => {
    const user = userEvent.setup();
    const redeemCollaborationSetupCode = vi.fn().mockRejectedValue(new Error("raw_ipc_error"));
    const api = { redeemCollaborationSetupCode } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
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
        }}
        t={t}
      />
    );

    await user.click(screen.getByTestId("people-connect-setup-manual-toggle"));
    await user.click(screen.getByTestId("people-connect-submit"));

    expect(redeemCollaborationSetupCode).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid server URL and setup code.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("raw_ipc_error");
  });

  it("covers members/Hosts and assignment-ready work surfaces", async () => {
    render(
      <PeoplePanel
        mode="ready"
        presence={{
          memberCount: 2,
          hostCount: 1,
          onlineHostCount: 1,
          avatarMembers: [
            { humanPrincipalId: "human-1", displayName: "Ada", initials: "AD" },
            { humanPrincipalId: "human-2", displayName: "Grace", initials: "GR" }
          ],
          sessionPhase: "connected",
          syncPhase: "ready",
          currentUserIsOwner: true,
          credentialPersistence: "persisted",
          nonPersistenceWarning: null
        }}
        members={[
          {
            membershipId: "m-1",
            humanPrincipalId: "human-1",
            displayName: "Ada",
            role: "owner",
            isCurrentUser: true,
            initials: "AD",
            actions: [
              { action: "promote", allowed: false, reason: "already_owner" },
              { action: "demote", allowed: false, reason: "last_owner" },
              { action: "remove", allowed: false, reason: "last_owner" }
            ]
          },
          {
            membershipId: "m-2",
            humanPrincipalId: "human-2",
            displayName: "Grace",
            role: "member",
            isCurrentUser: false,
            initials: "GR",
            actions: [
              { action: "promote", allowed: true, reason: "ok" },
              { action: "demote", allowed: false, reason: "already_member" },
              { action: "remove", allowed: true, reason: "ok" }
            ]
          }
        ]}
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

    expect(screen.getByTestId("people-panel")).toHaveAttribute("data-mode", "ready");
    expect(screen.getByTestId("people-members-section")).toBeInTheDocument();
    expect(screen.getAllByTestId("people-member-row")).toHaveLength(2);
    expect(screen.queryByTestId("people-hosts-section")).not.toBeInTheDocument();
  });

  it("covers comments, attachments, activity, and tab isolation from agent conversation", async () => {
    const user = userEvent.setup();
    const scenario = createScenarioApi({
      observationState: "running",
      comments: [
        { commentId: "comment-1", body: "Ship it", revision: 1, tombstoned: false },
        { commentId: "comment-0", body: "older", revision: 1, tombstoned: false }
      ],
      activity: [
        {
          activityId: "act-1",
          type: "comment_created",
          sourceKind: "comment",
          headline: "Ada commented"
        },
        {
          activityId: "act-2",
          type: "remote_run_started",
          sourceKind: "remote_run",
          headline: "Remote run started"
        }
      ]
    });
    trackedApis.push(scenario.api);
    const shell = acquireCollaborationReadModelController(scenario.api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    render(<WorkItemCollaborationPanel workItem={taskItem} open api={scenario.api} t={t} />);

    expect(screen.getByTestId("work-item-collaboration-panel")).toHaveAttribute(
      "data-work-item-kind",
      "task"
    );
    expect(screen.getByTestId("collaboration-human-notice")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-mode", "ready");
      expect(screen.getAllByTestId("comments-item").length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("comments-attachment")).toHaveTextContent("notes.txt");
    // Paths and raw tokens must never appear in attachment UI.
    expect(screen.getByTestId("comments-attachment").textContent).not.toMatch(/\/tmp|pw_hdev_/);

    await user.click(screen.getByTestId("collaboration-tab-activity"));
    await waitFor(() => {
      expect(screen.getByTestId("activity-panel")).toBeInTheDocument();
      expect(screen.getAllByTestId("activity-item").length).toBeGreaterThan(0);
    });
    const sources = screen.getAllByTestId("activity-source").map((node) => node.textContent);
    expect(sources.some((text) => /comment/i.test(text ?? ""))).toBe(true);
    expect(sources.some((text) => /remote/i.test(text ?? ""))).toBe(true);
    for (const item of screen.getAllByTestId("activity-item")) {
      expect(item).toHaveAttribute("data-interactive", "false");
    }

    await user.click(screen.getByTestId("collaboration-tab-comments"));
    await waitFor(() => expect(screen.getByTestId("comments-panel")).toBeInTheDocument());
    const composer = screen.getByTestId("comments-panel");
    // Compose is present on human comments only — never as agent conversation.
    expect(within(composer).queryByTestId("task-workspace-acp-conversation")).toBeNull();
  });

  it("handles observer catch-up after network interruption without per-node subscriptions", async () => {
    const scenario = createScenarioApi({
      observationState: "running",
      comments: [{ commentId: "comment-1", body: "before", revision: 1, tombstoned: false }],
      activity: [
        {
          activityId: "act-1",
          type: "comment_created",
          sourceKind: "comment",
          headline: "before catch-up"
        }
      ]
    });
    trackedApis.push(scenario.api);
    const first = acquireCollaborationReadModelController(scenario.api);
    const second = acquireCollaborationReadModelController(scenario.api);
    expect(second.controller).toBe(first.controller);

    await first.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const listActivity = scenario.api.listCollaborationActivity as ReturnType<typeof vi.fn>;
    const beforeCatchupCalls = listActivity.mock.calls.length;

    await act(async () => {
      scenario.emitSignal({
        type: "human.observer.catchup_required",
        profileId: "profile-1",
        projectId: "project-1",
        reason: exampleObserverCatchupRequired.reason,
        resumeCursor: exampleObserverCatchupRequired.resumeCursor,
        droppedThroughCursor: exampleObserverCatchupRequired.droppedThroughCursor
      });
    });

    await waitFor(() => {
      expect(listActivity.mock.calls.length).toBeGreaterThan(beforeCatchupCalls);
    });

    // Single shared controller remains the subscription authority.
    const third = acquireCollaborationReadModelController(scenario.api);
    expect(third.controller).toBe(first.controller);
    first.release();
    second.release();
    third.release();
  });

  it("keeps local Auto Run coexistence honest and does not merge authorities", async () => {
    const scenario = createScenarioApi({
      observationState: "running",
      comments: [],
      activity: []
    });
    trackedApis.push(scenario.api);
    const shell = acquireCollaborationReadModelController(scenario.api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    render(
      <RemoteRunPanel
        workItem={blockItem}
        runtimeRemoteExecution={{
          identity: { operationId: "op-1" },
          phase: "active",
          status: "owned",
          actionRequired: false,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        }}
        localAutoRunActive
        open
        api={scenario.api}
        t={t}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("remote-run-local-coexistence")).toBeInTheDocument();
      expect(screen.getByTestId("remote-run-panel")).toHaveAttribute(
        "data-authority",
        "remote_dispatch"
      );
    });
    // Remote notice must stay distinct from local Auto Run / agent conversation chrome.
    expect(screen.queryByTestId("auto-run-mini-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-workspace-acp-conversation")).not.toBeInTheDocument();
  });
});

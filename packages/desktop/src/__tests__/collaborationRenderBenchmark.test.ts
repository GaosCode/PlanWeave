/* @vitest-environment jsdom */

/**
 * Collaboration subscription / history-window performance audit.
 * Asserts structural bounds and on-demand loading (not wall-clock ms).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LIST_PAGE_DEFAULT,
  ACTIVITY_LIST_PAGE_MAX,
  COMMENT_LIST_PAGE_DEFAULT,
  COMMENT_LIST_PAGE_MAX
} from "@planweave-ai/collaboration-protocol/core/limits";
import { type HumanMembershipView } from "@planweave-ai/collaboration-protocol/identity/workspace";
import { type WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { adaptRemoteAcpEvents } from "../renderer/collaboration/remoteRunViewModels";
import { useActivityPanelController } from "../renderer/hooks/useActivityPanelController";
import { useCommentsPanelController } from "../renderer/hooks/useCommentsPanelController";
import { usePeoplePanelController } from "../renderer/hooks/usePeoplePanelController";
import { useRemoteRunPanelController } from "../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

/** Align with Task Workspace virtualization guidance: keep a product page well under 200 DOM rows. */
const VIRTUALIZATION_DOM_ROW_THRESHOLD = 200;
const REMOTE_EVENT_REPLAY_DEFAULT_LIMIT = 50;

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
};

const taskItem: WorkItemRef = { kind: "task", canvasId: "default", taskId: "T-1" };

function connectedStatus(): CollaborationStatus {
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

function membership(role: HumanMembershipView["role"]): HumanMembershipView {
  return {
    membershipId: `membership-${role}`,
    projectId: "project-1",
    humanPrincipalId: "human-1",
    displayName: "Demo",
    role,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}

function createAuditApi() {
  const listComments = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const listActivity = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const listMembers = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const listAssignments = vi.fn().mockResolvedValue({
    items: [
      {
        projectId: "project-1",
        workItem: blockItem,
        target: { kind: "exact_host", hostId: "host-1" },
        revision: 1,
        availability: { status: "ready", reason: "ready" },
        host: {
          hostId: "host-1",
          displayName: "Host",
          online: true,
          authorizedForProject: true,
          revoked: false,
          capabilitiesSatisfied: true
        }
      }
    ],
    nextCursor: null
  });
  const listInvitations = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const listDevices = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const revokeInvitation = vi.fn().mockResolvedValue(undefined);
  const revokeInvitations = vi.fn().mockResolvedValue({
    items: [
      { invitationId: "inv-1", revokedAt: "2030-01-01T00:00:00.000Z" },
      { invitationId: "inv-2", revokedAt: "2030-01-01T00:00:00.000Z" }
    ]
  });
  const observe = vi.fn().mockResolvedValue({
    operationId: "op-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-1#B-1",
    state: "running",
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:01:00.000Z",
    attempt: {
      executionAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      status: "running",
      hostId: "host-1",
      leaseId: "lease-1",
      stateVersion: 1
    },
    runtime: { ref: "T-1#B-1", status: "in_progress" }
  });
  const replay = vi.fn().mockResolvedValue({
    executionAttemptId: "attempt-1",
    afterCursor: 0,
    cursor: 2,
    highWatermark: 2,
    hasMore: false,
    events: [
      { cursor: 1, kind: "agent_message", text: "a" },
      { cursor: 2, kind: "agent_message", text: "b" }
    ]
  });
  const listInteractions = vi.fn().mockResolvedValue({ items: [], nextCursor: null });

  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus()),
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined),
    listCollaborationMembers: listMembers,
    listCollaborationAssignments: listAssignments,
    listCollaborationActivity: listActivity,
    listCollaborationComments: listComments,
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({ humans: [], hosts: [] }),
    getCollaborationWorkAuthority: vi.fn().mockResolvedValue({
      schemaVersion: "work-authority/v1",
      scope: {
        kind: "task",
        workspaceId: "w",
        projectId: "project-1",
        canvasId: "canvas-1",
        taskId: "T-1"
      },
      responsibility: {
        schemaVersion: "responsibility/v1",
        scope: {
          kind: "task",
          workspaceId: "w",
          projectId: "project-1",
          canvasId: "canvas-1",
          taskId: "T-1"
        },
        principal: null,
        revision: 0,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: "unassigned"
      },
      reviewer: {
        schemaVersion: "review-assignment/v1",
        scope: {
          kind: "task",
          workspaceId: "w",
          projectId: "project-1",
          canvasId: "canvas-1",
          taskId: "T-1"
        },
        principal: null,
        revision: 0,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: "unassigned"
      },
      executionTarget: null,
      revisions: {
        responsibilityRevision: 0,
        reviewerRevision: 0,
        executionTargetRevision: 0
      },
      selectedHost: null,
      evaluatedAt: "2030-01-01T00:00:00.000Z"
    }),
    updateCollaborationResponsibility: vi.fn(),
    updateCollaborationReviewer: vi.fn(),
    listCollaborationInvitations: listInvitations,
    listCollaborationDevices: listDevices,
    revokeCollaborationInvitation: revokeInvitation,
    revokeCollaborationInvitations: revokeInvitations,
    observeCollaborationRemoteOperation: observe,
    replayCollaborationRemoteOperationEvents: replay,
    listCollaborationRemoteOperationInteractions: listInteractions,
    dispatchCollaborationRemoteOperation: vi.fn(),
    executeCollaborationRemoteOperationAction: vi.fn(),
    settleCollaborationRemoteOperationInteraction: vi.fn(),
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn()
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;

  return {
    api,
    listComments,
    listActivity,
    listMembers,
    listAssignments,
    listInvitations,
    listDevices,
    revokeInvitation,
    revokeInvitations,
    observe,
    replay,
    listInteractions
  };
}

const trackedApis: CollaborationReadBridgePort[] = [];

afterEach(() => {
  while (trackedApis.length > 0) {
    resetCollaborationReadModelHubForTests(trackedApis.pop());
  }
  vi.restoreAllMocks();
});

describe("collaboration render / subscription audit", () => {
  it("documents page limits that keep collaboration histories under the virtualization threshold", () => {
    expect(COMMENT_LIST_PAGE_DEFAULT).toBe(20);
    expect(COMMENT_LIST_PAGE_MAX).toBe(50);
    expect(ACTIVITY_LIST_PAGE_DEFAULT).toBe(20);
    expect(ACTIVITY_LIST_PAGE_MAX).toBe(50);
    expect(COMMENT_LIST_PAGE_DEFAULT).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
    expect(COMMENT_LIST_PAGE_MAX).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
    expect(ACTIVITY_LIST_PAGE_MAX).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
    expect(REMOTE_EVENT_REPLAY_DEFAULT_LIMIT).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);

    // Reasonable continuous pagination: default 20 × 5 pages = 100 DOM rows (< 200).
    const continuousCommentRows = COMMENT_LIST_PAGE_DEFAULT * 5;
    const continuousActivityRows = ACTIVITY_LIST_PAGE_DEFAULT * 5;
    expect(continuousCommentRows).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
    expect(continuousActivityRows).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
  });

  it("shares one hub controller per bridge and does not open per-node controllers", () => {
    const { api } = createAuditApi();
    trackedApis.push(api);
    const first = acquireCollaborationReadModelController(api);
    const second = acquireCollaborationReadModelController(api);
    const third = acquireCollaborationReadModelController(api);
    expect(second.controller).toBe(first.controller);
    expect(third.controller).toBe(first.controller);
    first.release();
    second.release();
    third.release();
  });

  it("shell setActiveProject loads members/assignments/activity but not comments until tracked", async () => {
    const { api, listComments, listActivity, listMembers, listAssignments } = createAuditApi();
    trackedApis.push(api);
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });
    expect(listMembers).toHaveBeenCalled();
    expect(listAssignments).toHaveBeenCalled();
    expect(listActivity).toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    shell.release();
  });

  it("does not fetch comment/activity/remote deep diagnostics when panels are closed", async () => {
    const { api, listComments, listActivity, observe, replay, listInteractions } = createAuditApi();
    trackedApis.push(api);
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });
    listActivity.mockClear();

    renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: false,
        api,
        t: createTranslator("en")
      })
    );
    renderHook(() =>
      useActivityPanelController({
        workItem: taskItem,
        open: false,
        api,
        t: createTranslator("en")
      })
    );
    renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: {
          identity: { operationId: "op-1" },
          phase: "active",
          status: "owned",
          actionRequired: false,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        },
        open: false,
        api,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(listComments).not.toHaveBeenCalled();
    // Activity may still be warmed by the shell hub; panel-specific work-item activity stays closed.
    expect(listActivity.mock.calls.every((call) => call[0]?.workItem == null)).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(listInteractions).not.toHaveBeenCalled();
    shell.release();
  });

  it("loads remote observation only after the panel opens", async () => {
    const { api, observe, replay } = createAuditApi();
    trackedApis.push(api);
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useRemoteRunPanelController({
          workItem: blockItem,
          runtimeRemoteExecution: {
            identity: { operationId: "op-1" },
            phase: "active",
            status: "owned",
            actionRequired: false,
            source: { revision: "rev-1", graphFingerprint: "fp-1" },
            dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
          },
          open,
          api,
          t: createTranslator("en")
        }),
      { initialProps: { open: false } }
    );

    expect(observe).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => {
      expect(observe).toHaveBeenCalledWith({ operationId: "op-1" });
      expect(result.current.viewModel.identity?.operationId).toBe("op-1");
    });
    expect(replay).toHaveBeenCalled();
    shell.release();
  });

  it("loads people invitation/device details only when detailsOpen", async () => {
    const { api, listInvitations, listDevices, listMembers } = createAuditApi();
    trackedApis.push(api);

    const { rerender } = renderHook(
      ({ detailsOpen }: { detailsOpen: boolean }) =>
        usePeoplePanelController({
          api,
          status: connectedStatus(),
          members: [membership("owner")],
          hosts: [],
          syncPhase: "ready",
          detailsOpen
        }),
      { initialProps: { detailsOpen: false } }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(listInvitations).not.toHaveBeenCalled();
    expect(listDevices).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();

    rerender({ detailsOpen: true });
    await waitFor(() => {
      expect(listInvitations).toHaveBeenCalledWith({ cursor: 0, limit: 100, openOnly: true });
      expect(listDevices).toHaveBeenCalledWith({ cursor: 0, limit: 50, scope: "project" });
      expect(listMembers).toHaveBeenCalledWith({ cursor: 0, limit: 100 });
    });
  });

  it("loads workspace members from the identity API when the observer list is empty", async () => {
    const { api, listMembers } = createAuditApi();
    trackedApis.push(api);
    listMembers.mockResolvedValue({
      items: [membership("owner")],
      nextCursor: null
    });

    const { result } = renderHook(() =>
      usePeoplePanelController({
        api,
        status: connectedStatus(),
        members: [],
        hosts: [],
        syncPhase: "ready",
        detailsOpen: true
      })
    );

    await waitFor(() => expect(result.current.members).toHaveLength(1));
    expect(result.current.members[0]?.role).toBe("owner");
    expect(result.current.presence.currentUserIsOwner).toBe(true);
    expect(result.current.mode).toBe("ready");
    expect(listMembers).toHaveBeenCalledWith({ cursor: 0, limit: 100 });
  });

  it("loads only the current member devices for an ordinary member", async () => {
    const { api, listInvitations, listDevices } = createAuditApi();
    trackedApis.push(api);

    renderHook(() =>
      usePeoplePanelController({
        api,
        status: connectedStatus(),
        members: [membership("member")],
        hosts: [],
        syncPhase: "ready",
        detailsOpen: true
      })
    );

    await waitFor(() => {
      expect(listDevices).toHaveBeenCalledWith({ cursor: 0, limit: 50, scope: "own" });
    });

    expect(listInvitations).not.toHaveBeenCalled();
  });

  it("does not reload invitation/device details for read-model phase transitions", async () => {
    const { api, listInvitations, listDevices, listMembers } = createAuditApi();
    trackedApis.push(api);

    const { rerender } = renderHook(
      ({ syncPhase }: { syncPhase: CollaborationSyncPhase }) =>
        usePeoplePanelController({
          api,
          status: connectedStatus(),
          members: [membership("owner")],
          hosts: [],
          syncPhase,
          detailsOpen: true
        }),
      { initialProps: { syncPhase: "idle" as CollaborationSyncPhase } }
    );

    await waitFor(() => expect(listInvitations).toHaveBeenCalledTimes(1));
    rerender({ syncPhase: "loading" });
    rerender({ syncPhase: "ready" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(listInvitations).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it("keeps the last invitation details visible when a refresh is rate-limited", async () => {
    const { api, listInvitations } = createAuditApi();
    trackedApis.push(api);
    listInvitations.mockResolvedValueOnce({
      items: [
        {
          invitationId: "inv-keep",
          projectId: "project-1",
          role: "member",
          createdByHumanPrincipalId: "human-1",
          createdAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-02T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });

    const { result } = renderHook(() =>
      usePeoplePanelController({
        api,
        status: connectedStatus(),
        members: [membership("owner")],
        hosts: [],
        syncPhase: "ready",
        detailsOpen: true
      })
    );
    await waitFor(() => expect(result.current.invitations).toHaveLength(1));

    listInvitations.mockRejectedValueOnce({
      kind: "rate_limited",
      code: "human_rate_limited",
      message: "Too many collaboration requests. Try again shortly.",
      httpStatus: 429,
      retryAfterMs: 2_000,
      retryable: true
    });
    await act(async () => {
      await result.current.refreshDetails();
    });

    expect(result.current.detailsError).toContain("human_rate_limited");
    expect(result.current.invitations).toHaveLength(1);
    expect(result.current.invitations[0]?.invitationId).toBe("inv-keep");
  });

  it("revokes every selected invitation in one request without a rate-limited follow-up read", async () => {
    const { api, listInvitations, revokeInvitation, revokeInvitations } = createAuditApi();
    trackedApis.push(api);

    const { result } = renderHook(() =>
      usePeoplePanelController({
        api,
        status: connectedStatus(),
        members: [membership("owner")],
        hosts: [],
        syncPhase: "ready",
        detailsOpen: true
      })
    );

    await waitFor(() => expect(listInvitations).toHaveBeenCalledTimes(1));
    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.revokeInvitations(["inv-1", "inv-2"]);
    });

    expect(succeeded).toBe(true);
    expect(revokeInvitations).toHaveBeenCalledOnce();
    expect(revokeInvitations).toHaveBeenCalledWith({ invitationIds: ["inv-1", "inv-2"] });
    expect(revokeInvitation).not.toHaveBeenCalled();
    expect(listInvitations).toHaveBeenCalledTimes(1);
    expect(result.current.actionError).toBeNull();
  });

  it("bounds event-burst projection by unique cursor after duplicate/out-of-order delivery", () => {
    const burst = Array.from({ length: 500 }, (_, index) => ({
      cursor: (index % 40) + 1,
      kind: "agent_message" as const,
      text: `event-${index}`
    }));
    // Shuffle-like out-of-order: reverse half.
    const shuffled = [...burst.slice(0, 250).reverse(), ...burst.slice(250)];
    const adapted = adaptRemoteAcpEvents(shuffled);
    expect(adapted.length).toBeLessThanOrEqual(40);
    expect(adapted.map((event) => event.cursor)).toEqual(
      Array.from({ length: adapted.length }, (_, index) => index + 1)
    );
    expect(adapted.length).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
  });

  it("keeps multi-page comment/activity windows under the product threshold", () => {
    const pages = 4;
    const commentDomRows = COMMENT_LIST_PAGE_DEFAULT * pages;
    const activityDomRows = ACTIVITY_LIST_PAGE_DEFAULT * pages;
    expect(commentDomRows).toBe(80);
    expect(activityDomRows).toBe(80);
    expect(commentDomRows + activityDomRows).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
  });
});

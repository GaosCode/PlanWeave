import {
  collaborationOperationScopeFixture,
  scopedProjectFixture
} from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { createTranslator } from "../renderer/i18n";
import { ActivityPanel } from "../renderer/team/ActivityPanel";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { CommentsPanel } from "../renderer/team/CommentsPanel";
import { PeoplePanel } from "../renderer/team/PeoplePanel";
import { RemoteRunPanel } from "../renderer/team/RemoteRunPanel";
import { WorkItemCollaborationPanel } from "../renderer/team/WorkItemCollaborationPanel";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

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
      operationScope: collaborationOperationScopeFixture(),
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

function createConnectedApi() {
  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus()),
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined),
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
            displayName: "Host",
            online: true,
            authorizedForProject: true,
            revoked: false,
            capabilitiesSatisfied: true
          }
        }
      ],
      nextCursor: null
    }),
    listCollaborationActivity: vi.fn().mockResolvedValue({
      items: [
        {
          activityId: "act-1",
          projectId: "project-1",
          type: "comment_created",
          source: { kind: "comment", sourceId: "comment-1" },
          summary: { headline: "Ada commented", commentId: "comment-1", workItem: taskItem },
          subjects: [{ kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }],
          workItem: taskItem,
          occurredAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      nextCursor: null
    }),
    listCollaborationComments: vi.fn().mockResolvedValue({
      items: [
        {
          commentId: "comment-1",
          projectId: "project-1",
          workItem: taskItem,
          author: {
            humanPrincipalId: "human-1",
            displayName: "Ada",
            membershipActive: true
          },
          body: "hello",
          bodyFormat: "markdown",
          revision: 1,
          createdAt: "2030-01-01T00:00:01.000Z",
          updatedAt: "2030-01-01T00:00:01.000Z",
          tombstoned: false,
          attachments: [],
          workItemPresence: "present"
        }
      ],
      nextCursor: null
    }),
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({ humans: [], hosts: [] }),
    observeCollaborationRemoteOperation: vi.fn().mockResolvedValue({
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
    }),
    replayCollaborationRemoteOperationEvents: vi.fn().mockResolvedValue({
      executionAttemptId: "attempt-1",
      afterCursor: 0,
      cursor: 1,
      highWatermark: 1,
      hasMore: false,
      events: [{ cursor: 1, kind: "agent_message", text: "remote" }]
    }),
    listCollaborationRemoteOperationInteractions: vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null
    }),
    dispatchCollaborationRemoteOperation: vi.fn(),
    executeCollaborationRemoteOperationAction: vi.fn(),
    settleCollaborationRemoteOperationInteraction: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    updateCollaborationAssignment: vi.fn()
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;
  return api;
}

const trackedApis: CollaborationReadBridgePort[] = [];

afterEach(() => {
  while (trackedApis.length > 0) {
    resetCollaborationReadModelHubForTests(trackedApis.pop());
  }
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("collaboration accessibility", () => {
  it("exposes live regions and labeled surfaces for comments, activity, people, and remote run", async () => {
    const api = createConnectedApi();
    trackedApis.push(api);
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-1",
        projectId: "project-1",
        canvasId: "default"
      })
    );

    render(
      <>
        <CommentsPanel
          editScope={{}}
          mode="ready"
          rows={[]}
          draft={{ body: "", showPreview: false }}
          stagedAttachments={[]}
          loading={false}
          loadingMore={false}
          hasMore={false}
          submitting={false}
          actionError="offline"
          canCompose={false}
          t={t}
          onDraftBodyChange={vi.fn()}
          onShowPreviewChange={vi.fn()}
          onLoadMore={vi.fn()}
          onRefresh={vi.fn()}
          onSubmit={vi.fn()}
          onEdit={vi.fn()}
          onTombstone={vi.fn()}
          onReadAttachment={vi.fn()}
          onDownloadPendingAttachment={vi.fn().mockResolvedValue(undefined)}
          downloadingAttachments={[]}
          onStageFiles={vi.fn()}
          onCancelAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
        />
        <ActivityPanel
          mode="ready"
          rows={[]}
          loading={false}
          loadingMore={false}
          hasMore={false}
          actionError="retry needed"
          t={t}
          onLoadMore={vi.fn()}
          onRefresh={vi.fn()}
        />
        <PeoplePanel
          mode="ready"
          presence={{
            memberCount: 1,
            hostCount: 0,
            onlineHostCount: 0,
            avatarMembers: [{ humanPrincipalId: "human-1", displayName: "Ada", initials: "AD" }],
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
            }
          ]}
          invitations={[]}
          devices={[]}
          detailsLoading={false}
          detailsError={null}
          actionError="member action failed"
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
          open
          api={api}
          t={t}
        />
      </>
    );

    expect(screen.getByTestId("comments-panel")).toHaveAttribute("aria-label", t("commentsTitle"));
    expect(screen.getByTestId("comments-live-region")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("comments-live-region")).toHaveTextContent("offline");

    expect(screen.getByTestId("activity-panel")).toHaveAttribute("aria-label", t("activityTitle"));
    expect(screen.getByTestId("activity-live-region")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("activity-live-region")).toHaveTextContent("retry needed");

    expect(screen.getByTestId("people-live-region")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("people-live-region")).toHaveTextContent("member action failed");

    await waitFor(() => {
      expect(screen.getByTestId("remote-run-panel")).toBeInTheDocument();
    });
    expect(screen.getByTestId("remote-run-panel")).toHaveAttribute(
      "aria-label",
      t("remoteRunTitle")
    );
    expect(screen.getByTestId("remote-run-live-region")).toHaveAttribute("aria-live", "polite");
  });

  it("supports keyboard tab traversal between comments and activity without relying on Chinese copy", async () => {
    const user = userEvent.setup();
    const api = createConnectedApi();
    trackedApis.push(api);
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-1",
        projectId: "project-1",
        canvasId: "default"
      })
    );

    render(<WorkItemCollaborationPanel workItem={taskItem} open api={api} t={t} />);

    const tablist = screen.getByRole("tablist");
    expect(tablist).toBeInTheDocument();
    const commentsTab = screen.getByTestId("collaboration-tab-comments");
    const activityTab = screen.getByTestId("collaboration-tab-activity");
    expect(commentsTab).toHaveAttribute("role", "tab");
    expect(activityTab).toHaveAttribute("role", "tab");
    expect(commentsTab).toHaveAttribute("aria-selected", "true");

    activityTab.focus();
    expect(activityTab).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(activityTab).toHaveAttribute("aria-selected", "true");
    expect(commentsTab).toHaveAttribute("aria-selected", "false");
    await waitFor(() => {
      expect(screen.getByTestId("activity-panel")).toBeInTheDocument();
    });

    await user.click(commentsTab);
    expect(commentsTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => {
      expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
    });
  });

  it("keeps activity rows non-interactive and labeled by source kind", () => {
    render(
      <ActivityPanel
        mode="ready"
        rows={[
          {
            activityId: "act-1",
            type: "comment_created",
            sourceKind: "comment",
            sourceLabelKey: "activitySourceComment",
            headline: "Ada commented",
            occurredAt: "2030-01-01T00:00:01.000Z",
            workItemLabel: "task T-1",
            interactive: false
          }
        ]}
        loading={false}
        loadingMore={false}
        hasMore={false}
        actionError={null}
        t={t}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    const item = screen.getByTestId("activity-item");
    expect(item).toHaveAttribute("data-interactive", "false");
    expect(item).toHaveAttribute("data-source-kind", "comment");
    expect(within(item).queryByRole("button")).toBeNull();
  });

  it("labels connect form fields with stable test ids for smoke and assistive tech", async () => {
    const user = userEvent.setup();
    const api = {
      upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
      consumeCollaborationInvitation: vi.fn().mockResolvedValue({
        deviceCredentialPersistence: "persisted",
        nonPersistenceWarning: null
      }),
      connectCollaborationSession: vi.fn().mockResolvedValue(undefined),
      bootstrapCollaborationOwner: vi.fn(),
      setActiveCollaborationProfile: vi.fn()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
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

    expect(screen.getByTestId("people-connect-form")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-setup-details")).toHaveAccessibleName(
      "Complete Server connection details"
    );
    expect(screen.queryByTestId("people-connect-setup-code")).not.toBeInTheDocument();
    const advancedSetupToggle = screen.getByTestId("people-connect-setup-manual-toggle");
    expect(advancedSetupToggle).toHaveAttribute("aria-expanded", "false");
    await user.click(advancedSetupToggle);
    expect(advancedSetupToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("people-connect-setup-code")).toHaveAccessibleName("Setup code");
    expect(screen.getByTestId("people-connect-mode-setup")).toHaveTextContent(
      "Connect Server deployment"
    );
    await user.click(screen.getByTestId("people-connect-mode-join"));
    expect(screen.getByTestId("people-connect-display-name")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-server-url")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-project-id")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-invitation-token")).toBeInTheDocument();

    const advancedModeToggle = screen.getByTestId("people-connect-advanced-toggle");
    expect(advancedModeToggle).toHaveClass("list-none");
    expect(advancedModeToggle.querySelector("svg")).toBeInTheDocument();
    await user.click(advancedModeToggle);
    expect(screen.getByTestId("people-connect-advanced-modes")).toHaveAttribute("open");
    expect(screen.queryByTestId("people-connect-mode-connect")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("people-connect-mode-bootstrap"));
    expect(screen.queryByTestId("people-connect-invitation-token")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("people-connect-mode-join"));
    expect(screen.getByTestId("people-connect-invitation-token")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-advanced-modes")).not.toHaveAttribute("open");
  });

  it("does not introduce unbounded motion classes on collaboration surfaces", () => {
    const { container } = render(
      <CommentsPanel
        editScope={{}}
        mode="ready"
        rows={[]}
        draft={{ body: "", showPreview: false }}
        stagedAttachments={[]}
        loading={false}
        loadingMore={false}
        hasMore={false}
        submitting={false}
        actionError={null}
        canCompose
        t={t}
        onDraftBodyChange={vi.fn()}
        onShowPreviewChange={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        onSubmit={vi.fn()}
        onEdit={vi.fn()}
        onTombstone={vi.fn()}
        onReadAttachment={vi.fn()}
        onDownloadPendingAttachment={vi.fn().mockResolvedValue(undefined)}
        downloadingAttachments={[]}
        onStageFiles={vi.fn()}
        onCancelAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
      />
    );
    // Collaboration panels are static lists; any animate-* without motion-reduce would risk CLS/noise.
    const animated = container.querySelectorAll("[class*='animate-']");
    for (const node of animated) {
      expect(node.className).toMatch(/motion-reduce/);
    }
  });
});

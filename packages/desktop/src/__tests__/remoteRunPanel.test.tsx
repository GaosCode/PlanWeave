/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { createTranslator } from "../renderer/i18n";
import { RemoteRunPanel } from "../renderer/team/RemoteRunPanel";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
};

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

function createApi(executionTarget: "exact_host" | "unassigned" = "exact_host") {
  const status = connectedStatus();
  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(status),
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined),
    listCollaborationMembers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
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
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({ humans: [], hosts: [] }),
    getCollaborationWorkAuthority: vi.fn().mockResolvedValue({
      schemaVersion: "work-authority/v1",
      scope: {
        kind: "block",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-1#B-1"
      },
      responsibility: {
        schemaVersion: "responsibility/v1",
        scope: {
          kind: "block",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-1#B-1"
        },
        principal: null,
        revision: 0,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: "unassigned"
      },
      reviewer: {
        schemaVersion: "review-assignment/v1",
        scope: {
          kind: "block",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-1#B-1"
        },
        principal: null,
        revision: 0,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: "unassigned"
      },
      executionTarget: {
        schemaVersion: "execution-target/v1",
        scope: {
          kind: "block",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-1#B-1"
        },
        target:
          executionTarget === "exact_host"
            ? { kind: "exact_host", hostId: "private-host-id" }
            : { kind: "unassigned" },
        revision: 1,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability:
          executionTarget === "exact_host"
            ? { status: "ready", reason: "ready" }
            : { status: "unassigned", reason: "unassigned" }
      },
      revisions: {
        responsibilityRevision: 0,
        reviewerRevision: 0,
        executionTargetRevision: 1
      }
    }),
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
        leaseId: "lease-1",
        stateVersion: 1
      },
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1",
        endpointId: "endpoint-vps",
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        hostDisplayName: "Build Mac",
        capabilities: ["acp.codex"],
        status: "available",
        resolvedAt: "2030-01-01T00:00:00.000Z"
      },
      runtime: { ref: "T-1#B-1", status: "in_progress" }
    }),
    dispatchCollaborationRemoteOperation: vi.fn(),
    executeCollaborationRemoteOperationAction: vi.fn(),
    replayCollaborationRemoteOperationEvents: vi.fn().mockResolvedValue({
      eventProtocolVersion: 1,
      executionAttemptId: "attempt-1",
      afterCursor: 0,
      cursor: 1,
      highWatermark: 1,
      hasMore: false,
      events: [{ cursor: 1, kind: "agent_message", text: "remote hello" }],
      diagnostics: []
    }),
    listCollaborationRemoteOperationInteractions: vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null
    }),
    settleCollaborationRemoteOperationInteraction: vi.fn()
  } as unknown as PlanWeaveCollaborationApi;
  return api;
}

const apis: CollaborationReadBridgePort[] = [];

afterEach(() => {
  while (apis.length > 0) {
    resetCollaborationReadModelHubForTests(apis.pop());
  }
});

describe("RemoteRunPanel", () => {
  it("renders remote identity, events, and the unified Agent Endpoint guidance", async () => {
    const api = createApi();
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
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
        open
        api={api}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("remote-run-panel")).toHaveAttribute(
      "data-authority",
      "remote_dispatch"
    );
    await waitFor(() => {
      expect(screen.getByTestId("remote-run-identity")).toBeInTheDocument();
      expect(screen.getByText("op-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("remote-run-events")).toBeInTheDocument();
    expect(screen.getByText(/remote hello/)).toBeInTheDocument();
    expect(screen.getByTestId("remote-run-event")).toHaveAttribute(
      "data-event-protocol-version",
      "1"
    );
    expect(screen.getByTestId("remote-run-event")).toHaveAttribute(
      "data-execution-attempt-id",
      "attempt-1"
    );
    expect(screen.getByText("Codex — Build Mac")).toBeInTheDocument();
    expect(screen.queryByText("host-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-run-notice")).toHaveTextContent(
      /compatible local or remote Agent Endpoint/i
    );
    expect(screen.getByTestId("remote-run-legacy-host-target-notice")).toHaveTextContent(
      "Legacy Host run settings are now read-only. Choose this device or a remote Agent."
    );
    expect(screen.queryByText("private-host-id")).not.toBeInTheDocument();
  });

  it("renders v2 Runner and engine evidence from the shared projection", async () => {
    const api = createApi();
    const observe = api.observeCollaborationRemoteOperation as ReturnType<typeof vi.fn>;
    const v2Observation = await observe();
    observe.mockResolvedValue({
      ...v2Observation,
      executionAttemptId: "attempt-v2",
      attempt: {
        ...v2Observation.attempt,
        executionAttemptId: "attempt-v2"
      }
    });
    observe.mockClear();
    const replay = api.replayCollaborationRemoteOperationEvents as ReturnType<typeof vi.fn>;
    replay.mockResolvedValue({
      eventProtocolVersion: 2,
      executionAttemptId: "attempt-v2",
      afterCursor: 0,
      cursor: 2,
      highWatermark: 2,
      hasMore: false,
      diagnostics: [{ code: "remote_acp_event_retention_gap", droppedThroughCursor: 7 }],
      events: [
        {
          eventVersion: 2,
          cursor: 1,
          sourceSequence: 51,
          timestamp: "2030-01-01T00:00:01.000Z",
          fragment: {
            kind: "runner_body",
            body: {
              kind: "message",
              role: "assistant",
              messageId: "message-v2",
              chunk: false,
              content: "projected v2",
              redaction: { classes: [], replaced: 0 }
            }
          }
        },
        {
          eventVersion: 2,
          cursor: 2,
          sourceSequence: 52,
          timestamp: "2030-01-01T00:00:02.000Z",
          fragment: {
            kind: "engine_evidence",
            evidence: {
              kind: "usage_snapshot",
              usage: {
                semantics: "cumulative_session_total",
                totalTokens: 21,
                inputTokens: 13,
                outputTokens: 8,
                thoughtTokens: null,
                cachedReadTokens: null,
                cachedWriteTokens: null
              }
            }
          }
        }
      ]
    });
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
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
        open
        api={api}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(screen.getAllByTestId("remote-run-event")).toHaveLength(2));
    expect(screen.getByText(/projected v2/)).toBeInTheDocument();
    expect(screen.getByText(/Remote cumulative token usage: 21/)).toBeInTheDocument();
    expect(screen.getAllByTestId("remote-run-event")[1]).toHaveAttribute(
      "data-event-protocol-version",
      "2"
    );
    expect(screen.getAllByTestId("remote-run-event")[1]).toHaveAttribute(
      "data-event-source-sequence",
      "52"
    );
    expect(screen.getAllByTestId("remote-run-event")[1]).toHaveAttribute(
      "data-event-timestamp",
      "2030-01-01T00:00:02.000Z"
    );
  });

  it("does not show a migration notice for an unassigned legacy target", async () => {
    const api = createApi("unassigned");
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });
    render(<RemoteRunPanel workItem={blockItem} open api={api} t={createTranslator("en")} />);
    await waitFor(() => expect(api.getCollaborationWorkAuthority).toHaveBeenCalled());
    expect(screen.queryByTestId("remote-run-legacy-host-target-notice")).not.toBeInTheDocument();
  });

  it("requires confirmation before cancel", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
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
        open
        api={api}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("remote-run-action-cancel")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("remote-run-action-cancel"));
    expect(screen.getByTestId("remote-run-confirm")).toBeInTheDocument();
    expect(api.executeCollaborationRemoteOperationAction).not.toHaveBeenCalled();
  });

  it("announces local Auto Run coexistence without merging status", async () => {
    const api = createApi();
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
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
        api={api}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("remote-run-local-coexistence")).toBeInTheDocument();
  });

  it("submits only human resume intent while the Server owns recovery identities", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const observe = api.observeCollaborationRemoteOperation as ReturnType<typeof vi.fn>;
    const executeAction = api.executeCollaborationRemoteOperationAction as ReturnType<typeof vi.fn>;
    observe.mockResolvedValue({
      operationId: "op-1",
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-1#B-1",
      state: "interrupted",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "interrupted",
        hostId: "host-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2030-01-01T01:00:00.000Z",
        stateVersion: 2
      },
      runtime: {
        ref: "T-1#B-1",
        status: "interrupted",
        interruption: {
          reason: "transport_lost",
          resumable: true,
          recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
        }
      }
    });
    executeAction.mockResolvedValue({ request: { kind: "resume_same_session" }, state: "settled" });
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
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
          status: "interrupted",
          actionRequired: true,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        }}
        open
        api={api}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("remote-run-action-resume_same_session")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("remote-run-action-resume_same_session"));
    await waitFor(() => {
      expect(executeAction).toHaveBeenCalled();
    });
    const action = executeAction.mock.calls[0]?.[0]?.action as {
      kind: string;
      priorLeaseId: string;
      leaseId?: string;
      recovery?: { acpSessionId: string; recoveryId: string };
    };
    expect(action.kind).toBe("resume_same_session");
    expect(action.priorLeaseId).toBe("lease-1");
    expect(action).not.toHaveProperty("leaseId");
    expect(action).not.toHaveProperty("recovery");
  });
});

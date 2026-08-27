/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { eligibleHostBatchResponseSchema } from "@planweave-ai/collaboration-protocol/work/assignment";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { toCollaborationReadBridge } from "../renderer/collaboration/collaborationReadBridge";
import { useRemoteRunPanelController } from "../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
};

const activeRuntimeExecution = {
  identity: { operationId: "op-1" },
  phase: "active",
  status: "owned",
  actionRequired: false,
  source: { revision: "rev-1", graphFingerprint: "fp-1" },
  dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
} as const;

const availableLocalEndpoint = {
  executorName: "codex-acp",
  displayName: "Codex",
  locationName: "This device",
  capabilities: ["acp.codex"],
  available: true,
  unavailableReason: null
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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
      status: "connected",
      profile: {
        schemaVersion: "workspace-setup/v1",
        profileId: "workspace-profile-1",
        displayName: "Workspace Demo",
        serverBaseUrl: "https://example.test",
        workspaceId: "workspace-1",
        allowInsecureTransport: false
      },
      workspaceId: "workspace-1",
      workspaceDisplayName: "Workspace Demo",
      connectedAt: "2030-01-01T00:00:00.000Z",
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function observation(state: "running" | "interrupted" | "completed" = "running") {
  return {
    operationId: "op-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-1#B-1",
    state,
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:01:00.000Z",
    attempt: {
      executionAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      status: state === "running" ? ("running" as const) : (state as "interrupted" | "completed"),
      hostId: "host-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2030-01-01T01:00:00.000Z",
      stateVersion: 2
    },
    dispatchStatus: state === "running" ? ("running" as const) : undefined,
    runtime: {
      ref: "T-1#B-1",
      status: state === "completed" ? "completed" : "in_progress",
      interruption:
        state === "interrupted"
          ? {
              reason: "transport_lost",
              resumable: true,
              recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
            }
          : undefined
    }
  };
}

function createApi() {
  const status = connectedStatus();
  const observe = vi.fn().mockResolvedValue(observation("running"));
  const dispatch = vi.fn().mockResolvedValue(observation("running"));
  const executeAction = vi.fn().mockResolvedValue({
    request: {
      kind: "cancel",
      actionId: "a1",
      operationId: "op-1",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      expectedAttemptVersion: 2,
      leaseId: "lease-1",
      reason: "stop"
    },
    state: "recorded",
    createdAt: "2030-01-01T00:02:00.000Z"
  });
  const replay = vi.fn().mockResolvedValue({
    executionAttemptId: "attempt-1",
    afterCursor: 0,
    cursor: 2,
    highWatermark: 2,
    hasMore: false,
    events: [
      { cursor: 1, kind: "agent_message", text: "hello" },
      { cursor: 2, kind: "tool_call", title: "edit", status: "completed" }
    ]
  });
  const listInteractions = vi.fn().mockResolvedValue({
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
  });
  const settle = vi
    .fn()
    .mockImplementation(async (input: { settlement: { actionId: string } }) => ({
      request: {
        type: "interaction.permission_requested",
        title: "Write",
        description: "Allow write",
        actionId: input.settlement.actionId,
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
    }));
  const listAgentEndpoints = vi.fn().mockResolvedValue({
    schemaVersion: "agent-endpoint-list/v1",
    items: [
      {
        schemaVersion: "agent-endpoint/v1",
        endpointId: "endpoint-vps",
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        hostDisplayName: "VPS",
        status: "available",
        capabilities: ["acp.codex"]
      }
    ]
  });

  const api = {
    upsertCollaborationProfile: vi.fn(),
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
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({
      humans: [],
      hosts: []
    }),
    getCollaborationWorkAuthority: vi.fn().mockResolvedValue({
      schemaVersion: "work-authority/v1",
      scope: {
        kind: "block",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-1#B-001"
      },
      responsibility: {
        schemaVersion: "responsibility/v1",
        scope: {
          kind: "block",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-1#B-001"
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
          blockRef: "T-1#B-001"
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
          blockRef: "T-1#B-001"
        },
        target: { kind: "exact_host", hostId: "host-1" },
        revision: 1,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: { status: "ready", reason: "ready" }
      },
      revisions: {
        responsibilityRevision: 0,
        reviewerRevision: 0,
        executionTargetRevision: 1
      },
      selectedHost: {
        hostId: "host-1",
        availabilityReason: "ready",
        lease: { status: "none", leaseId: null, expiresAt: null },
        authorization: {
          schemaVersion: "host-authorization/v1",
          scope: {
            kind: "block",
            workspaceId: "workspace-1",
            projectId: "project-1",
            canvasId: "default",
            blockRef: "T-1#B-001"
          },
          hostId: "host-1",
          decision: "deny",
          reason: "lease_missing",
          currentRevisions: {
            responsibilityRevision: 0,
            reviewerRevision: 0,
            executionTargetRevision: 1
          },
          evaluatedAt: "2030-01-01T00:00:00.000Z"
        }
      },
      evaluatedAt: "2030-01-01T00:00:00.000Z"
    }),
    updateCollaborationResponsibility: vi.fn(),
    updateCollaborationReviewer: vi.fn(),
    listCollaborationAgentEndpoints: listAgentEndpoints,
    observeCollaborationRemoteOperation: observe,
    dispatchCollaborationRemoteOperation: dispatch,
    executeCollaborationRemoteOperationAction: executeAction,
    replayCollaborationRemoteOperationEvents: replay,
    listCollaborationRemoteOperationInteractions: listInteractions,
    settleCollaborationRemoteOperationInteraction: settle,
    listCollaborationEligibleHostsBatch: vi.fn(async ({ workItems }) =>
      eligibleHostBatchResponseSchema.parse({
        items: workItems.map((workItem, index) => ({ index, workItem, hostIds: [] })),
        hosts: []
      })
    )
  } as PlanWeaveCollaborationApi;

  return {
    api,
    observe,
    dispatch,
    executeAction,
    replay,
    listInteractions,
    settle,
    listAgentEndpoints
  };
}

const apis: CollaborationReadBridgePort[] = [];

function readBridge(api: PlanWeaveCollaborationApi): CollaborationReadBridgePort {
  const bridge = toCollaborationReadBridge(api);
  if (!bridge) throw new Error("collaboration_read_bridge_missing");
  return bridge;
}

afterEach(() => {
  while (apis.length > 0) {
    resetCollaborationReadModelHubForTests(apis.pop());
  }
});

describe("useRemoteRunPanelController", () => {
  it("loads observation, events, and interactions when open", async () => {
    const { api, observe, replay, listInteractions } = createApi();
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: activeRuntimeExecution,
        open: true,
        api,
        t: createTranslator("en"),
        createId: () => "id-fixed"
      })
    );

    await waitFor(() => {
      expect(observe).toHaveBeenCalledWith({ operationId: "op-1" });
      expect(result.current.viewModel.identity?.operationId).toBe("op-1");
    });
    expect(replay).toHaveBeenCalled();
    expect(listInteractions).toHaveBeenCalled();
    expect(result.current.viewModel.events).toHaveLength(2);
    expect(result.current.viewModel.pendingInteractions).toHaveLength(1);
    expect(result.current.viewModel.authority).toBe("remote_dispatch");
  });

  it("dispatches and cancels through the mock bridge", async () => {
    const { api, dispatch, executeAction, observe } = createApi();
    observe.mockResolvedValueOnce(observation("running"));
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        agentEndpoints: [
          {
            id: "remote:endpoint-vps",
            source: "remote",
            executorName: "codex",
            displayName: "Codex",
            locationName: "VPS",
            capabilities: ["acp.codex"],
            available: true,
            unavailableReason: null,
            remoteEndpointId: "endpoint-vps"
          }
        ],
        workItem: blockItem,
        runtimeRemoteExecution: activeRuntimeExecution,
        open: true,
        api,
        selectedAgentEndpointId: "remote:endpoint-vps",
        t: createTranslator("en"),
        createId: () => "id-fixed"
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.identity).not.toBeNull();
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "remote:endpoint-vps", available: true })
        ])
      );
    });

    await act(async () => {
      await result.current.dispatch();
    });
    expect(dispatch).toHaveBeenCalledWith({
      schemaVersion: "remote-run/v3",
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-1#B-1",
      agentEndpointId: "endpoint-vps",
      idempotencyKey: "desktop-dispatch-id-fixed",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0
    });

    await act(async () => {
      await result.current.cancel("stop please");
    });
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        action: expect.objectContaining({ kind: "cancel", reason: "stop please" })
      })
    );
  });

  it("reloads endpoints and clears selection when the block or canvas scope changes", async () => {
    const { api, listAgentEndpoints } = createApi();
    listAgentEndpoints.mockResolvedValueOnce({
      schemaVersion: "agent-endpoint-list/v1",
      items: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-vps",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });
    listAgentEndpoints.mockResolvedValue({
      schemaVersion: "agent-endpoint-list/v1",
      items: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-new-scope",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "New Scope Host",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result, rerender } = renderHook(
      ({ workItem }: { workItem: WorkItemRef }) =>
        useRemoteRunPanelController({
          workItem,
          runtimeRemoteExecution: activeRuntimeExecution,
          open: true,
          localAgentEndpoints: [availableLocalEndpoint],
          requiredProfileId: "codex-acp",
          api,
          t: createTranslator("en")
        }),
      { initialProps: { workItem: blockItem } }
    );

    await waitFor(() => {
      expect(result.current.viewModel.identity).not.toBeNull();
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-vps" })])
      );
    });
    act(() => result.current.setSelectedAgentEndpointId("remote:endpoint-vps"));
    await waitFor(() => expect(result.current.selectedAgentEndpointId).toBe("remote:endpoint-vps"));

    rerender({
      workItem: {
        kind: "block",
        canvasId: "secondary",
        blockRef: "T-2#B-1"
      }
    });

    await waitFor(() => {
      expect(result.current.selectedAgentEndpointId).toBeNull();
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-new-scope" })])
      );
    });
    expect(listAgentEndpoints).toHaveBeenCalledTimes(2);
    expect(listAgentEndpoints).toHaveBeenNthCalledWith(1, {
      canvasId: "default",
      workspaceId: "workspace-1"
    });
    expect(listAgentEndpoints).toHaveBeenNthCalledWith(2, {
      canvasId: "secondary",
      workspaceId: "workspace-1"
    });
  });

  it("does not let an old scope endpoint request overwrite the new scope", async () => {
    const { api, listAgentEndpoints } = createApi();
    let resolveOld: ((value: Awaited<ReturnType<typeof listAgentEndpoints>>) => void) | undefined;
    let resolveNew: ((value: Awaited<ReturnType<typeof listAgentEndpoints>>) => void) | undefined;
    listAgentEndpoints.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve))
    );
    listAgentEndpoints.mockImplementationOnce(
      () => new Promise((resolve) => (resolveNew = resolve))
    );
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result, rerender } = renderHook(
      ({ workItem }: { workItem: WorkItemRef }) =>
        useRemoteRunPanelController({
          workItem,
          open: true,
          localAgentEndpoints: [availableLocalEndpoint],
          requiredProfileId: "codex-acp",
          api,
          t: createTranslator("en")
        }),
      { initialProps: { workItem: blockItem } }
    );
    await waitFor(() => expect(listAgentEndpoints).toHaveBeenCalledOnce());
    rerender({ workItem: { kind: "block", canvasId: "next", blockRef: "T-2#B-1" } });
    await waitFor(() => expect(listAgentEndpoints).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNew?.({
        schemaVersion: "agent-endpoint-list/v1",
        items: [
          {
            schemaVersion: "agent-endpoint/v1",
            endpointId: "endpoint-new",
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Codex",
            hostDisplayName: "New Host",
            status: "available",
            capabilities: ["acp.codex"]
          }
        ]
      });
    });
    await waitFor(() =>
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-new" })])
      )
    );
    await act(async () => {
      resolveOld?.({ schemaVersion: "agent-endpoint-list/v1", items: [] });
    });
    expect(result.current.agentEndpoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-new" })])
    );
  });

  it.each([
    {
      label: "resolves late",
      settlement: "resolve",
      initial: blockItem,
      next: { kind: "block", canvasId: "next", blockRef: "T-2#B-1" } as const
    },
    {
      label: "rejects late",
      settlement: "reject",
      initial: blockItem,
      next: { kind: "block", canvasId: "next", blockRef: "T-2#B-1" } as const
    },
    {
      label: "resolves after a delimiter-colliding scope commits",
      settlement: "resolve",
      initial: { kind: "block", canvasId: "a:b", blockRef: "T#B" } as const,
      next: { kind: "block", canvasId: "a", blockRef: "b:T#B" } as const
    }
  ] as const)("keeps the new scope clean when an old dispatch $label", async (testCase) => {
    const { api, dispatch, listAgentEndpoints } = createApi();
    const { settlement } = testCase;
    const collisionCase = testCase.initial.canvasId === "a:b";
    const pendingDispatch = deferred<ReturnType<typeof observation>>();
    dispatch.mockImplementationOnce(() => pendingDispatch.promise);
    if (collisionCase) {
      vi.mocked(api.observeCollaborationRemoteOperation).mockResolvedValue({
        ...observation("running"),
        canvasId: testCase.initial.canvasId,
        blockRef: testCase.initial.blockRef
      });
      const authorityTemplate = await api.getCollaborationWorkAuthority({ workItem: blockItem });
      const assignmentFor = (workItem: WorkItemRef, hostId: string, revision: number) => ({
        projectId: "project-1",
        workItem,
        target: { kind: "exact_host" as const, hostId },
        revision,
        availability: { status: "ready" as const, reason: "ready" as const },
        host: {
          hostId,
          displayName: hostId,
          online: true,
          authorizedForProject: true,
          revoked: false,
          capabilitiesSatisfied: true
        }
      });
      vi.mocked(api.listCollaborationAssignments).mockResolvedValue({
        items: [
          assignmentFor(testCase.initial, "host-old", 11),
          assignmentFor(testCase.next, "host-new", 22)
        ],
        nextCursor: null
      });
      vi.mocked(api.getCollaborationWorkAuthority).mockImplementation(async ({ workItem }) => {
        const revision = workItem.canvasId === "a:b" ? 11 : 22;
        const scope = { ...authorityTemplate.scope, ...workItem };
        return {
          ...authorityTemplate,
          scope,
          responsibility: { ...authorityTemplate.responsibility, scope, revision },
          reviewer: { ...authorityTemplate.reviewer, scope, revision },
          revisions: {
            ...authorityTemplate.revisions,
            responsibilityRevision: revision,
            reviewerRevision: revision
          }
        };
      });
      dispatch.mockResolvedValueOnce({
        ...observation("running"),
        operationId: "op-new",
        canvasId: testCase.next.canvasId,
        blockRef: testCase.next.blockRef
      });
    }
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });
    if (collisionCase) {
      for (const [cursor, workItem, dispatchId, remoteRunStatus] of [
        [1, testCase.initial, "dispatch-old", "started"],
        [2, testCase.next, "dispatch-new", "progress"]
      ] as const) {
        shell.controller.handleObserverSignalForTests({
          type: "human.observer.event",
          profileId: "profile-1",
          projectId: "project-1",
          event: {
            type: "human.observer.event",
            protocolVersion: 1,
            cursor,
            previousCursor: cursor - 1,
            occurredAt: `2030-01-01T00:0${cursor}:00.000Z`,
            kind: "remote_run",
            dispatchId,
            remoteRunStatus,
            workItem
          }
        });
      }
      await Promise.resolve();
    }

    const { result, rerender } = renderHook(
      ({ workItem, runtime }: { workItem: WorkItemRef; runtime: boolean }) =>
        useRemoteRunPanelController({
          workItem,
          runtimeRemoteExecution: runtime ? activeRuntimeExecution : null,
          open: true,
          localAgentEndpoints: [availableLocalEndpoint],
          requiredProfileId: "codex-acp",
          api,
          t: createTranslator("en"),
          createId: () => `late-dispatch-${settlement}`
        }),
      { initialProps: { workItem: testCase.initial, runtime: true } }
    );

    await waitFor(() => {
      expect(result.current.viewModel.identity).not.toBeNull();
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-vps" })])
      );
      if (collisionCase) {
        expect(result.current.viewModel.assignment?.workItem).toEqual(testCase.initial);
        expect(result.current.viewModel.observerStatus).toBe("started");
      }
    });
    act(() => result.current.setSelectedAgentEndpointId("remote:endpoint-vps"));
    let dispatchPromise!: Promise<void>;
    act(() => {
      dispatchPromise = result.current.dispatch();
    });
    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

    rerender({
      workItem: testCase.next,
      runtime: false
    });
    await waitFor(() => {
      expect(result.current.viewModel.identity).toBeNull();
      expect(result.current.actionError).toBeNull();
      expect(result.current.actionInFlight).toBeNull();
      expect(listAgentEndpoints).toHaveBeenCalledTimes(2);
      if (collisionCase) {
        expect(result.current.viewModel.assignment?.workItem).toEqual(testCase.next);
        expect(result.current.viewModel.observerStatus).toBe("progress");
      }
    });

    let newScopeIdentity = result.current.viewModel.identity;
    let newScopeEndpointId = result.current.selectedAgentEndpointId;
    if (collisionCase) {
      act(() => result.current.setSelectedAgentEndpointId("remote:endpoint-vps"));
      await act(async () => result.current.dispatch());
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          canvasId: "a",
          blockRef: "b:T#B",
          expectedResponsibilityRevision: 22,
          expectedReviewerRevision: 22
        })
      );
      newScopeIdentity = result.current.viewModel.identity;
      newScopeEndpointId = result.current.selectedAgentEndpointId;
    }

    await act(async () => {
      if (settlement === "resolve") {
        pendingDispatch.resolve(observation("running"));
      } else {
        pendingDispatch.reject(new Error("late dispatch failure"));
      }
      await dispatchPromise;
    });

    expect(result.current.viewModel.identity).toEqual(newScopeIdentity);
    expect(result.current.actionError).toBeNull();
    expect(result.current.actionInFlight).toBeNull();
    expect(result.current.selectedAgentEndpointId).toBe(newScopeEndpointId);
  });

  it("does not refresh an old operation after a delayed shared action settles", async () => {
    const { api, executeAction, observe } = createApi();
    const pendingAction = deferred<Awaited<ReturnType<typeof executeAction>>>();
    executeAction.mockImplementationOnce(() => pendingAction.promise);
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result, rerender } = renderHook(
      ({ workItem, runtime }: { workItem: WorkItemRef; runtime: boolean }) =>
        useRemoteRunPanelController({
          workItem,
          runtimeRemoteExecution: runtime ? activeRuntimeExecution : null,
          open: true,
          api,
          t: createTranslator("en"),
          createId: () => "late-action"
        }),
      { initialProps: { workItem: blockItem, runtime: true } }
    );
    await waitFor(() => expect(result.current.viewModel.identity).not.toBeNull());

    let actionPromise!: Promise<void>;
    act(() => {
      actionPromise = result.current.cancel("stop old scope");
    });
    await waitFor(() => expect(executeAction).toHaveBeenCalledOnce());
    rerender({
      workItem: { kind: "block", canvasId: "next", blockRef: "T-2#B-1" },
      runtime: false
    });
    await waitFor(() => expect(result.current.actionInFlight).toBeNull());
    const observeCallsBeforeSettlement = observe.mock.calls.length;

    await act(async () => {
      pendingAction.resolve({
        request: {
          kind: "cancel",
          actionId: "late-action",
          operationId: "op-1",
          dispatchId: "dispatch-1",
          executionAttemptId: "attempt-1",
          expectedAttemptVersion: 2,
          leaseId: "lease-1",
          reason: "stop old scope"
        },
        state: "recorded",
        createdAt: "2030-01-01T00:02:00.000Z"
      });
      await actionPromise;
    });

    expect(observe).toHaveBeenCalledTimes(observeCallsBeforeSettlement);
    expect(result.current.viewModel.identity).toBeNull();
    expect(result.current.actionError).toBeNull();
  });

  it("ignores an old scope endpoint rejection after the new scope loads", async () => {
    const { api, listAgentEndpoints } = createApi();
    const oldRequest = deferred<Awaited<ReturnType<typeof listAgentEndpoints>>>();
    listAgentEndpoints.mockImplementationOnce(() => oldRequest.promise);
    listAgentEndpoints.mockResolvedValueOnce({
      schemaVersion: "agent-endpoint-list/v1",
      items: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-new",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "New Host",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result, rerender } = renderHook(
      ({ workItem }: { workItem: WorkItemRef }) =>
        useRemoteRunPanelController({
          workItem,
          open: true,
          localAgentEndpoints: [availableLocalEndpoint],
          requiredProfileId: "codex-acp",
          api,
          t: createTranslator("en")
        }),
      { initialProps: { workItem: blockItem } }
    );
    await waitFor(() => expect(listAgentEndpoints).toHaveBeenCalledOnce());
    rerender({ workItem: { kind: "block", canvasId: "next", blockRef: "T-2#B-1" } });
    await waitFor(() => {
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-new" })])
      );
      expect(result.current.refreshingAgentEndpoints).toBe(false);
    });
    act(() => result.current.setSelectedAgentEndpointId("remote:endpoint-new"));
    await waitFor(() => expect(result.current.selectedAgentEndpointId).toBe("remote:endpoint-new"));

    await act(async () => {
      oldRequest.reject(new Error("old scope endpoint failure"));
      await oldRequest.promise.catch(() => undefined);
    });

    expect(result.current.agentEndpoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-new" })])
    );
    expect(result.current.selectedAgentEndpointId).toBe("remote:endpoint-new");
    expect(result.current.actionError).toBeNull();
    expect(result.current.refreshingAgentEndpoints).toBe(false);
  });

  it("refreshes endpoints and keeps the unavailable selection explicit after a dispatch conflict", async () => {
    const { api, dispatch, listAgentEndpoints } = createApi();
    dispatch.mockRejectedValueOnce({
      kind: "conflict",
      code: "agent_endpoint_unavailable",
      message: "agent_endpoint_unavailable",
      retryable: true
    });
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: activeRuntimeExecution,
        open: true,
        localAgentEndpoints: [availableLocalEndpoint],
        requiredProfileId: "codex-acp",
        api,
        t: createTranslator("en"),
        createId: () => "conflict"
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.identity).not.toBeNull();
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-vps" })])
      );
    });
    act(() => result.current.setSelectedAgentEndpointId("remote:endpoint-vps"));
    await waitFor(() => expect(result.current.selectedAgentEndpointId).toBe("remote:endpoint-vps"));

    await act(async () => result.current.dispatch());

    expect(dispatch).toHaveBeenCalledOnce();
    expect(listAgentEndpoints).toHaveBeenCalledTimes(2);
    expect(result.current.selectedAgentEndpointId).toBe("remote:endpoint-vps");
    expect(result.current.refreshingAgentEndpoints).toBe(false);
    expect(result.current.actionError).toContain("agent_endpoint_unavailable");

    act(() => result.current.setSelectedAgentEndpointId("remote:endpoint-vps"));
    dispatch.mockRejectedValueOnce({
      kind: "conflict",
      code: "agent_endpoint_unavailable",
      message: "agent_endpoint_unavailable",
      retryable: true
    });
    listAgentEndpoints.mockRejectedValueOnce(new Error("catalog refresh failed"));
    await act(async () => result.current.dispatch());

    expect(listAgentEndpoints).toHaveBeenCalledTimes(3);
    expect(result.current.selectedAgentEndpointId).toBe("remote:endpoint-vps");
    expect(result.current.actionError).toContain("agent_endpoint_unavailable");
  });

  it("keeps endpoint selection and skips catalog refresh for non-endpoint errors", async () => {
    const { api, dispatch, listAgentEndpoints } = createApi();
    dispatch.mockRejectedValueOnce({
      kind: "transport",
      code: "collaboration_request_failed",
      message: "network failed",
      retryable: true
    });
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: activeRuntimeExecution,
        open: true,
        localAgentEndpoints: [availableLocalEndpoint],
        requiredProfileId: "codex-acp",
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() =>
      expect(result.current.agentEndpoints).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "remote:endpoint-vps" })])
      )
    );
    act(() => result.current.setSelectedAgentEndpointId("remote:endpoint-vps"));
    await act(async () => result.current.dispatch());

    expect(listAgentEndpoints).toHaveBeenCalledOnce();
    expect(result.current.selectedAgentEndpointId).toBe("remote:endpoint-vps");
    expect(result.current.actionError).toContain("network failed");
  });

  it("settles one pending permission interaction", async () => {
    const { api, settle } = createApi();
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: {
          identity: { operationId: "op-1" },
          phase: "active",
          status: "owned",
          actionRequired: true,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        },
        open: true,
        api,
        t: createTranslator("en"),
        createId: () => "id-fixed"
      })
    );

    await waitFor(() => expect(result.current.viewModel.pendingInteractions.length).toBe(1));

    await act(async () => {
      await result.current.answerInteraction({
        type: "interaction.permission_response",
        decision: "allow_once",
        actionId: "ia-1",
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        executionAttemptId: "attempt-1",
        acpSessionId: "session-1"
      });
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        settlement: expect.objectContaining({
          type: "interaction.permission_response",
          decision: "allow_once"
        })
      })
    );
  });

  it("sends server-owned resume intent without minting lease or recovery", async () => {
    const { api, executeAction, observe } = createApi();
    observe.mockResolvedValue(observation("interrupted"));
    executeAction.mockResolvedValue({
      request: {
        kind: "resume_same_session",
        actionId: "id-lease",
        operationId: "op-1",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        expectedAttemptVersion: 2,
        priorLeaseId: "lease-1",
        leaseId: "id-lease",
        leaseExpiresAt: "2030-01-01T00:00:25.000Z",
        recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" },
        reason: "resume"
      },
      state: "settled"
    });
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    let leaseSeq = 0;
    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: {
          identity: { operationId: "op-1" },
          phase: "active",
          status: "interrupted",
          actionRequired: true,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        },
        open: true,
        api,
        t: createTranslator("en"),
        createId: () => `id-lease-${leaseSeq++}`
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.identity?.recoveryId).toBe("recovery-1");
      expect(result.current.viewModel.phase).toBe("interrupted");
    });

    await act(async () => {
      await result.current.resume("resume please");
    });

    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        action: expect.objectContaining({
          kind: "resume_same_session",
          priorLeaseId: "lease-1",
          reason: "resume please"
        })
      })
    );
    const action = executeAction.mock.calls[0]?.[0]?.action as Record<string, unknown>;
    expect(action).not.toHaveProperty("leaseId");
    expect(action).not.toHaveProperty("leaseExpiresAt");
    expect(action).not.toHaveProperty("recovery");
  });

  it("clears observation state on project switch generation", async () => {
    const { api } = createApi();
    const bridge = readBridge(api);
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
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
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => expect(result.current.viewModel.identity).not.toBeNull());

    await act(async () => {
      await shell.controller.setActiveProject({
        profileId: "profile-1",
        projectId: "project-2",
        canvasId: "default"
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.identity).toBeNull();
    });
  });
});

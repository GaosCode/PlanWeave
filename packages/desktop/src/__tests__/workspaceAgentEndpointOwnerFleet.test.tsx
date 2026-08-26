/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type {
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentEndpointPreferenceKey,
  remoteAgentEndpointPreferenceKey
} from "../renderer/collaboration/agentEndpointPreferences";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import {
  runWorkspaceRemoteScope,
  runWorkspaceRemoteScopeFromAvailability
} from "../renderer/collaboration/workspaceRemoteScopeScheduler";
import { useWorkspaceAgentEndpointRun } from "../renderer/hooks/useWorkspaceAgentEndpointRun";

const operatorControlBridgeMock = vi.hoisted(() => ({
  dispatchOwnerFleetRemoteOperation: vi.fn(),
  observeOwnerFleetRemoteOperation: vi.fn(),
  executeOwnerFleetRemoteOperationAction: vi.fn()
}));

const bridgeMock = vi.hoisted(() => ({
  getBlockDetail: vi.fn(),
  getTaskDetail: vi.fn(),
  previewClaimNext: vi.fn(),
  stopAutoRun: vi.fn()
}));

vi.mock("../renderer/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer/bridge")>();
  return {
    ...actual,
    bridge: bridgeMock,
    operatorControlBridge: operatorControlBridgeMock
  };
});

const graph: DesktopGraphViewModel = {
  projectId: "project-local",
  projectTitle: "Project",
  graphVersion: "graph-v1",
  packageFingerprint: "package-v1",
  executorOptions: ["codex"],
  autoRunPreflightExecutorHint: "codex",
  tasks: [
    {
      taskId: "T-001",
      title: "Task",
      status: "ready",
      executor: "codex",
      executorLabel: "codex",
      promptMarkdown: "# Task",
      promptMissing: false,
      promptPreview: "Task",
      sharedResources: [],
      blocks: [
        {
          ref: "T-001#B-001",
          blockId: "B-001",
          type: "implementation",
          title: "Block",
          status: "ready",
          executor: null,
          requiredCapabilities: ["acp.codex"],
          promptMissing: false,
          exceptionReason: null,
          dispatchable: true,
          remoteExecution: null
        }
      ],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  sharedResourceGroups: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

const project: DesktopProjectSummary = {
  projectId: "project-local",
  name: "Project",
  kind: "external",
  rootPath: "/workspace/project",
  sourceRoot: "/workspace/project",
  workspaceRoot: "/workspace/project/.planweave",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

const remoteEndpoint: AvailableAgentEndpoint = {
  id: "remote:endpoint-windows",
  source: "remote",
  executorName: "codex",
  displayName: "Codex",
  locationName: "LINANIML",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.codex"],
  remoteEndpointId: "endpoint-windows"
};

function operation(state: RemoteOperationObservation["state"]): RemoteOperationObservation {
  return {
    operationId: "operation-1",
    projectId: "project-server",
    canvasId: "canvas-main",
    blockRef: "T-001#B-001",
    state,
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    attempt: {
      executionAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      status: state === "completed" ? "completed" : "running",
      stateVersion: 1
    },
    runtime: { ref: "T-001#B-001", status: state === "completed" ? "completed" : "in_progress" }
  };
}

function localRunState(phase: DesktopAutoRunState["phase"]): DesktopAutoRunState {
  return {
    runId: "DESKTOP-RUN-LOCAL",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "block", blockRef: "T-001#B-001" },
    phase,
    stepCount: 1,
    stepLimit: 1,
    currentRef: null,
    currentExecutor: null,
    elapsedMs: 1,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    explanation: {
      phase,
      currentRef: null,
      currentExecutor: null,
      latestRecordId: null,
      latestRecordPath: null,
      latestOutputSummary: null,
      error: null,
      nextAction: {
        kind: "wait",
        message: "Wait.",
        command: null,
        targetPath: null,
        ref: null
      }
    },
    statePath: "/workspace/run/state.json",
    eventLogPath: "/workspace/run/events.ndjson",
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z"
  };
}

function renderOwnerFleetRun(input?: {
  previewClaimNext?: ReturnType<typeof vi.fn>;
  getBlockDetail?: ReturnType<typeof vi.fn>;
  withCollaborationRuntime?: boolean;
  remoteCanvasOnly?: boolean;
  runtimeAvailability?:
    | { kind: "available" }
    | { kind: "unavailable"; reason: "runtime_not_attached"; statusKnown: true };
}) {
  const setError = vi.fn();
  const lifecycle = { onStarted: vi.fn(), onCompleted: vi.fn(), onFailed: vi.fn() };
  const startLocal = vi.fn(async () => localRunState("running"));
  const previewClaimNext =
    input?.previewClaimNext ??
    vi
      .fn()
      .mockResolvedValueOnce({
        kind: "block",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        effectiveExecutor: "codex",
        reason: "claimed"
      })
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
  const getBlockDetail =
    input?.getBlockDetail ??
    vi.fn(async () => ({ ref: "T-001#B-001", status: "ready" as const, remoteExecution: null }));
  const readCollaborationCanvasBindingRuntimeAvailability = vi.fn(async () => ({
    schemaVersion: "canvas-runtime-view/v1" as const,
    state: {
      kind: "initialized" as const,
      runtimeRevision: 1,
      status: remoteScopeStatus([
        operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation.mock.calls.length > 0 ||
        dispatchCollaborationRemoteOperation.mock.calls.length > 0
          ? { ref: "T-001#B-001", status: "completed", dispatchable: false }
          : { ref: "T-001#B-001", status: "ready", dispatchable: true }
      ])
    },
    execution: {
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "unavailable" as const,
      reason: "runtime_not_attached" as const
    }
  }));
  const dispatchCollaborationRemoteOperation = vi.fn(async () => operation("running"));
  const ensureWorkAuthority = vi.fn(async () => ({
    revisions: { responsibilityRevision: 7, reviewerRevision: 11 }
  }));
  bridgeMock.getBlockDetail.mockImplementation(getBlockDetail);
  operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation.mockResolvedValue(
    operation("running")
  );
  operatorControlBridgeMock.observeOwnerFleetRemoteOperation.mockResolvedValue(
    operation("completed")
  );

  const hook = renderHook(() => {
    const startWithEndpoint = useWorkspaceAgentEndpointRun({
      activeProjectId:
        input?.withCollaborationRuntime || input?.remoteCanvasOnly ? "project-server" : null,
      agentEndpoints: [remoteEndpoint],
      collaborationController:
        input?.withCollaborationRuntime || input?.remoteCanvasOnly ? { ensureWorkAuthority } : null,
      graph,
      preferences: {
        [input?.remoteCanvasOnly
          ? remoteAgentEndpointPreferenceKey({
              workspaceId: "workspace-1",
              projectId: "project-server",
              canvasId: "canvas-main",
              scope: { kind: "task", taskId: "T-001" }
            })
          : agentEndpointPreferenceKey({
              projectRoot: project.rootPath,
              canvasId: "canvas-main",
              scope: { kind: "task", taskId: "T-001" }
            })]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
      },
      canvasBinding: input?.remoteCanvasOnly
        ? {
            kind: "remote",
            workspaceId: "workspace-1",
            projectId: "project-server",
            canvasId: "canvas-main"
          }
        : null,
      selectedCanvasId: "canvas-main",
      selectedProject: input?.remoteCanvasOnly ? null : project,
      runtimeAvailability: input?.runtimeAvailability ?? { kind: "available" },
      operatorProfileId: "profile-a",
      humanPrincipalId: "human-owner-1",
      ownerFleetDispatchEnabled: true,
      setError,
      api:
        input?.withCollaborationRuntime || input?.remoteCanvasOnly
          ? {
              dispatchCollaborationRemoteOperation,
              observeCollaborationRemoteOperation: vi.fn(),
              executeCollaborationRemoteOperationAction: vi.fn(),
              onCollaborationObserverSignal: vi.fn(() => () => undefined),
              readCollaborationCanvasBindingRuntimeAvailability
            }
          : null,
      createId: () => "operation-fleet-1",
      localAutoRunApi: {
        getAutoRunState: vi.fn(async () => localRunState("paused")),
        onAutoRunChanged: vi.fn(() => () => undefined)
      },
      stopLocal: vi.fn(async () => localRunState("stopped")),
      waitForTerminal: vi.fn(async () => operation("completed")),
      previewClaimNext,
      resolveLiveRemoteBinding: vi.fn(async () => null)
    });
    return (scope: DesktopAutoRunScope) => startWithEndpoint(scope, startLocal, lifecycle);
  });

  return {
    ...hook,
    setError,
    lifecycle,
    readCollaborationCanvasBindingRuntimeAvailability,
    dispatchCollaborationRemoteOperation,
    ensureWorkAuthority,
    previewClaimNext,
    startLocal
  };
}

describe("workspace Agent Endpoint owner fleet routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["local", true],
    ["remote", false]
  ] as const)("routes %s endpoint work by its plan when the Server is disconnected", async (source, runsLocally) => {
    const setError = vi.fn();
    const lifecycle = { onStarted: vi.fn(), onCompleted: vi.fn(), onFailed: vi.fn() };
    const previewClaimNext = vi.fn();
    const startLocal = vi.fn();
    const dispatchCollaborationRemoteOperation = vi.fn();
    const endpoint: AvailableAgentEndpoint =
      source === "remote"
        ? remoteEndpoint
        : {
            ...remoteEndpoint,
            id: "local:codex",
            source: "local",
            locationName: null,
            remoteEndpointId: null
          };
    const hook = renderHook(() => {
      const startWithEndpoint = useWorkspaceAgentEndpointRun({
        activeProjectId: "project-server",
        agentEndpoints: [endpoint],
        collaborationController: { ensureWorkAuthority: vi.fn() },
        graph,
        preferences:
          source === "remote"
            ? {
                [agentEndpointPreferenceKey({
                  projectRoot: project.rootPath,
                  canvasId: "canvas-main",
                  scope: { kind: "task", taskId: "T-001" }
                })]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
              }
            : {},
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        runtimeAvailability: {
          kind: "session_disconnected",
          statusKnown: false
        },
        setError,
        api: {
          dispatchCollaborationRemoteOperation,
          observeCollaborationRemoteOperation: vi.fn(),
          executeCollaborationRemoteOperationAction: vi.fn(),
          onCollaborationObserverSignal: vi.fn(() => () => undefined),
          readCollaborationCanvasBindingRuntimeAvailability: vi.fn()
        },
        previewClaimNext
      });
      return (scope: DesktopAutoRunScope) => startWithEndpoint(scope, startLocal, lifecycle);
    });

    await act(() => hook.result.current({ kind: "project" }));

    expect(previewClaimNext).not.toHaveBeenCalled();
    if (runsLocally) {
      expect(startLocal).toHaveBeenCalledWith({ kind: "project" });
    } else {
      expect(startLocal).not.toHaveBeenCalled();
    }
    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    if (runsLocally) {
      expect(setError).not.toHaveBeenCalled();
    } else {
      expect(setError).toHaveBeenCalledWith("collaboration_session_disconnected");
    }
  });

  it("routes an explicitly selected remote Agent when canvas state is known without an attached Runtime", async () => {
    const { result, lifecycle, setError, dispatchCollaborationRemoteOperation } =
      renderOwnerFleetRun({
        remoteCanvasOnly: true,
        runtimeAvailability: {
          kind: "unavailable",
          reason: "runtime_not_attached",
          statusKnown: true
        }
      });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalledWith({
      profileId: "profile-a",
      humanPrincipalId: "human-owner-1",
      workspaceId: "workspace-1",
      command: {
        schemaVersion: "remote-run/v3",
        projectId: "project-server",
        canvasId: "canvas-main",
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows",
        idempotencyKey: "desktop-dispatch-operation-fleet-1",
        expectedResponsibilityRevision: 7,
        expectedReviewerRevision: 11
      }
    });
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("fails closed for remote dispatch without a human principal", async () => {
    const setError = vi.fn();
    const startLocal = vi.fn();
    const hook = renderHook(() =>
      useWorkspaceAgentEndpointRun({
        activeProjectId: null,
        agentEndpoints: [remoteEndpoint],
        collaborationController: null,
        canvasBinding: null,
        graph,
        preferences: {
          [agentEndpointPreferenceKey({
            projectRoot: project.rootPath,
            canvasId: "canvas-main",
            scope: { kind: "task", taskId: "T-001" }
          })]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
        },
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        runtimeAvailability: { kind: "available" },
        operatorProfileId: "profile-a",
        ownerFleetDispatchEnabled: true,
        setError,
        api: null
      })
    );

    await act(() => hook.result.current({ kind: "block", blockRef: "T-001#B-001" }, startLocal));

    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("human_principal_unavailable");
  });

  it("dispatches through owner fleet operator control without collaboration controller", async () => {
    const { result, lifecycle, setError } = renderOwnerFleetRun();

    await act(() => result.current({ kind: "project" }));

    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalledWith({
      profileId: "profile-a",
      humanPrincipalId: "human-owner-1",
      command: expect.objectContaining({
        schemaVersion: "remote-run/v3",
        projectId: "project-local",
        canvasId: "canvas-main",
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0
      })
    });
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("dispatches one remote Block without a local project or filesystem preflight", async () => {
    const {
      result,
      lifecycle,
      previewClaimNext,
      setError,
      startLocal,
      dispatchCollaborationRemoteOperation,
      ensureWorkAuthority
    } = renderOwnerFleetRun({ remoteCanvasOnly: true });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-a",
        humanPrincipalId: "human-owner-1",
        workspaceId: "workspace-1",
        command: expect.objectContaining({
          projectId: "project-server",
          canvasId: "canvas-main",
          blockRef: "T-001#B-001",
          expectedResponsibilityRevision: 7,
          expectedReviewerRevision: 11
        })
      })
    );
    expect(ensureWorkAuthority).toHaveBeenCalledWith({
      kind: "block",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001"
    });
    expect(previewClaimNext).not.toHaveBeenCalled();
    expect(bridgeMock.getBlockDetail).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("rejects an ordinary local Agent preference for a pure Workspace canvas", async () => {
    const setError = vi.fn();
    const startLocal = vi.fn();
    const localEndpoint: AvailableAgentEndpoint = {
      ...remoteEndpoint,
      id: "local:codex",
      source: "local",
      locationName: "",
      remoteEndpointId: undefined,
      localExecutorName: "codex"
    };
    const hook = renderHook(() =>
      useWorkspaceAgentEndpointRun({
        activeProjectId: "project-server",
        agentEndpoints: [localEndpoint, remoteEndpoint],
        collaborationController: null,
        canvasBinding: {
          kind: "remote",
          workspaceId: "workspace-1",
          projectId: "project-server",
          canvasId: "canvas-main"
        },
        graph,
        preferences: {
          [remoteAgentEndpointPreferenceKey({
            workspaceId: "workspace-1",
            projectId: "project-server",
            canvasId: "canvas-main",
            scope: { kind: "task", taskId: "T-001" }
          })]: { kind: "local", executorName: "codex" }
        },
        selectedCanvasId: "canvas-main",
        selectedProject: null,
        runtimeAvailability: { kind: "available" },
        operatorProfileId: "profile-a",
        ownerFleetDispatchEnabled: true,
        setError,
        api: null
      })
    );

    await act(() => hook.result.current({ kind: "block", blockRef: "T-001#B-001" }, startLocal));

    expect(startLocal).not.toHaveBeenCalled();
    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "agent_endpoint_unavailable:T-001#B-001:local:codex:agent_endpoint_unknown"
    );
  });

  it("runs a remote Task without a local working copy", async () => {
    const {
      result,
      lifecycle,
      previewClaimNext,
      setError,
      startLocal,
      dispatchCollaborationRemoteOperation
    } = renderOwnerFleetRun({ remoteCanvasOnly: true });

    await act(() => result.current({ kind: "task", taskId: "T-001" }));

    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-a",
        humanPrincipalId: "human-owner-1",
        workspaceId: "workspace-1",
        command: expect.objectContaining({
          projectId: "project-server",
          canvasId: "canvas-main",
          blockRef: "T-001#B-001"
        })
      })
    );
    expect(previewClaimNext).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("runs a remote Project without a local working copy", async () => {
    const {
      result,
      lifecycle,
      previewClaimNext,
      setError,
      startLocal,
      dispatchCollaborationRemoteOperation
    } = renderOwnerFleetRun({ remoteCanvasOnly: true });

    await act(() => result.current({ kind: "project" }));

    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-a",
        humanPrincipalId: "human-owner-1",
        workspaceId: "workspace-1",
        command: expect.objectContaining({
          projectId: "project-server",
          canvasId: "canvas-main",
          blockRef: "T-001#B-001"
        })
      })
    );
    expect(previewClaimNext).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps owner fleet authority when collaboration availability is present", async () => {
    const {
      result,
      lifecycle,
      setError,
      readCollaborationCanvasBindingRuntimeAvailability,
      dispatchCollaborationRemoteOperation,
      ensureWorkAuthority
    } = renderOwnerFleetRun({ withCollaborationRuntime: true });

    await act(() => result.current({ kind: "project" }));

    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalled();
    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(readCollaborationCanvasBindingRuntimeAvailability).not.toHaveBeenCalled();
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("treats owner fleet terminal observation as scope completion when local status lags", async () => {
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "block",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        effectiveExecutor: "codex",
        reason: "claimed"
      })
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
    operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation.mockResolvedValueOnce({
      ...operation("running"),
      operationId: "operation-fleet-lag"
    });
    operatorControlBridgeMock.observeOwnerFleetRemoteOperation.mockResolvedValue({
      ...operation("completed"),
      operationId: "operation-fleet-lag"
    });
    const { result, lifecycle, setError } = renderOwnerFleetRun({ previewClaimNext });

    await act(() => result.current({ kind: "project" }));

    expect(operatorControlBridgeMock.observeOwnerFleetRemoteOperation).toHaveBeenCalledWith({
      profileId: "profile-a",
      operationId: "operation-fleet-lag"
    });
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalledWith(expect.stringContaining("claim_bus_idle"));
  });

  it("cancels Workspace scope coordination when the selected canvas changes", async () => {
    const setError = vi.fn();
    const lifecycle = {
      onStarted: vi.fn(),
      onCompleted: vi.fn(),
      onFailed: vi.fn(),
      onCancelled: vi.fn()
    };
    const startLocal = vi.fn();
    const onCollaborationObserverSignal = vi.fn(() => () => undefined);
    const readCollaborationCanvasBindingRuntimeAvailability = vi.fn(async () => ({
      schemaVersion: "canvas-runtime-view/v1" as const,
      state: {
        kind: "initialized" as const,
        runtimeRevision: 1,
        status: remoteScopeStatus([
          { ref: "T-001#B-001", status: "in_progress", dispatchable: false }
        ])
      },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1" as const,
        kind: "available" as const,
        runtimeDeviceId: "runtime-device-1"
      }
    }));
    const { result, rerender } = renderHook(
      ({ canvasId }: { canvasId: string }) => {
        const binding = {
          kind: "remote" as const,
          workspaceId: "workspace-1",
          projectId: "project-server",
          canvasId
        };
        return useWorkspaceAgentEndpointRun({
          activeProjectId: "project-server",
          agentEndpoints: [remoteEndpoint],
          collaborationController: {
            ensureWorkAuthority: vi.fn(async () => ({
              revisions: { responsibilityRevision: 7, reviewerRevision: 11 }
            }))
          },
          canvasBinding: binding,
          graph,
          preferences: {
            [remoteAgentEndpointPreferenceKey({
              ...binding,
              scope: { kind: "task", taskId: "T-001" }
            })]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
          },
          selectedCanvasId: canvasId,
          selectedProject: null,
          runtimeAvailability: { kind: "available" },
          operatorProfileId: "profile-a",
          ownerFleetDispatchEnabled: true,
          setError,
          api: {
            dispatchCollaborationRemoteOperation: vi.fn(),
            observeCollaborationRemoteOperation: vi.fn(),
            executeCollaborationRemoteOperationAction: vi.fn(),
            onCollaborationObserverSignal,
            readCollaborationCanvasBindingRuntimeAvailability
          }
        });
      },
      { initialProps: { canvasId: "canvas-main" } }
    );

    let running: Promise<void> | undefined;
    act(() => {
      running = result.current({ kind: "task", taskId: "T-001" }, startLocal, lifecycle);
    });
    await vi.waitFor(() => expect(onCollaborationObserverSignal).toHaveBeenCalledTimes(1));
    rerender({ canvasId: "canvas-next" });
    await act(async () => running);

    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).not.toHaveBeenCalled();
    expect(lifecycle.onFailed).not.toHaveBeenCalled();
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not stale-complete a Workspace Block when its dispatch returns after a canvas switch", async () => {
    let resolveDispatch: ((value: RemoteOperationObservation) => void) | undefined;
    const dispatch = new Promise<RemoteOperationObservation>((resolve) => {
      resolveDispatch = resolve;
    });
    const dispatchCollaborationRemoteOperation = vi.fn(() => dispatch);
    const setError = vi.fn();
    const lifecycle = {
      onStarted: vi.fn(),
      onCompleted: vi.fn(),
      onFailed: vi.fn(),
      onCancelled: vi.fn()
    };
    const { result, rerender } = renderHook(
      ({ canvasId }: { canvasId: string }) => {
        const binding = {
          kind: "remote" as const,
          workspaceId: "workspace-1",
          projectId: "project-server",
          canvasId
        };
        return useWorkspaceAgentEndpointRun({
          activeProjectId: "project-server",
          agentEndpoints: [remoteEndpoint],
          collaborationController: {
            ensureWorkAuthority: vi.fn(async () => ({
              revisions: { responsibilityRevision: 7, reviewerRevision: 11 }
            }))
          },
          canvasBinding: binding,
          graph,
          preferences: {
            [remoteAgentEndpointPreferenceKey({
              ...binding,
              scope: { kind: "task", taskId: "T-001" }
            })]: { kind: "remote", remoteEndpointId: "endpoint-windows" }
          },
          selectedCanvasId: canvasId,
          selectedProject: null,
          runtimeAvailability: { kind: "available" },
          operatorProfileId: "profile-a",
          ownerFleetDispatchEnabled: true,
          setError,
          api: {
            dispatchCollaborationRemoteOperation,
            observeCollaborationRemoteOperation: vi.fn(),
            executeCollaborationRemoteOperationAction: vi.fn(),
            onCollaborationObserverSignal: vi.fn(() => () => undefined),
            readCollaborationCanvasBindingRuntimeAvailability: vi.fn()
          }
        });
      },
      { initialProps: { canvasId: "canvas-main" } }
    );

    let running: Promise<void> | undefined;
    act(() => {
      running = result.current({ kind: "block", blockRef: "T-001#B-001" }, vi.fn(), lifecycle);
    });
    await vi.waitFor(() => expect(dispatchCollaborationRemoteOperation).toHaveBeenCalledTimes(1));
    rerender({ canvasId: "canvas-next" });
    resolveDispatch?.(operation("completed"));
    await act(async () => running);

    expect(lifecycle.onCompleted).not.toHaveBeenCalled();
    expect(lifecycle.onFailed).not.toHaveBeenCalled();
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
});

function remoteScopeStatus(
  rows: Array<{
    ref: string;
    status:
      | "planned"
      | "ready"
      | "in_progress"
      | "completed"
      | "needs_changes"
      | "blocked"
      | "diverged";
    dispatchable: boolean;
  }>,
  packageFingerprint = graph.packageFingerprint
): CanvasRuntimeStatusProjection {
  return {
    schemaVersion: "canvas-runtime-status/v2",
    scope: { workspaceId: "workspace-1", projectId: "project-server", canvasId: "canvas-main" },
    packageFingerprint,
    capturedAt: "2026-08-23T00:00:00.000Z",
    tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
    blocks: rows.map((row) => ({
      ...row,
      completionReason: row.status === "completed" ? "passed" : null,
      blockedReason: null,
      divergenceReason: null
    }))
  };
}

describe("Workspace remote scope scheduling", () => {
  const dependencyGraph: DesktopGraphViewModel = {
    ...graph,
    tasks: [
      {
        ...graph.tasks[0]!,
        blocks: [
          graph.tasks[0]!.blocks[0]!,
          {
            ...graph.tasks[0]!.blocks[0]!,
            ref: "T-001#B-002",
            blockId: "B-002",
            title: "Second",
            status: "planned",
            dispatchable: false
          }
        ]
      }
    ]
  };

  it.each([
    { label: "Task", scope: { kind: "task", taskId: "T-001" } as const },
    { label: "Project", scope: { kind: "project" } as const }
  ])("causes the first $label dispatch before an uninitialized projection exists", async ({
    scope
  }) => {
    let dispatched = false;
    const execute = vi.fn(async () => {
      dispatched = true;
    });
    const completed = remoteScopeStatus([
      { ref: "T-001#B-001", status: "completed", dispatchable: false },
      { ref: "T-001#B-002", status: "completed", dispatchable: false }
    ]);
    const readAvailability = vi.fn(async () => {
      if (!dispatched) {
        return {
          schemaVersion: "canvas-runtime-view/v1" as const,
          state: { kind: "uninitialized" as const },
          execution: {
            schemaVersion: "canvas-runtime-availability/v1" as const,
            kind: "available" as const,
            status: completed,
            sourceRevision: "source-revision-1",
            graphFingerprint: graph.packageFingerprint
          }
        };
      }
      return {
        schemaVersion: "canvas-runtime-view/v1" as const,
        state: { kind: "initialized" as const, status: completed },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1" as const,
          kind: "available" as const,
          status: completed,
          sourceRevision: "source-revision-1",
          graphFingerprint: graph.packageFingerprint
        }
      };
    });

    await runWorkspaceRemoteScopeFromAvailability({
      graph: dependencyGraph,
      scope,
      binding: { workspaceId: "workspace-1", projectId: "project-server", canvasId: "canvas-main" },
      readAvailability,
      execute
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("T-001#B-001", undefined);
    expect(readAvailability).toHaveBeenCalledTimes(2);
  });

  it("advances a Task run from authoritative dispatchable state", async () => {
    let phase = 0;
    const execute = vi.fn(async () => {
      phase += 1;
    });
    const readStatus = vi.fn(async () =>
      phase === 0
        ? remoteScopeStatus([
            { ref: "T-001#B-001", status: "ready", dispatchable: true },
            { ref: "T-001#B-002", status: "planned", dispatchable: false }
          ])
        : phase === 1
          ? remoteScopeStatus([
              { ref: "T-001#B-001", status: "completed", dispatchable: false },
              { ref: "T-001#B-002", status: "ready", dispatchable: true }
            ])
          : remoteScopeStatus([
              { ref: "T-001#B-001", status: "completed", dispatchable: false },
              { ref: "T-001#B-002", status: "completed", dispatchable: false }
            ])
    );

    await runWorkspaceRemoteScope({
      graph: dependencyGraph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus,
      execute
    });

    expect(execute.mock.calls.map(([ref]) => ref)).toEqual(["T-001#B-001", "T-001#B-002"]);
  });

  it("fails loudly when incomplete scope has no Server-dispatchable Block", async () => {
    await expect(
      runWorkspaceRemoteScope({
        graph: dependencyGraph,
        scope: { kind: "task", taskId: "T-001" },
        readStatus: async () =>
          remoteScopeStatus([
            { ref: "T-001#B-001", status: "blocked", dispatchable: false },
            { ref: "T-001#B-002", status: "planned", dispatchable: false }
          ]),
        execute: vi.fn()
      })
    ).rejects.toThrow("workspace_remote_scope_blocked:T-001#B-001:blocked");
  });

  it("does not redispatch a Block while the Server projection is lagging", async () => {
    const ready = remoteScopeStatus([
      { ref: "T-001#B-001", status: "ready", dispatchable: true },
      { ref: "T-001#B-002", status: "planned", dispatchable: false }
    ]);
    const completed = remoteScopeStatus([
      { ref: "T-001#B-001", status: "completed", dispatchable: false },
      { ref: "T-001#B-002", status: "completed", dispatchable: false }
    ]);
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(completed);
    const execute = vi.fn(async () => undefined);
    const waitForStatusChange = vi.fn(async () => undefined);

    await runWorkspaceRemoteScope({
      graph: dependencyGraph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus,
      execute,
      waitForStatusChange
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("T-001#B-001", undefined);
    expect(waitForStatusChange).toHaveBeenCalledTimes(1);
  });

  it("waits for an existing remote operation to leave in-progress after reconnect", async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(
        remoteScopeStatus([
          { ref: "T-001#B-001", status: "in_progress", dispatchable: false },
          { ref: "T-001#B-002", status: "planned", dispatchable: false }
        ])
      )
      .mockResolvedValueOnce(
        remoteScopeStatus([
          { ref: "T-001#B-001", status: "completed", dispatchable: false },
          { ref: "T-001#B-002", status: "completed", dispatchable: false }
        ])
      );
    const execute = vi.fn();
    const waitForStatusChange = vi.fn(async () => undefined);

    await runWorkspaceRemoteScope({
      graph: dependencyGraph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus,
      execute,
      waitForStatusChange
    });

    expect(execute).not.toHaveBeenCalled();
    expect(waitForStatusChange).toHaveBeenCalledTimes(1);
  });

  it("re-reads Server readiness after each dispatch instead of using a stale batch", async () => {
    let dispatched = false;
    const execute = vi.fn(async () => {
      dispatched = true;
    });
    const readStatus = vi.fn(async () =>
      dispatched
        ? remoteScopeStatus([
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#B-002", status: "planned", dispatchable: false }
          ])
        : remoteScopeStatus([
            { ref: "T-001#B-001", status: "ready", dispatchable: true },
            { ref: "T-001#B-002", status: "ready", dispatchable: true }
          ])
    );

    await expect(
      runWorkspaceRemoteScope({
        graph: dependencyGraph,
        scope: { kind: "task", taskId: "T-001" },
        readStatus,
        execute
      })
    ).rejects.toThrow("workspace_remote_scope_idle:no_dispatchable_blocks");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("T-001#B-001", undefined);
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Runtime status belongs to another content version", async () => {
    const execute = vi.fn();

    await expect(
      runWorkspaceRemoteScope({
        graph: dependencyGraph,
        scope: { kind: "task", taskId: "T-001" },
        readStatus: async () =>
          remoteScopeStatus(
            [
              { ref: "T-001#B-001", status: "ready", dispatchable: true },
              { ref: "T-001#B-002", status: "planned", dispatchable: false }
            ],
            "another-package-version"
          ),
        execute
      })
    ).rejects.toThrow("workspace_remote_scope_content_mismatch");

    expect(execute).not.toHaveBeenCalled();
  });

  it("does not report completion when the scope is cancelled during a status read", async () => {
    let resolveStatus: ((status: CanvasRuntimeStatusProjection) => void) | undefined;
    const pendingStatus = new Promise<CanvasRuntimeStatusProjection>((resolve) => {
      resolveStatus = resolve;
    });
    const controller = new AbortController();
    const run = runWorkspaceRemoteScope({
      graph: dependencyGraph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus: () => pendingStatus,
      execute: vi.fn(),
      signal: controller.signal
    });

    controller.abort();
    resolveStatus?.(
      remoteScopeStatus([
        { ref: "T-001#B-001", status: "completed", dispatchable: false },
        { ref: "T-001#B-002", status: "completed", dispatchable: false }
      ])
    );

    await expect(run).rejects.toThrow("workspace_remote_scope_cancelled");
  });
});

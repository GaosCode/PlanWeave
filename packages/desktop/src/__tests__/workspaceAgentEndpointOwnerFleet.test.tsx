/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type {
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentEndpointPreferenceKey,
  remoteAgentEndpointPreferenceKey
} from "../renderer/collaboration/agentEndpointPreferences";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
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
  const readCollaborationCanvasBindingRuntimeAvailability = vi.fn(async () => {
    throw new Error("collaboration_runtime_availability_unavailable");
  });
  const dispatchCollaborationRemoteOperation = vi.fn();
  const ensureWorkAuthority = vi.fn();
  bridgeMock.getBlockDetail.mockImplementation(getBlockDetail);
  operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation.mockResolvedValue(
    operation("running")
  );
  operatorControlBridgeMock.observeOwnerFleetRemoteOperation.mockResolvedValue(
    operation("completed")
  );

  const hook = renderHook(() => {
    const startWithEndpoint = useWorkspaceAgentEndpointRun({
      activeProjectId: input?.withCollaborationRuntime ? "project-server" : null,
      agentEndpoints: [remoteEndpoint],
      collaborationController: input?.withCollaborationRuntime ? { ensureWorkAuthority } : null,
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
      runtimeAvailability: { kind: "available" },
      operatorProfileId: "profile-a",
      ownerFleetDispatchEnabled: true,
      setError,
      api: input?.withCollaborationRuntime
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
    "local",
    "remote"
  ] as const)("blocks %s endpoint work before preview or dispatch when the Server is disconnected", async (source) => {
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
        preferences: {},
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        runtimeAvailability: { kind: "server_disconnected" },
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
    expect(startLocal).not.toHaveBeenCalled();
    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("collaboration_server_disconnected");
  });

  it("blocks owner fleet dispatch before preview when Runtime is unavailable", async () => {
    const setError = vi.fn();
    const lifecycle = { onStarted: vi.fn(), onCompleted: vi.fn(), onFailed: vi.fn() };
    const previewClaimNext = vi.fn();
    const hook = renderHook(() => {
      const startWithEndpoint = useWorkspaceAgentEndpointRun({
        activeProjectId: null,
        agentEndpoints: [remoteEndpoint],
        collaborationController: null,
        graph,
        preferences: {},
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        runtimeAvailability: { kind: "unavailable", reason: "runtime_not_attached" },
        operatorProfileId: "profile-a",
        ownerFleetDispatchEnabled: true,
        setError,
        api: null,
        previewClaimNext
      });
      return (scope: DesktopAutoRunScope) => startWithEndpoint(scope, vi.fn(), lifecycle);
    });

    await act(() => hook.result.current({ kind: "project" }));

    expect(previewClaimNext).not.toHaveBeenCalled();
    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("collaboration_runtime_runtime_not_attached");
    expect(lifecycle.onFailed).toHaveBeenCalledWith("collaboration_runtime_runtime_not_attached");
  });

  it("dispatches through owner fleet operator control without collaboration controller", async () => {
    const { result, lifecycle, setError } = renderOwnerFleetRun();

    await act(() => result.current({ kind: "project" }));

    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalledWith({
      profileId: "profile-a",
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
    const { result, lifecycle, previewClaimNext, setError, startLocal } = renderOwnerFleetRun({
      remoteCanvasOnly: true
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).toHaveBeenCalledWith({
      profileId: "profile-a",
      command: expect.objectContaining({
        projectId: "project-server",
        canvasId: "canvas-main",
        blockRef: "T-001#B-001"
      })
    });
    expect(previewClaimNext).not.toHaveBeenCalled();
    expect(bridgeMock.getBlockDetail).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps remote Task Auto Run disabled until a working copy is bound", async () => {
    const { result, previewClaimNext, setError, startLocal } = renderOwnerFleetRun({
      remoteCanvasOnly: true
    });

    await act(() => result.current({ kind: "task", taskId: "T-001" }));

    expect(operatorControlBridgeMock.dispatchOwnerFleetRemoteOperation).not.toHaveBeenCalled();
    expect(previewClaimNext).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("content_local_canvas_binding_required");
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
});

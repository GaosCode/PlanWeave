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
import { useWorkspaceAgentEndpointRun } from "../renderer/hooks/useWorkspaceAgentEndpointRun";
import type { DesktopWorkspaceExecutionResponse } from "../shared/workspaceExecution";

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
    bridge: bridgeMock
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
  remoteEndpointId: "endpoint-windows",
  agentId: "codex"
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

function workspaceExecutionView(
  phase: "running" | "completed" | "failed" | "stopped"
): DesktopWorkspaceExecutionResponse {
  return {
    version: "planweave.workspace-execution-view/v1",
    handle: {
      version: "planweave.workspace-execution-handle/v1",
      target: "remote",
      phase: "attempt",
      runSessionId: "SESSION-0001",
      authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
      scope: { kind: "block", blockRef: "T-001#B-001" },
      capabilities: { interactionResponse: true },
      operationId: "operation-1",
      operationRevision: phase === "running" ? 1 : 2,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      attemptStateVersion: phase === "running" ? 1 : 2,
      leaseId: "lease-1",
      agentEndpointId: "endpoint-windows",
      cursor: { target: "remote", executionAttemptId: "attempt-1", eventCursor: 1 }
    },
    session: {
      sessionId: "SESSION-0001",
      stateVersion: phase === "running" ? 1 : 2,
      phase,
      scope: { kind: "block", blockRef: "T-001#B-001" },
      startedAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:01.000Z",
      finishedAt: phase === "running" ? null : "2026-08-05T00:00:01.000Z",
      error: phase === "failed" ? "remote execution failed" : null,
      interactionStatus: [],
      evidence: { status: "complete", diagnostics: [] }
    },
    events:
      phase === "running"
        ? []
        : [
            {
              version: "planweave.execution-event/v1",
              eventId: `terminal-${phase}`,
              observedAt: "2026-08-05T00:00:01.000Z",
              runSessionId: "SESSION-0001",
              scope: { kind: "block", blockRef: "T-001#B-001" },
              source: {
                target: "remote",
                operationId: "operation-1",
                executionAttemptId: "attempt-1",
                cursor: 1
              },
              type: "run_terminal",
              data: {
                outcome:
                  phase === "completed" ? "completed" : phase === "stopped" ? "cancelled" : "failed"
              }
            }
          ]
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

function remoteScopeStatus(
  rows: Array<{
    ref: string;
    status: "ready" | "in_progress" | "completed";
    dispatchable: boolean;
  }>
): CanvasRuntimeStatusProjection {
  return {
    schemaVersion: "canvas-runtime-status/v2",
    scope: { workspaceId: "workspace-1", projectId: "project-server", canvasId: "canvas-main" },
    packageFingerprint: graph.packageFingerprint,
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

function renderOwnerFleetRun(input?: {
  previewClaimNext?: ReturnType<typeof vi.fn>;
  getBlockDetail?: ReturnType<typeof vi.fn>;
  withCollaborationRuntime?: boolean;
  remoteCanvasOnly?: boolean;
  runtimeAvailability?:
    | { kind: "available" }
    | { kind: "unavailable"; reason: "runtime_not_attached"; statusKnown: true }
    | { kind: "session_disconnected"; statusKnown: false };
  startWorkspaceExecution?: ReturnType<typeof vi.fn>;
  followWorkspaceExecution?: ReturnType<typeof vi.fn>;
}) {
  const setError = vi.fn();
  const lifecycle = {
    onStarted: vi.fn(),
    onCompleted: vi.fn(),
    onFailed: vi.fn(),
    onCancelled: vi.fn()
  };
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
  const startWorkspaceExecution =
    input?.startWorkspaceExecution ?? vi.fn(async () => workspaceExecutionView("running"));
  const followWorkspaceExecution =
    input?.followWorkspaceExecution ?? vi.fn(async () => workspaceExecutionView("completed"));
  const getBlockDetail =
    input?.getBlockDetail ??
    vi.fn(async () => ({
      ref: "T-001#B-001",
      status:
        followWorkspaceExecution.mock.calls.length > 0
          ? ("completed" as const)
          : ("ready" as const),
      remoteExecution: null
    }));
  const respondWorkspaceExecution = vi.fn(async () => workspaceExecutionView("running"));
  const cancelWorkspaceExecution = vi.fn(async () => workspaceExecutionView("stopped"));
  const readCollaborationCanvasBindingRuntimeAvailability = vi.fn(async () => ({
    schemaVersion: "canvas-runtime-view/v1" as const,
    state: {
      kind: "initialized" as const,
      runtimeRevision: 1,
      status: remoteScopeStatus([
        startWorkspaceExecution.mock.calls.length > 0
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
    revisions: {
      responsibilityRevision: 7,
      reviewerRevision: 11,
      executionTargetRevision: 13
    }
  }));
  bridgeMock.getBlockDetail.mockImplementation(getBlockDetail);

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
      canvasLocator: input?.remoteCanvasOnly
        ? {
            kind: "workspace",
            connectionProfileId: "profile-server-b",
            workspaceId: "workspace-1",
            projectId: "project-server",
            canvasId: "canvas-main"
          }
        : { kind: "local", projectId: "project-local", canvasId: "canvas-main" },
      operatorProfileId: "profile-server-a",
      humanPrincipalId: "human-owner",
      selectedCanvasId: "canvas-main",
      selectedProject: input?.remoteCanvasOnly ? null : project,
      runtimeAvailability: input?.runtimeAvailability ?? { kind: "available" },
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
      previewClaimNext,
      workspaceExecutionApi: {
        startWorkspaceExecution,
        followWorkspaceExecution,
        respondWorkspaceExecution,
        cancelWorkspaceExecution
      }
    });
    return Object.assign(
      (scope: DesktopAutoRunScope) => startWithEndpoint(scope, startLocal, lifecycle),
      { stop: startWithEndpoint.stop }
    );
  });

  return {
    ...hook,
    setError,
    lifecycle,
    readCollaborationCanvasBindingRuntimeAvailability,
    dispatchCollaborationRemoteOperation,
    ensureWorkAuthority,
    previewClaimNext,
    startLocal,
    startWorkspaceExecution,
    followWorkspaceExecution,
    respondWorkspaceExecution,
    cancelWorkspaceExecution
  };
}

describe("workspace Agent Endpoint owner fleet routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes local endpoint work locally when the collaboration Server is disconnected", async () => {
    const setError = vi.fn();
    const lifecycle = { onStarted: vi.fn(), onCompleted: vi.fn(), onFailed: vi.fn() };
    const previewClaimNext = vi.fn();
    const startLocal = vi.fn();
    const dispatchCollaborationRemoteOperation = vi.fn();
    const endpoint: AvailableAgentEndpoint = {
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
    expect(startLocal).toHaveBeenCalledWith({ kind: "project" });
    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("routes Workspace execution through its locator profile when the active owner profile is on another Server", async () => {
    const {
      result,
      lifecycle,
      setError,
      dispatchCollaborationRemoteOperation,
      startWorkspaceExecution,
      followWorkspaceExecution
    } = renderOwnerFleetRun({
      remoteCanvasOnly: true,
      runtimeAvailability: {
        kind: "unavailable",
        reason: "runtime_not_attached",
        statusKnown: true
      }
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    const startInput = {
      locator: {
        kind: "workspace",
        connectionProfileId: "profile-server-b",
        workspaceId: "workspace-1",
        projectId: "project-server",
        canvasId: "canvas-main"
      } as const,
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-windows",
      effectiveExecutor: { name: "codex", agentId: "codex" }
    };
    expect(startWorkspaceExecution).toHaveBeenCalledWith(startInput);
    expect(followWorkspaceExecution).toHaveBeenCalledWith({
      ...startInput,
      sessionId: "SESSION-0001"
    });
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("dispatches a Remote Agent from an ordinary Canvas without Workspace authority", async () => {
    const {
      result,
      lifecycle,
      setError,
      startLocal,
      startWorkspaceExecution,
      followWorkspaceExecution
    } = renderOwnerFleetRun({
      runtimeAvailability: { kind: "session_disconnected", statusKnown: false }
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    const startInput = {
      locator: {
        kind: "owner_canvas",
        operatorProfileId: "profile-server-a",
        humanPrincipalId: "human-owner",
        projectRoot: project.rootPath,
        projectId: graph.projectId,
        canvasId: "canvas-main"
      } as const,
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-windows",
      effectiveExecutor: { name: "codex", agentId: "codex" }
    };
    expect(startWorkspaceExecution).toHaveBeenCalledWith(startInput);
    expect(followWorkspaceExecution).toHaveBeenCalledWith({
      ...startInput,
      sessionId: "SESSION-0001"
    });
    expect(startLocal).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
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
      ensureWorkAuthority,
      startWorkspaceExecution,
      followWorkspaceExecution
    } = renderOwnerFleetRun({ remoteCanvasOnly: true });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(startWorkspaceExecution).toHaveBeenCalledWith({
      locator: {
        kind: "workspace",
        connectionProfileId: "profile-server-b",
        workspaceId: "workspace-1",
        projectId: "project-server",
        canvasId: "canvas-main"
      },
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-windows",
      effectiveExecutor: { name: "codex", agentId: "codex" }
    });
    expect(followWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
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
        setError,
        api: null
      })
    );

    await act(() => hook.result.current({ kind: "block", blockRef: "T-001#B-001" }, startLocal));

    expect(startLocal).not.toHaveBeenCalled();
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
      dispatchCollaborationRemoteOperation,
      startWorkspaceExecution,
      followWorkspaceExecution
    } = renderOwnerFleetRun({ remoteCanvasOnly: true });

    await act(() => result.current({ kind: "task", taskId: "T-001" }));

    expect(setError).not.toHaveBeenCalled();
    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(startWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(followWorkspaceExecution).toHaveBeenCalledTimes(1);
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
      dispatchCollaborationRemoteOperation,
      startWorkspaceExecution,
      followWorkspaceExecution
    } = renderOwnerFleetRun({ remoteCanvasOnly: true });

    await act(() => result.current({ kind: "project" }));

    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(startWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(followWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(previewClaimNext).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not route an ordinary Canvas Remote Agent through collaboration runtime APIs", async () => {
    const {
      result,
      lifecycle,
      setError,
      readCollaborationCanvasBindingRuntimeAvailability,
      dispatchCollaborationRemoteOperation,
      ensureWorkAuthority,
      startWorkspaceExecution
    } = renderOwnerFleetRun({ withCollaborationRuntime: true });

    await act(() => result.current({ kind: "project" }));

    expect(startWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(dispatchCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(readCollaborationCanvasBindingRuntimeAvailability).not.toHaveBeenCalled();
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("treats coordinator terminal follow as scope completion when Workspace status lags", async () => {
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
    const { result, lifecycle, setError, followWorkspaceExecution } = renderOwnerFleetRun({
      previewClaimNext,
      remoteCanvasOnly: true
    });

    await act(() => result.current({ kind: "project" }));

    expect(followWorkspaceExecution).toHaveBeenCalledTimes(1);
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalledWith(expect.stringContaining("claim_bus_idle"));
  });

  it("cancels an active coordinator session when Workspace scope stop is requested", async () => {
    const followWorkspaceExecution = vi.fn(
      () => new Promise<DesktopWorkspaceExecutionResponse>(() => undefined)
    );
    const { result, lifecycle, cancelWorkspaceExecution, startWorkspaceExecution, setError } =
      renderOwnerFleetRun({ remoteCanvasOnly: true, followWorkspaceExecution });

    let running: Promise<void> | undefined;
    act(() => {
      running = result.current({ kind: "block", blockRef: "T-001#B-001" });
    });
    await vi.waitFor(() => expect(startWorkspaceExecution).toHaveBeenCalledTimes(1));
    await act(() => result.current.stop());
    await act(async () => running);

    expect(cancelWorkspaceExecution).toHaveBeenCalledWith({
      locator: {
        kind: "workspace",
        connectionProfileId: "profile-server-b",
        workspaceId: "workspace-1",
        projectId: "project-server",
        canvasId: "canvas-main"
      },
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-windows",
      effectiveExecutor: { name: "codex", agentId: "codex" },
      sessionId: "SESSION-0001",
      actionId: "operation-fleet-1",
      reason: "Desktop Auto Run stop requested."
    });
    expect(lifecycle.onCompleted).not.toHaveBeenCalled();
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("cancels a stale coordinator start when its response returns after a canvas switch", async () => {
    let resolveStart: ((value: DesktopWorkspaceExecutionResponse) => void) | undefined;
    const startResponse = new Promise<DesktopWorkspaceExecutionResponse>((resolve) => {
      resolveStart = resolve;
    });
    const startWorkspaceExecution = vi.fn(() => startResponse);
    const followWorkspaceExecution = vi.fn(async () => workspaceExecutionView("completed"));
    const respondWorkspaceExecution = vi.fn(async () => workspaceExecutionView("running"));
    const cancelWorkspaceExecution = vi.fn(async () => workspaceExecutionView("stopped"));
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
              revisions: {
                responsibilityRevision: 7,
                reviewerRevision: 11,
                executionTargetRevision: 13
              }
            }))
          },
          canvasBinding: binding,
          canvasLocator: {
            kind: "workspace",
            connectionProfileId: "profile-server-b",
            workspaceId: binding.workspaceId,
            projectId: binding.projectId,
            canvasId
          },
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
          setError,
          api: null,
          createId: () => "cancel-stale-1",
          workspaceExecutionApi: {
            startWorkspaceExecution,
            followWorkspaceExecution,
            respondWorkspaceExecution,
            cancelWorkspaceExecution
          }
        });
      },
      { initialProps: { canvasId: "canvas-main" } }
    );

    let running: Promise<void> | undefined;
    act(() => {
      running = result.current({ kind: "block", blockRef: "T-001#B-001" }, vi.fn(), lifecycle);
    });
    await vi.waitFor(() => expect(startWorkspaceExecution).toHaveBeenCalledTimes(1));
    rerender({ canvasId: "canvas-next" });
    resolveStart?.(workspaceExecutionView("running"));
    await act(async () => running);

    expect(cancelWorkspaceExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        locator: expect.objectContaining({ canvasId: "canvas-main" }),
        blockRef: "T-001#B-001",
        sessionId: "SESSION-0001",
        actionId: "cancel-stale-1"
      })
    );
    expect(followWorkspaceExecution).not.toHaveBeenCalled();
    expect(lifecycle.onCompleted).not.toHaveBeenCalled();
    expect(lifecycle.onFailed).not.toHaveBeenCalled();
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });
});

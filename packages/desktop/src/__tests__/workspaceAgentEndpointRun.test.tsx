/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type {
  ClaimResult,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import { agentEndpointPreferenceKey } from "../renderer/collaboration/agentEndpointPreferences";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import type { CollaborationRuntimeAvailabilityView } from "../renderer/collaboration/runtimeAvailabilityView";
import { useWorkspaceAgentEndpointRun } from "../renderer/hooks/useWorkspaceAgentEndpointRun";
import {
  availableRuntime,
  statusProjection
} from "./helpers/collaborationRuntimeAvailabilityFixture";

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

const taskPreferenceKey = agentEndpointPreferenceKey({
  projectRoot: project.rootPath,
  canvasId: "canvas-main",
  scope: { kind: "task", taskId: "T-001" }
});

function operation(
  state: RemoteOperationObservation["state"],
  failure?: RemoteOperationObservation["failure"]
): RemoteOperationObservation {
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
      status: state === "completed" ? "completed" : state === "failed" ? "failed" : "running",
      stateVersion: 1
    },
    ...(failure ? { failure } : {}),
    runtime: { ref: "T-001#B-001", status: state === "completed" ? "completed" : "in_progress" }
  };
}

function localRunState(
  phase: DesktopAutoRunState["phase"],
  overrides?: Partial<DesktopAutoRunState>
): DesktopAutoRunState {
  const stepLimitReached = phase === "paused" && overrides?.error === "Step limit reached.";
  return {
    runId: "DESKTOP-RUN-LOCAL",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "block", blockRef: "T-001#B-001" },
    phase,
    stepCount: phase === "completed" || stepLimitReached ? 1 : 0,
    stepLimit: 1,
    currentRef: phase === "running" ? "T-001#B-001" : null,
    currentExecutor: phase === "running" ? "codex" : null,
    elapsedMs: 1,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    explanation: {
      phase,
      currentRef: phase === "running" ? "T-001#B-001" : null,
      currentExecutor: phase === "running" ? "codex" : null,
      latestRecordId: null,
      latestRecordPath: null,
      latestOutputSummary: null,
      error: overrides?.error ?? null,
      nextAction: {
        kind: phase === "completed" ? "wait" : "wait",
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
    updatedAt: "2026-08-05T00:00:01.000Z",
    ...overrides
  };
}

function blockClaim(ref: string): Extract<ClaimResult, { kind: "block" }> {
  const [taskId, blockId] = ref.split("#");
  return {
    kind: "block",
    ref,
    taskId: taskId ?? "T-001",
    blockId: blockId ?? "B-001",
    blockType: "implementation",
    effectiveExecutor: "codex",
    reason: "claimed"
  };
}

function feedbackClaim(feedbackId = "FE-001"): Extract<ClaimResult, { kind: "feedback" }> {
  return {
    kind: "feedback",
    feedbackId,
    sourceReviewBlockRef: "T-001#R-001",
    taskId: "T-001",
    content: "Please fix",
    effectiveExecutor: "codex"
  };
}

function renderRun(input?: {
  endpoint?: AvailableAgentEndpoint;
  endpoints?: AvailableAgentEndpoint[];
  graph?: DesktopGraphViewModel;
  preferences?: Record<
    string,
    { kind: "remote"; remoteEndpointId: string } | { kind: "local"; executorName: string }
  >;
  readRuntimeAvailability?: ReturnType<typeof vi.fn>;
  runtimeAvailability?: CollaborationRuntimeAvailabilityView;
  previewClaimNext?: ReturnType<typeof vi.fn>;
  resolveLiveRemoteBinding?: ReturnType<typeof vi.fn>;
  activeProjectId?: string | null;
  remoteTerminal?: RemoteOperationObservation;
}) {
  const dispatch = vi.fn(async () => operation("running"));
  const observe = vi.fn(async () => operation("running"));
  const executeAction = vi.fn(async () => ({
    request: { kind: "retry_new_attempt" },
    state: "settled"
  }));
  const ensureWorkAuthority = vi.fn(async () => ({
    revisions: { responsibilityRevision: 7, reviewerRevision: 11 }
  }));
  const setError = vi.fn();
  const lifecycle = {
    onStarted: vi.fn(),
    onCompleted: vi.fn(),
    onFailed: vi.fn()
  };
  // Real Desktop Auto Run: start → running, then stepLimit settles as paused + Step limit reached.
  const startLocal = vi.fn(async () => localRunState("running"));
  const stopLocal = vi.fn(async () => localRunState("stopped", { error: null, stepCount: 1 }));
  const readRuntimeAvailability =
    input?.readRuntimeAvailability ??
    vi
      .fn()
      .mockResolvedValueOnce(
        availableRuntime(
          statusProjection({
            taskStatus: "ready",
            blocks: [{ ref: "T-001#B-001", status: "ready" }]
          })
        )
      )
      .mockResolvedValue(
        availableRuntime(
          statusProjection({
            taskStatus: "implemented",
            blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
          })
        )
      );
  const previewClaimNext =
    input?.previewClaimNext ??
    vi
      .fn()
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
  const readCanvasRuntimeAvailability = vi.fn(async (...args: unknown[]) => {
    const result = await readRuntimeAvailability(...args);
    if (
      !result ||
      ("schemaVersion" in result && result.schemaVersion === "canvas-runtime-view/v1")
    ) {
      return result;
    }
    return availableRuntime(result);
  });
  // Default: no live remote binding → fresh dispatch (graph snapshot is not authoritative).
  const resolveLiveRemoteBinding = input?.resolveLiveRemoteBinding ?? vi.fn(async () => null);
  const waitForTerminal = vi.fn(async () => input?.remoteTerminal ?? operation("completed"));
  // Honest local unit settle: stepLimit:1 → paused + Step limit reached. (not completed)
  const waitForLocalUnit = vi.fn(async () =>
    localRunState("paused", { error: "Step limit reached.", stepCount: 1 })
  );
  const hook = renderHook(() => {
    const startWithEndpoint = useWorkspaceAgentEndpointRun({
      activeProjectId:
        input?.activeProjectId === undefined ? "project-server" : input.activeProjectId,
      agentEndpoints: input?.endpoints ?? [input?.endpoint ?? remoteEndpoint],
      collaborationController: { ensureWorkAuthority },
      graph: input?.graph ?? graph,
      preferences:
        input?.preferences ??
        (input?.endpoint?.source === "local"
          ? {}
          : {
              [taskPreferenceKey]: {
                kind: "remote",
                remoteEndpointId: "endpoint-windows"
              }
            }),
      selectedCanvasId: "canvas-main",
      selectedProject: project,
      runtimeAvailability: input?.runtimeAvailability ?? { kind: "available" },
      setError,
      api: {
        dispatchCollaborationRemoteOperation: dispatch,
        observeCollaborationRemoteOperation: observe,
        executeCollaborationRemoteOperationAction: executeAction,
        onCollaborationObserverSignal: vi.fn(() => () => undefined),
        readCollaborationCanvasBindingRuntimeAvailability: readCanvasRuntimeAvailability
      },
      createId: () => "operation-1",
      localAutoRunApi: {
        getAutoRunState: vi.fn(async () =>
          localRunState("paused", { error: "Step limit reached.", stepCount: 1 })
        ),
        onAutoRunChanged: vi.fn(() => () => undefined)
      },
      stopLocal,
      waitForLocalUnit,
      waitForTerminal,
      previewClaimNext,
      resolveLiveRemoteBinding
    });
    return (scope: DesktopAutoRunScope) => startWithEndpoint(scope, startLocal, lifecycle);
  });
  return {
    ...hook,
    dispatch,
    observe,
    executeAction,
    ensureWorkAuthority,
    readRuntimeAvailability,
    previewClaimNext,
    resolveLiveRemoteBinding,
    setError,
    startLocal,
    stopLocal,
    lifecycle,
    waitForLocalUnit,
    waitForTerminal
  };
}

describe("workspace Agent Endpoint routing", () => {
  it("does not silently replace remote Task endpoints with local Project Auto Run", async () => {
    const { result, dispatch, setError, startLocal, waitForTerminal } = renderRun();

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("retries an interrupted remote attempt instead of dispatching a conflicting operation", async () => {
    const liveInterruptedBinding = {
      identity: { operationId: "operation-interrupted" },
      phase: "active" as const,
      status: "interrupted" as const,
      actionRequired: true,
      source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
      dispatchAttempt: {
        dispatchId: "dispatch-interrupted",
        executionAttemptId: "attempt-interrupted"
      }
    };
    const interrupted = {
      ...operation("interrupted"),
      operationId: "operation-interrupted",
      dispatchId: "dispatch-interrupted",
      executionAttemptId: "attempt-interrupted",
      attempt: {
        executionAttemptId: "attempt-interrupted",
        dispatchId: "dispatch-interrupted",
        status: "interrupted" as const,
        leaseId: "lease-interrupted",
        stateVersion: 3
      },
      runtime: {
        ref: "T-001#B-001",
        status: "interrupted" as const,
        interruption: { resumable: false as const }
      }
    };
    const recovered = {
      ...operation("running"),
      operationId: "operation-interrupted",
      dispatchId: "dispatch-retry-operation-1",
      executionAttemptId: "attempt-retry-operation-1"
    };
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "in_progress", dispatchable: false }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const { result, dispatch, observe, executeAction, waitForTerminal, setError } = renderRun({
      graph,
      readRuntimeAvailability,
      resolveLiveRemoteBinding: vi.fn(async () => liveInterruptedBinding)
    });
    observe.mockResolvedValueOnce(interrupted).mockResolvedValue(recovered);

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({ operationId: "operation-interrupted" });
    expect(executeAction).toHaveBeenCalledWith({
      operationId: "operation-interrupted",
      action: expect.objectContaining({
        kind: "retry_new_attempt",
        priorLeaseId: "lease-interrupted",
        newDispatchId: "dispatch-retry-operation-1",
        newExecutionAttemptId: "attempt-retry-operation-1"
      })
    });
    expect(waitForTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ operationId: "operation-interrupted" })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("resumes a resumable interrupted remote attempt after Host reconnect", async () => {
    const liveResumeBinding = {
      identity: { operationId: "operation-resume" },
      phase: "active" as const,
      status: "interrupted" as const,
      actionRequired: true,
      source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
      dispatchAttempt: {
        dispatchId: "dispatch-resume",
        executionAttemptId: "attempt-resume"
      }
    };
    const interrupted = {
      ...operation("interrupted"),
      operationId: "operation-resume",
      dispatchId: "dispatch-resume",
      executionAttemptId: "attempt-resume",
      attempt: {
        executionAttemptId: "attempt-resume",
        dispatchId: "dispatch-resume",
        status: "interrupted" as const,
        leaseId: "lease-resume",
        stateVersion: 2
      },
      runtime: {
        ref: "T-001#B-001",
        status: "interrupted" as const,
        interruption: {
          resumable: true as const,
          recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
        }
      }
    };
    const resumed = {
      ...operation("running"),
      operationId: "operation-resume",
      dispatchId: "dispatch-resume",
      executionAttemptId: "attempt-resume"
    };
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "in_progress", dispatchable: false }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const { result, dispatch, observe, executeAction, waitForTerminal, setError } = renderRun({
      graph,
      readRuntimeAvailability,
      resolveLiveRemoteBinding: vi.fn(async () => liveResumeBinding)
    });
    observe.mockResolvedValueOnce(interrupted).mockResolvedValue(resumed);

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(executeAction).toHaveBeenCalledWith({
      operationId: "operation-resume",
      action: expect.objectContaining({
        kind: "resume_same_session",
        priorLeaseId: "lease-resume"
      })
    });
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("reattaches to a non-terminal remote Block operation instead of dispatching a conflict", async () => {
    const existingOperationId = "operation-existing";
    const liveExistingBinding = {
      identity: { operationId: existingOperationId },
      phase: "preparing" as const,
      status: "owned" as const,
      actionRequired: false,
      source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
      dispatchAttempt: null
    };
    const { result, dispatch, observe, ensureWorkAuthority, waitForTerminal, setError } = renderRun(
      {
        graph,
        resolveLiveRemoteBinding: vi.fn(async () => liveExistingBinding)
      }
    );

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({ operationId: existingOperationId });
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(waitForTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ operationId: "operation-1" })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("inherits the Task endpoint for a compatible Block with an explicit logical executor", async () => {
    const explicitExecutorGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: task.blocks.map((block) => ({ ...block, executor: "codex" }))
      }))
    };
    const { result, dispatch, setError, startLocal } = renderRun({ graph: explicitExecutorGraph });

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("fails Project preflight before partial execution when a selected endpoint is unavailable", async () => {
    const previewClaimNext = vi.fn();
    const {
      result,
      dispatch,
      readRuntimeAvailability,
      setError,
      startLocal,
      previewClaimNext: preview
    } = renderRun({
      endpoint: {
        ...remoteEndpoint,
        available: false,
        unavailableReason: "agent_endpoint_host_offline"
      },
      previewClaimNext
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith(
      "agent_endpoint_unavailable:T-001#B-001:Codex:agent_endpoint_host_offline"
    );
    expect(readRuntimeAvailability).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
  });

  it("preserves the existing Runtime Auto Run path for an all-local Project", async () => {
    const localEndpoint: AvailableAgentEndpoint = {
      id: "local:codex",
      source: "local",
      executorName: "codex",
      displayName: "Codex",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: ["acp.codex"],
      remoteEndpointId: null
    };
    const previewClaimNext = vi.fn();
    const {
      result,
      dispatch,
      setError,
      startLocal,
      previewClaimNext: preview
    } = renderRun({
      endpoint: localEndpoint,
      previewClaimNext
    });

    await act(() => result.current({ kind: "project" }));

    expect(startLocal).toHaveBeenCalledWith({ kind: "project" });
    expect(preview).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("continues claim-bus multi-unit work: remote impl then local review", async () => {
    const mixedGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: [
        {
          ...graph.tasks[0]!,
          blocks: [
            graph.tasks[0]!.blocks[0]!,
            {
              ...graph.tasks[0]!.blocks[0]!,
              ref: "T-001#R-001",
              blockId: "R-001",
              type: "review",
              title: "Review",
              status: "planned",
              executor: "local-review",
              requiredCapabilities: []
            }
          ]
        }
      ]
    };
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "ready",
          blocks: [
            { ref: "T-001#B-001", status: "ready" },
            { ref: "T-001#R-001", status: "planned", dispatchable: false }
          ]
        })
      )
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#R-001", status: "ready" }
          ]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#R-001", status: "completed", dispatchable: false }
          ]
        })
      );
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValueOnce({
        ...blockClaim("T-001#R-001"),
        blockType: "review" as const
      })
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
    const localReview: AvailableAgentEndpoint = {
      id: "local:local-review",
      source: "local",
      executorName: "local-review",
      displayName: "Local Review",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: [],
      remoteEndpointId: null
    };
    const {
      result,
      dispatch,
      setError,
      startLocal,
      previewClaimNext: preview
    } = renderRun({
      endpoints: [remoteEndpoint, localReview],
      graph: mixedGraph,
      preferences: {
        [agentEndpointPreferenceKey({
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          scope: { kind: "block", blockRef: "T-001#B-001" }
        })]: {
          kind: "remote",
          remoteEndpointId: "endpoint-windows"
        }
      },
      readRuntimeAvailability,
      previewClaimNext
    });

    await act(() => result.current({ kind: "project" }));

    expect(preview).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ blockRef: "T-001#B-001" }));
    expect(startLocal).toHaveBeenCalledTimes(1);
    expect(startLocal).toHaveBeenCalledWith(
      { kind: "block", blockRef: "T-001#R-001" },
      { stepLimit: 1 }
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("accepts step-limit paused as local unit success and stops to free the workspace", async () => {
    // selectedAgentEndpointId for no preference is `local:${executorName}` → local:codex
    const localOnly: AvailableAgentEndpoint = {
      id: "local:codex",
      source: "local",
      executorName: "codex",
      displayName: "Local Codex",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: ["acp.codex"],
      remoteEndpointId: null
    };
    // all-local short-circuits to startLocal without claim bus — force coordinated via remote preference on a second block path
    // Use mixed: one local block via claim bus (project with remote endpoint preference but execute only local by endpoint map)
    const localGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: [
        {
          ...graph.tasks[0]!,
          blocks: [
            {
              ...graph.tasks[0]!.blocks[0]!,
              ref: "T-001#B-001",
              status: "ready",
              dispatchable: true
            },
            {
              ...graph.tasks[0]!.blocks[0]!,
              ref: "T-001#B-002",
              blockId: "B-002",
              status: "ready",
              dispatchable: true
            }
          ]
        }
      ]
    };
    // Prefer local for both so plan is local_scope — that won't hit claim bus.
    // To force claim bus with local units, need at least one remote endpoint selected for another block.
    const remotePrefGraph = localGraph;
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValueOnce(blockClaim("T-001#B-002"))
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "ready",
          blocks: [
            { ref: "T-001#B-001", status: "ready" },
            { ref: "T-001#B-002", status: "ready" }
          ]
        })
      )
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#B-002", status: "ready" }
          ]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#B-002", status: "completed", dispatchable: false }
          ]
        })
      );
    const { result, startLocal, stopLocal, waitForLocalUnit, lifecycle, setError } = renderRun({
      endpoints: [remoteEndpoint, localOnly],
      graph: remotePrefGraph,
      // No preference for B-001 → local; remote preference only on B-002 → coordinated claim bus.
      preferences: {
        [agentEndpointPreferenceKey({
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          scope: { kind: "block", blockRef: "T-001#B-002" }
        })]: {
          kind: "remote",
          remoteEndpointId: "endpoint-windows"
        }
      },
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(waitForLocalUnit).toHaveBeenCalled();
    await expect(waitForLocalUnit.mock.results[0]!.value).resolves.toMatchObject({
      phase: "paused",
      error: "Step limit reached."
    });
    expect(startLocal).toHaveBeenCalledWith(
      { kind: "block", blockRef: "T-001#B-001" },
      { stepLimit: 1 }
    );
    expect(stopLocal).toHaveBeenCalledWith("DESKTOP-RUN-LOCAL");
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("executes a feedback claim unit with stepLimit 1 then continues", async () => {
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(feedbackClaim("FE-001"))
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
    const { result, dispatch, setError, startLocal, stopLocal, waitForLocalUnit, lifecycle } =
      renderRun({
        readRuntimeAvailability,
        previewClaimNext
      });

    await act(() => result.current({ kind: "project" }));

    expect(startLocal).toHaveBeenCalledWith({ kind: "task", taskId: "T-001" }, { stepLimit: 1 });
    expect(waitForLocalUnit).toHaveBeenCalled();
    expect(stopLocal).toHaveBeenCalledWith("DESKTOP-RUN-LOCAL");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ blockRef: "T-001#B-001" }));
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("surfaces claim_bus_blocked through lifecycle.onFailed", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "blocked" as const,
      reason: "dependency_incomplete",
      ref: "T-001#B-002"
    }));
    const readRuntimeAvailability = vi.fn().mockResolvedValue(
      statusProjection({
        taskStatus: "ready",
        blocks: [{ ref: "T-001#B-001", status: "ready" }]
      })
    );
    const { result, dispatch, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("claim_bus_blocked:dependency_incomplete");
    expect(lifecycle.onFailed).toHaveBeenCalledWith("claim_bus_blocked:dependency_incomplete");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("surfaces claim_bus_idle when preview returns none while scope is incomplete", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const readRuntimeAvailability = vi.fn().mockResolvedValue(
      statusProjection({
        taskStatus: "in_progress",
        blocks: [{ ref: "T-001#B-001", status: "ready" }]
      })
    );
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("claim_bus_idle:no_claimable_blocks");
    expect(lifecycle.onFailed).toHaveBeenCalledWith("claim_bus_idle:no_claimable_blocks");
    // loop check (1) + refresh path (2 dedicated reads)
    expect(readRuntimeAvailability).toHaveBeenCalledTimes(3);
  });

  it("refreshes completion projection after claim none before judging idle", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const incomplete = statusProjection({
      taskStatus: "in_progress",
      blocks: [{ ref: "T-001#B-001", status: "ready" }]
    });
    const complete = statusProjection({
      taskStatus: "implemented",
      blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
    });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(incomplete) // loop-start check
      .mockResolvedValueOnce(incomplete) // refresh first read (still lagging)
      .mockResolvedValue(complete); // refresh second read catches up
    const { result, setError, lifecycle, dispatch } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(readRuntimeAvailability).toHaveBeenCalledTimes(3);
  });

  it("fails closed after a mid-run disconnect instead of accepting a cached completed status", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const cachedCompleted = statusProjection({
      taskStatus: "implemented",
      blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
    });
    let online = true;
    const readRuntimeAvailability = vi.fn(async () => {
      if (!online) return null;
      online = false;
      return statusProjection({
        taskStatus: "in_progress",
        blocks: [{ ref: "T-001#B-001", status: "ready" }]
      });
    });
    expect(cachedCompleted.tasks[0]?.status).toBe("implemented");
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("collaboration_runtime_availability_unavailable");
    expect(lifecycle.onFailed).toHaveBeenCalledWith(
      "collaboration_runtime_availability_unavailable"
    );
  });

  it("fails completion refresh on explicit unavailable without using cached status", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValue({
        schemaVersion: "canvas-runtime-view/v1",
        state: { kind: "uninitialized" },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "content_out_of_sync"
        }
      });
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("collaboration_runtime_state_uninitialized");
    expect(lifecycle.onFailed).toHaveBeenCalledWith("collaboration_runtime_state_uninitialized");
  });

  it("surfaces collaboration_runtime_block_status_unavailable when block row missing after refresh", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const withBlock = statusProjection({
      taskStatus: "in_progress",
      blocks: [{ ref: "T-001#B-001", status: "ready" }]
    });
    const missingBlock = statusProjection({
      taskStatus: "in_progress",
      blocks: []
    });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(withBlock) // loop-start: block present, not completed
      .mockResolvedValue(missingBlock); // refresh: target block row still absent
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(setError).toHaveBeenCalledWith(
      "collaboration_runtime_block_status_unavailable:T-001#B-001"
    );
    expect(lifecycle.onFailed).toHaveBeenCalledWith(
      "collaboration_runtime_block_status_unavailable:T-001#B-001"
    );
    expect(setError).not.toHaveBeenCalledWith("claim_bus_idle:no_claimable_blocks");
  });

  it("runs coordinated_block through claim bus rather than execute-once", async () => {
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValue({ kind: "none", reason: "done" });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "ready",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const {
      result,
      dispatch,
      previewClaimNext: preview,
      setError
    } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(preview).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "block", blockRef: "T-001#B-001" }
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("dispatches an inherited Block to the exact remote endpoint selected on its Task", async () => {
    const graphWithFollowingBlock: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: [
          ...task.blocks,
          {
            ...task.blocks[0]!,
            ref: "T-001#B-002",
            blockId: "B-002",
            title: "Following Block"
          }
        ]
      }))
    };
    const { result, dispatch, ensureWorkAuthority, setError, startLocal } = renderRun({
      graph: graphWithFollowingBlock
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(ensureWorkAuthority).toHaveBeenCalledWith({
      kind: "block",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001"
    });
    expect(dispatch).toHaveBeenCalledWith({
      schemaVersion: "remote-run/v3",
      projectId: "project-server",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-windows",
      idempotencyKey: "desktop-dispatch-operation-1",
      expectedResponsibilityRevision: 7,
      expectedReviewerRevision: 11
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps logical executor capability requirements as a dispatch gate", async () => {
    const { result, dispatch, ensureWorkAuthority, setError } = renderRun({
      endpoint: { ...remoteEndpoint, capabilities: [] }
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "agent_endpoint_unavailable:T-001#B-001:Codex:agent_endpoint_incompatible"
    );
  });

  it("runs a remote Task through its next authoritative Block and waits for completion", async () => {
    const {
      result,
      dispatch,
      ensureWorkAuthority,
      previewClaimNext,
      setError,
      startLocal,
      waitForTerminal
    } = renderRun();

    await act(() => result.current({ kind: "task", taskId: "T-001" }));

    expect(previewClaimNext).toHaveBeenCalled();
    expect(ensureWorkAuthority).toHaveBeenCalledWith({
      kind: "block",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001"
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("surfaces the normalized Host failure instead of a generic remote state", async () => {
    const { result, setError } = renderRun({
      remoteTerminal: operation("failed", {
        code: "acp_authentication_required",
        message: "ACP authentication is required.",
        retryable: false
      })
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(setError).toHaveBeenCalledWith(
      "ACP authentication is required. (acp_authentication_required)"
    );
  });
});

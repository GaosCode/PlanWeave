/* @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import type {
  ClaimResult,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { vi } from "vitest";
import { agentEndpointPreferenceKey } from "../renderer/collaboration/agentEndpointPreferences";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import type { CollaborationRuntimeAvailabilityView } from "../renderer/collaboration/runtimeAvailabilityView";
import { useWorkspaceAgentEndpointRun } from "../renderer/hooks/useWorkspaceAgentEndpointRun";
import {
  availableRuntime,
  statusProjection
} from "./helpers/collaborationRuntimeAvailabilityFixture";

const operatorControlBridgeMock = vi.hoisted(() => ({
  observeOwnerFleetRemoteOperation: vi.fn()
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

export const graph: DesktopGraphViewModel = {
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

export const project: DesktopProjectSummary = {
  projectId: "project-local",
  name: "Project",
  kind: "external",
  rootPath: "/workspace/project",
  sourceRoot: "/workspace/project",
  workspaceRoot: "/workspace/project/.planweave",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

export const remoteEndpoint: AvailableAgentEndpoint = {
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

export const taskPreferenceKey = agentEndpointPreferenceKey({
  projectRoot: project.rootPath,
  canvasId: "canvas-main",
  scope: { kind: "task", taskId: "T-001" }
});

export function operation(
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
      leaseId: "lease-1",
      stateVersion: 1
    },
    ...(failure ? { failure } : {}),
    runtime: { ref: "T-001#B-001", status: state === "completed" ? "completed" : "in_progress" }
  };
}

export function localRunState(
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

export function blockClaim(ref: string): Extract<ClaimResult, { kind: "block" }> {
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

export function feedbackClaim(feedbackId = "FE-001"): Extract<ClaimResult, { kind: "feedback" }> {
  return {
    kind: "feedback",
    feedbackId,
    sourceReviewBlockRef: "T-001#R-001",
    taskId: "T-001",
    content: "Please fix",
    effectiveExecutor: "codex"
  };
}

export function renderRun(input?: {
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
  localCanvas?: boolean;
  waitForTerminal?: ReturnType<typeof vi.fn>;
  startWorkspaceExecution?: ReturnType<typeof vi.fn>;
  followWorkspaceExecution?: ReturnType<typeof vi.fn>;
  startGate?: Promise<void>;
}) {
  const dispatch = vi.fn(async () => operation("running"));
  const observe = vi.fn(async () => operation("running"));
  const executeAction = vi.fn(async () => ({
    request: { kind: "retry_new_attempt" },
    state: "settled"
  }));
  const ensureWorkAuthority = vi.fn(async () => ({
    revisions: {
      responsibilityRevision: 7,
      reviewerRevision: 11,
      executionTargetRevision: 13
    }
  }));
  const setError = vi.fn();
  const lifecycle = {
    onStarted: vi.fn(),
    onCompleted: vi.fn(),
    onFailed: vi.fn(),
    onCancelled: vi.fn()
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
      ("schemaVersion" in result && String(result.schemaVersion).startsWith("canvas-runtime-view/"))
    ) {
      return result;
    }
    return availableRuntime(result);
  });
  // Default: no live remote binding → fresh dispatch (graph snapshot is not authoritative).
  const resolveLiveRemoteBinding = input?.resolveLiveRemoteBinding ?? vi.fn(async () => null);
  const waitForTerminal =
    input?.waitForTerminal ?? vi.fn(async () => input?.remoteTerminal ?? operation("completed"));
  // Honest local unit settle: stepLimit:1 → paused + Step limit reached. (not completed)
  const waitForLocalUnit = vi.fn(async () =>
    localRunState("paused", { error: "Step limit reached.", stepCount: 1 })
  );
  const workspaceView = (
    phase: "running" | "completed" | "failed" | "stopped",
    terminal?: RemoteOperationObservation
  ) => ({
    version: "planweave.workspace-execution-view/v1" as const,
    handle: {
      version: "planweave.workspace-execution-handle/v1" as const,
      target: "remote" as const,
      phase: "attempt" as const,
      runSessionId: "SESSION-0001",
      authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
      scope: { kind: "block" as const, blockRef: "T-001#B-001" },
      capabilities: { interactionResponse: true },
      operationId: "operation-1",
      operationRevision: 1,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      attemptStateVersion: 1,
      leaseId: "lease-1",
      agentEndpointId: "endpoint-windows",
      cursor: { target: "remote" as const, executionAttemptId: "attempt-1", eventCursor: 1 }
    },
    session: {
      sessionId: "SESSION-0001",
      stateVersion: 1,
      phase,
      scope: { kind: "block" as const, blockRef: "T-001#B-001" },
      startedAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:01.000Z",
      finishedAt: phase === "running" ? null : "2026-08-05T00:00:01.000Z",
      error: terminal?.failure ? `${terminal.failure.message} (${terminal.failure.code})` : null,
      interactionStatus: [],
      evidence: { status: "complete" as const, diagnostics: [] }
    },
    events:
      phase === "running"
        ? []
        : [
            {
              version: "planweave.execution-event/v1" as const,
              eventId: `terminal-${phase}`,
              observedAt: "2026-08-05T00:00:01.000Z",
              runSessionId: "SESSION-0001",
              scope: { kind: "block" as const, blockRef: "T-001#B-001" },
              source: {
                target: "remote" as const,
                operationId: "operation-1",
                executionAttemptId: "attempt-1",
                cursor: 1
              },
              type: "run_terminal" as const,
              data: {
                outcome:
                  phase === "completed"
                    ? ("completed" as const)
                    : phase === "stopped"
                      ? ("cancelled" as const)
                      : ("failed" as const)
              }
            }
          ]
  });
  const startWorkspaceExecution =
    input?.startWorkspaceExecution ??
    vi.fn(async (startInput: { blockRef: string }) => {
      await input?.startGate;
      await dispatch(startInput);
      return workspaceView("running");
    });
  const followWorkspaceExecution =
    input?.followWorkspaceExecution ??
    vi.fn(async () => {
      const terminal = await waitForTerminal({ initial: operation("running") });
      return workspaceView(
        terminal.state === "completed"
          ? "completed"
          : terminal.state === "cancelled"
            ? "stopped"
            : "failed",
        terminal
      );
    });
  const cancelWorkspaceExecution = vi.fn(async () => {
    return workspaceView("stopped", operation("cancelled"));
  });
  const hook = renderHook(
    ({ authorityKey }: { authorityKey: string }) => {
      const startWithEndpoint = useWorkspaceAgentEndpointRun({
        activeProjectId:
          input?.activeProjectId === undefined ? "project-server" : input.activeProjectId,
        agentEndpoints: input?.endpoints ?? [input?.endpoint ?? remoteEndpoint],
        collaborationController: { ensureWorkAuthority },
        canvasBinding: input?.localCanvas
          ? null
          : {
              kind: "remote",
              workspaceId: "workspace-1",
              projectId: "project-server",
              canvasId: "canvas-main"
            },
        canvasLocator: input?.localCanvas
          ? null
          : {
              kind: "workspace",
              connectionProfileId: "profile-1",
              workspaceId: "workspace-1",
              projectId: "project-server",
              canvasId: "canvas-main"
            },
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
        workspaceRuntimeAuthorityKey: authorityKey,
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
        resolveLiveRemoteBinding,
        workspaceExecutionApi: {
          startWorkspaceExecution,
          followWorkspaceExecution,
          respondWorkspaceExecution: vi.fn(),
          cancelWorkspaceExecution
        }
      });
      return Object.assign(
        (scope: DesktopAutoRunScope) => startWithEndpoint(scope, startLocal, lifecycle),
        { stop: startWithEndpoint.stop }
      );
    },
    { initialProps: { authorityKey: "workspace-authority-1" } }
  );
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
    waitForTerminal,
    startWorkspaceExecution,
    followWorkspaceExecution,
    cancelWorkspaceExecution
  };
}

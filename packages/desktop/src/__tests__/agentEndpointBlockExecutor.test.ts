import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  RemoteBlockExecutionReadModel
} from "@planweave-ai/runtime";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import { createAgentEndpointBlockExecutor } from "../renderer/collaboration/agentEndpointBlockExecutor";
import type { AgentEndpointBlockSelection } from "../renderer/collaboration/agentEndpointRunPlan";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";

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

const task: DesktopGraphViewModel["tasks"][number] = {
  taskId: "T-001",
  title: "Task",
  status: "ready",
  executor: "codex",
  executorLabel: "codex",
  promptMarkdown: "# Task",
  promptMissing: false,
  promptPreview: "Task",
  sharedResources: [],
  blocks: [],
  blockPreview: [],
  hiddenBlockRefs: [],
  overflowBlockCount: 0,
  exceptions: []
};

function block(remoteExecution: RemoteBlockExecutionReadModel | null) {
  return {
    ref: "T-001#R-001",
    blockId: "R-001",
    type: "review" as const,
    title: "Review",
    status: "ready" as const,
    executor: null,
    requiredCapabilities: ["acp.codex"],
    promptMissing: false,
    exceptionReason: null,
    dispatchable: true,
    remoteExecution
  };
}

function remoteBinding(
  overrides: Partial<RemoteBlockExecutionReadModel> & {
    identity: { operationId: string };
  }
): RemoteBlockExecutionReadModel {
  return {
    phase: "preparing",
    status: "owned",
    actionRequired: false,
    source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
    dispatchAttempt: null,
    ...overrides
  };
}

function observation(
  operationId: string,
  state: RemoteOperationObservation["state"]
): RemoteOperationObservation {
  return {
    operationId,
    projectId: "project-server",
    canvasId: "canvas-main",
    blockRef: "T-001#R-001",
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
    runtime: {
      ref: "T-001#R-001",
      status: state === "completed" ? "completed" : "in_progress"
    }
  };
}

function selection(
  snapshotRemoteExecution: RemoteBlockExecutionReadModel | null
): AgentEndpointBlockSelection {
  return {
    task,
    block: block(snapshotRemoteExecution),
    endpoint: remoteEndpoint
  };
}

describe("createAgentEndpointBlockExecutor live remote binding (C3)", () => {
  it("uses injected live binding for existing-operation recovery, not the run-start snapshot", async () => {
    const staleSnapshot = remoteBinding({
      identity: { operationId: "operation-stale-from-snapshot" },
      phase: "active",
      status: "owned"
    });
    const liveActive = remoteBinding({
      identity: { operationId: "operation-live-active" },
      phase: "active",
      status: "owned"
    });
    const resolveLiveRemoteBinding = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(liveActive);
    const dispatch = vi.fn(async () => observation("operation-first-dispatch", "running"));
    const observe = vi.fn(async () => observation("operation-live-active", "running"));
    const ensureWorkAuthority = vi.fn(async () => ({
      revisions: {
        responsibilityRevision: 1,
        reviewerRevision: 2,
        executionTargetRevision: 3
      }
    }));
    const waitForRemoteTerminal = vi.fn(async (input: { initial: RemoteOperationObservation }) => ({
      ...input.initial,
      state: "completed" as const,
      attempt: { ...input.initial.attempt, status: "completed" as const },
      runtime: { ref: input.initial.blockRef, status: "completed" as const }
    }));

    const execute = createAgentEndpointBlockExecutor({
      activeProjectId: "project-server",
      canvasId: "canvas-main",
      selectionByBlockRef: new Map([["T-001#R-001", selection(staleSnapshot)]]),
      collaborationController: { ensureWorkAuthority },
      api: {
        dispatchCollaborationRemoteOperation: dispatch,
        observeCollaborationRemoteOperation: observe,
        executeCollaborationRemoteOperationAction: vi.fn(),
        onCollaborationObserverSignal: vi.fn(() => () => undefined)
      },
      resolveLiveRemoteBinding,
      resolveRemoteContentAuthority: async () => ({
        contentRevision: "1",
        graphFingerprint: `pkg-${"a".repeat(64)}`
      }),
      createId: () => "id-1",
      startLocal: vi.fn(async () => null as DesktopAutoRunState | null),
      stopLocal: vi.fn(),
      waitForRemoteTerminal
    });

    const reviewBlock = block(staleSnapshot);

    // First execution in the same run: live binding empty → fresh dispatch.
    await execute(task, reviewBlock);
    expect(resolveLiveRemoteBinding).toHaveBeenCalledWith("T-001#R-001");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      blockRef: "T-001#R-001",
      agentEndpointId: "endpoint-windows"
    });

    // Second execution (re-review): snapshot still holds stale non-terminal ownership,
    // but live binding reports the real active operation → recover, do not re-dispatch.
    await execute(task, reviewBlock);
    expect(resolveLiveRemoteBinding).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ operationId: "operation-live-active" });
    expect(observe).not.toHaveBeenCalledWith({
      operationId: "operation-stale-from-snapshot"
    });
    expect(waitForRemoteTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ operationId: "operation-live-active" })
      })
    );
  });

  it("dispatches a new operation when the live binding is clear despite a stale non-terminal snapshot", async () => {
    const staleSnapshot = remoteBinding({
      identity: { operationId: "operation-already-finished" },
      phase: "active",
      status: "owned"
    });
    const resolveLiveRemoteBinding = vi.fn(async () => null);
    const dispatch = vi.fn(async () => observation("operation-re-review", "running"));
    const observe = vi.fn();
    const ensureWorkAuthority = vi.fn(async () => ({
      revisions: {
        responsibilityRevision: 3,
        reviewerRevision: 4,
        executionTargetRevision: 5
      }
    }));
    const waitForRemoteTerminal = vi.fn(async () =>
      observation("operation-re-review", "completed")
    );

    const execute = createAgentEndpointBlockExecutor({
      activeProjectId: "project-server",
      canvasId: "canvas-main",
      selectionByBlockRef: new Map([["T-001#R-001", selection(staleSnapshot)]]),
      collaborationController: { ensureWorkAuthority },
      api: {
        dispatchCollaborationRemoteOperation: dispatch,
        observeCollaborationRemoteOperation: observe,
        executeCollaborationRemoteOperationAction: vi.fn(),
        onCollaborationObserverSignal: vi.fn(() => () => undefined)
      },
      resolveLiveRemoteBinding,
      resolveRemoteContentAuthority: async () => ({
        contentRevision: "1",
        graphFingerprint: `pkg-${"a".repeat(64)}`
      }),
      createId: () => "id-2",
      startLocal: vi.fn(async () => null as DesktopAutoRunState | null),
      stopLocal: vi.fn(),
      waitForRemoteTerminal
    });

    await execute(task, block(staleSnapshot));

    expect(resolveLiveRemoteBinding).toHaveBeenCalledWith("T-001#R-001");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
  });

  it("D3: dispatches through owner fleet operator control without collaboration session", async () => {
    const dispatchOwnerFleet = vi.fn(async () => observation("operation-fleet", "running"));
    const observeOwnerFleet = vi.fn();
    const waitForRemoteTerminal = vi.fn(async () => observation("operation-fleet", "completed"));

    const execute = createAgentEndpointBlockExecutor({
      activeProjectId: "project-server",
      canvasId: "canvas-main",
      selectionByBlockRef: new Map([["T-001#R-001", selection(null)]]),
      ownerFleetApi: {
        dispatchOwnerFleetRemoteOperation: dispatchOwnerFleet,
        observeOwnerFleetRemoteOperation: observeOwnerFleet,
        executeOwnerFleetRemoteOperationAction: vi.fn()
      },
      resolveRemoteWorkAuthority: async () => ({
        revisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 0
        }
      }),
      resolveLiveRemoteBinding: vi.fn(async () => null),
      resolveRemoteContentAuthority: async () => ({
        contentRevision: "1",
        graphFingerprint: `pkg-${"a".repeat(64)}`
      }),
      createId: () => "fleet-dispatch-1",
      startLocal: vi.fn(async () => null as DesktopAutoRunState | null),
      stopLocal: vi.fn(),
      waitForRemoteTerminal
    });

    await execute(task, block(null));

    expect(dispatchOwnerFleet).toHaveBeenCalledWith({
      command: expect.objectContaining({
        schemaVersion: "remote-run/v3",
        projectId: "project-server",
        agentEndpointId: "endpoint-windows",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0
      })
    });
    expect(waitForRemoteTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackRefreshMs: 1_000 })
    );
  });
});

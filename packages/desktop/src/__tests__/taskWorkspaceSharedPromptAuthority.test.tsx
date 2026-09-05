/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceCanvasCommandsResult } from "../renderer/hooks/useWorkspaceCanvasCommands";
import type { DesktopWorkspaceExecutionResponse } from "../shared/workspaceExecution";
import {
  taskWorkspaceNavigationIdentity,
  workspaceBlockWorkspaceTarget,
  type TaskWorkspaceNavigationIdentity
} from "../renderer/taskWorkspaceNavigation";
import {
  collaborationCanvasReplicaProjectionSchema,
  type CollaborationCanvasReplicaProjection
} from "../shared/canvasReplicaIpc";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { controllerApi, useControllerHarness } from "./helpers/taskWorkspaceControllerHarness";
import { navigation } from "./helpers/taskWorkspaceControllerModelFixture";
import { taskWorkspaceSource } from "./helpers/taskWorkspaceControllerModelFixture";
import "../renderer/task-workspace/workspaceTaskWorkspaceProjection";

const workspaceExecutionBridgeMock = vi.hoisted(() => ({
  startWorkspaceExecution: vi.fn(),
  followWorkspaceExecution: vi.fn(),
  respondWorkspaceExecution: vi.fn(),
  cancelWorkspaceExecution: vi.fn(),
  remoteAcpConversation: vi.fn()
}));

vi.mock("../renderer/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer/bridge")>();
  return {
    ...actual,
    workspaceExecutionBridge: workspaceExecutionBridgeMock
  };
});

afterEach(cleanupRendererTestEnvironment);

beforeEach(() => {
  vi.clearAllMocks();
  workspaceExecutionBridgeMock.remoteAcpConversation.mockReset();
});

function workspaceExecutionView(): DesktopWorkspaceExecutionResponse {
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
      operationRevision: 3,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      attemptStateVersion: 3,
      leaseId: "lease-1",
      agentEndpointId: "endpoint-windows",
      cursor: { target: "remote", executionAttemptId: "attempt-1", eventCursor: 0 }
    },
    session: {
      sessionId: "SESSION-0001",
      stateVersion: 3,
      phase: "running",
      scope: { kind: "block", blockRef: "T-001#B-001" },
      startedAt: "2026-08-24T00:01:00.000Z",
      updatedAt: "2026-08-24T00:02:00.000Z",
      finishedAt: null,
      error: null,
      interactionStatus: [],
      evidence: { status: "complete", diagnostics: [] }
    },
    events: []
  };
}

function sharedPromptProjection(): CollaborationCanvasReplicaProjection {
  return collaborationCanvasReplicaProjectionSchema.parse({
    authorityId: "authority-1",
    localProjectId: "project-1",
    localCanvasId: "canvas-main",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "canvas-main",
    revision: 2,
    contentDigest: "a".repeat(64),
    canEdit: true,
    optimisticOperationIds: [],
    rejections: [],
    content: {
      projectTitle: "Demo",
      graphVersion: "pgv-shared-2",
      packageFingerprint: `pkg-${"b".repeat(64)}`,
      tasks: [
        {
          taskId: "T-001",
          title: "Task workspace",
          status: "in_progress",
          executor: "codex",
          executorLabel: "codex",
          promptMarkdown: "# Shared Task workspace",
          promptHash: "shared-task-prompt-hash",
          promptMissing: false,
          promptPreview: "Shared Task workspace",
          sharedResources: [],
          blocks: [
            {
              ref: "T-001#B-001",
              blockId: "B-001",
              type: "implementation",
              title: "Implement",
              status: "in_progress",
              executor: "codex",
              requiredCapabilities: [],
              promptMissing: false,
              exceptionReason: null,
              dispatchable: false,
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
      layout: {
        version: "desktop-layout/v1",
        projectId: "project-1",
        nodes: [],
        updatedAt: "2026-08-03T00:00:00.000Z"
      },
      blockDependenciesByRef: {},
      taskOpenFeedbackCountByTaskId: {},
      blockPromptMarkdownByRef: {
        "T-001#B-001": "# Shared implementation"
      }
    }
  });
}

function workspaceCanvasWithProjection(
  projection = sharedPromptProjection()
): WorkspaceCanvasCommandsResult {
  return {
    enabled: true,
    authorityMode: "shared",
    snapshot: {
      session: {
        canvasId: projection.localCanvasId,
        revision: projection.revision,
        contentDigest: projection.contentDigest,
        lastOperationId: null,
        lastJournalEntryId: null,
        pendingOperationId: null,
        lastConflict: null,
        lastRejectCode: null
      },
      connectionPhase: "connected",
      lastError: null,
      lastStaleConflict: null,
      busy: false
    },
    projection,
    projectionStatus: null,
    offline: false,
    submit: vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null }),
    reconnect: vi.fn().mockResolvedValue(true)
  };
}

describe("Task Workspace shared prompt authority", () => {
  it("opens a pure Workspace Block and loads its existing remote execution record", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const workspaceCanvas = workspaceCanvasWithProjection();
    const workspaceNavigation: TaskWorkspaceNavigationIdentity = taskWorkspaceNavigationIdentity(
      workspaceBlockWorkspaceTarget({
        authority: "workspace",
        connectionProfileId: "profile-workspace",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001"
      }),
      taskWorkspaceSource
    );
    const operation = {
      operationId: "operation-1",
      projectId: "project-1",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "running" as const,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2026-08-24T00:01:00.000Z",
      updatedAt: "2026-08-24T00:02:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "running" as const,
        stateVersion: 3
      },
      agentEndpoint: null,
      runtime: null
    };
    const collaborationApi = {
      lookupCollaborationRemoteOperation: vi.fn().mockResolvedValue(operation),
      lookupWorkspaceRemoteOperation: vi.fn().mockResolvedValue(operation),
      observeCollaborationRemoteOperation: vi.fn().mockResolvedValue(operation),
      observeWorkspaceRemoteOperation: vi.fn().mockResolvedValue(operation),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      replayCollaborationRemoteOperationEvents: vi.fn().mockResolvedValue({
        operationId: "operation-1",
        cursor: 0,
        events: [],
        hasMore: false,
        floorCursor: 0
      }),
      replayWorkspaceRemoteOperationEvents: vi.fn().mockResolvedValue({
        operationId: "operation-1",
        cursor: 0,
        events: [],
        hasMore: false,
        floorCursor: 0
      })
    };
    workspaceExecutionBridgeMock.followWorkspaceExecution.mockResolvedValue(
      workspaceExecutionView()
    );

    const { result } = renderHook(() =>
      useControllerHarness(api, workspaceNavigation, workspaceCanvas, undefined, collaborationApi)
    );

    await waitFor(() => expect(collaborationApi.lookupWorkspaceRemoteOperation).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.remoteConversation?.state).toBe("running"));
    expect(result.current.error).toBeNull();
    expect(result.current.workspace?.project).toEqual({
      authority: "workspace",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-main"
    });
    expect(result.current.selectedRun?.block.ref).toBe("T-001#B-001");
    expect(api.getTaskWorkspace).not.toHaveBeenCalled();
    expect(api.getTaskWorkspaceRunDetail).not.toHaveBeenCalled();
    expect(collaborationApi.lookupWorkspaceRemoteOperation).toHaveBeenCalledWith({
      locator: {
        kind: "workspace",
        connectionProfileId: "profile-workspace",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-main"
      },
      blockRef: "T-001#B-001"
    });
    expect(workspaceExecutionBridgeMock.followWorkspaceExecution).toHaveBeenCalledWith({
      locator: {
        kind: "workspace",
        connectionProfileId: "profile-workspace",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-main"
      },
      blockRef: "T-001#B-001",
      operationId: "operation-1"
    });
    expect(collaborationApi.lookupCollaborationRemoteOperation).not.toHaveBeenCalled();
  });

  it("selects the restored execution in the timeline and loads its completed record", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const workspaceCanvas = workspaceCanvasWithProjection();
    const workspaceNavigation: TaskWorkspaceNavigationIdentity = taskWorkspaceNavigationIdentity(
      workspaceBlockWorkspaceTarget({
        authority: "workspace",
        connectionProfileId: "profile-workspace",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001"
      }),
      taskWorkspaceSource
    );
    const operation = {
      operationId: "operation-1",
      projectId: "project-1",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "cancelled" as const,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2026-08-24T00:01:00.000Z",
      updatedAt: "2026-08-24T00:02:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "cancelled" as const,
        stateVersion: 3
      },
      agentEndpoint: null,
      runtime: null
    };
    const collaborationApi = {
      lookupCollaborationRemoteOperation: vi.fn().mockResolvedValue(operation),
      lookupWorkspaceRemoteOperation: vi.fn().mockResolvedValue(operation),
      observeCollaborationRemoteOperation: vi.fn().mockResolvedValue(operation),
      observeWorkspaceRemoteOperation: vi.fn().mockResolvedValue(operation),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      replayCollaborationRemoteOperationEvents: vi.fn().mockResolvedValue({
        operationId: "operation-1",
        cursor: 0,
        events: [],
        hasMore: false,
        floorCursor: 0
      }),
      replayWorkspaceRemoteOperationEvents: vi.fn().mockResolvedValue({
        operationId: "operation-1",
        cursor: 0,
        events: [],
        hasMore: false,
        floorCursor: 0
      })
    };
    collaborationApi.lookupWorkspaceRemoteOperation.mockImplementation(async (input) =>
      input.operationId === "operation-restored"
        ? {
            ...operation,
            operationId: "operation-restored",
            state: "completed",
            executionAttemptId: "attempt-restored"
          }
        : operation
    );
    workspaceExecutionBridgeMock.remoteAcpConversation.mockImplementation(async (input) => ({
      available: true,
      canRestoreTask: input.operationId === "operation-1" && !input.action,
      restoredOperationId: input.action?.kind === "restore_task" ? "operation-restored" : null,
      reason: null,
      executionAttemptId: input.operationId === "operation-1" ? "attempt-1" : "attempt-restored",
      sessionId: "same-session",
      turns: [],
      events: [],
      cursor: 0,
      hasMore: false,
      execution: { state: "cancelled", cancel: null, interactions: [] }
    }));
    workspaceExecutionBridgeMock.followWorkspaceExecution.mockResolvedValue(
      workspaceExecutionView()
    );

    const { result } = renderHook(() =>
      useControllerHarness(api, workspaceNavigation, workspaceCanvas, undefined, collaborationApi)
    );

    await waitFor(() =>
      expect(result.current.remoteConversation?.continuation?.canRestoreTask).toBe(true)
    );
    expect(result.current.workspace?.blocks[0]?.remoteExecution?.status).toBe("stopped");
    await act(async () => {
      await result.current.remoteConversation?.continuation?.restoreTask();
    });
    await waitFor(() =>
      expect(result.current.selectedRun?.item.run.record.runId).toBe(
        "remote-live-operation-restored"
      )
    );
    expect(result.current.selectedRun?.item.run.metadata.terminalState).toBe("succeeded");
    expect(collaborationApi.lookupWorkspaceRemoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-restored" })
    );
  });

  it("uses shared prompts after reopening instead of stale local package prompts", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const workspaceCanvas = workspaceCanvasWithProjection();
    const { result } = renderHook(() => useControllerHarness(api, navigation(), workspaceCanvas));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.workspace?.task.promptMarkdown).toBe("# Shared Task workspace");
    expect(result.current.workspace?.blocks[0]?.promptMarkdown).toBe("# Shared implementation");

    await act(async () => {
      await result.current.saveTaskPrompt({
        baseMarkdown: "# Shared Task workspace",
        markdown: "# Shared Task workspace updated"
      });
      await result.current.saveBlockPrompt("T-001#B-001", {
        baseMarkdown: "# Shared implementation",
        markdown: "# Shared implementation updated"
      });
    });

    expect(api.getTaskDetail).not.toHaveBeenCalled();
    expect(api.getBlockDetail).not.toHaveBeenCalled();
    expect(workspaceCanvas.submit).toHaveBeenNthCalledWith(1, {
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# Shared Task workspace updated"
      }
    });
    expect(workspaceCanvas.submit).toHaveBeenNthCalledWith(2, {
      intent: {
        kind: "update_block_prompt",
        blockRef: "T-001#B-001",
        promptMarkdown: "# Shared implementation updated"
      }
    });
  });
});

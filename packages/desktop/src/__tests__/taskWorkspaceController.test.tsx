/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopBridgeApi,
  DesktopRunRecord,
  RunnerRecordReadModel,
  TaskWorkspace,
  TaskWorkspaceRun
} from "@planweave-ai/runtime";
import { useCallback, useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewHistoryController } from "../renderer/hooks/useAppViewHistory";
import {
  taskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationTarget
} from "../renderer/taskWorkspaceNavigation";
import { useTaskWorkspaceController } from "../renderer/task-workspace/useTaskWorkspaceController";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { deferred } from "./helpers/desktopProjectFixtures";

afterEach(cleanupRendererTestEnvironment);

const source = {
  view: "graph",
  graphSnapshot: {
    projectRoot: "/projects/demo",
    canvasId: "canvas-main",
    viewport: { x: 20, y: -10, zoom: 0.9 },
    selectedTaskId: "T-001",
    selectedBlockRef: "T-001#B-001"
  }
};

function navigation(recordId = "T-001#B-001::RUN-001"): TaskWorkspaceNavigationIdentity {
  return taskWorkspaceNavigationIdentity(
    {
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      recordId
    },
    source
  );
}

function runnerModel(runId: string): RunnerRecordReadModel {
  const identity = projectedRun(runId).runIdentity;
  return {
    events: [],
    conversation: [],
    timeline: [],
    diagnostics: [],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId,
      afterSequence: 0,
      canonicalIdentity: {
        identity,
        runner: {
          version: "planweave.runner/v1",
          runnerKind: "acp",
          agentId: "codex"
        }
      },
      terminal: false
    },
    terminal: false,
    actualConfiguration: { available: false, reason: "Unavailable." },
    intervention: {
      prompt: {
        available: false,
        reason: "No prompt capability.",
        identity: null,
        inFlight: false
      },
      cancel: { available: false, reason: "No cancel capability.", identity: null }
    },
    interaction: {
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    }
  };
}

function projectedRun(runId: string): TaskWorkspaceRun {
  const recordId = `T-001#B-001::${runId}`;
  return {
    version: "planweave.task-workspace-run/v1",
    kind: "block",
    record: { recordId, ref: "T-001#B-001", taskId: "T-001", blockId: "B-001", runId },
    runIdentity: {
      projectId: "project-1",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId,
      runOwner: "executor",
      runSessionId: `SESSION-${runId}`,
      desktopRunId: `DESKTOP-${runId}`,
      executorRunId: runId
    },
    metadata: {
      executor: "codex",
      adapter: "codex-acp",
      runnerKind: "acp",
      agentId: "codex",
      executionCwd: "/projects/demo",
      projectRoot: "/projects/demo",
      agentSessionId: `session-${runId}`,
      tmuxSessionId: null,
      exitCode: null,
      terminalState: null
    },
    executionWaveId: null,
    duration: {
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: null,
      calculatedAt: "2026-07-13T00:00:01.000Z",
      wallClockMs: 1000,
      unavailableReason: null
    },
    usage: {
      currentContext: null,
      runTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." }
    },
    capabilities: {
      prompt: {
        available: false,
        reason: "No prompt capability.",
        identity: null,
        inFlight: false
      },
      cancel: { available: false, reason: "No cancel capability.", identity: null },
      retry: { available: false, reason: "Retry unavailable.", identity: null },
      resume: { available: false, reason: "Resume unavailable.", identity: null }
    },
    actualConfiguration: { available: false, reason: "Unavailable." }
  };
}

function runItems(selectedRecordId: string | null) {
  return ["RUN-001", "RUN-002"].map((runId, index) => {
    const run = projectedRun(runId);
    return {
      blockRef: "T-001#B-001" as const,
      retryIndex: index + 1,
      active: false,
      selected: selectedRecordId !== null && run.record.recordId === selectedRecordId,
      waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
      run
    };
  });
}

function workspaceHeader(selectedRecordId: string | null): TaskWorkspace {
  return {
    version: "planweave.task-workspace/v1",
    project: { projectId: "project-1", projectRoot: "/projects/demo", canvasId: "canvas-main" },
    task: {
      taskId: "T-001",
      title: "Task workspace",
      status: "in_progress",
      executor: "codex",
      promptMarkdown: "# Task workspace",
      promptMissing: false,
      acceptance: []
    },
    dependencyProgress: {
      total: 0,
      completed: 0,
      percent: 100,
      status: "not_applicable",
      blockers: []
    },
    blocks: [
      {
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        type: "implementation",
        title: "Implement",
        status: "in_progress",
        executor: "codex",
        effectiveExecutor: "codex",
        promptMarkdown: "# Implement",
        promptMissing: false,
        promptSurfaceMarkdown: "# Rendered implement prompt",
        promptSources: [],
        dependencies: {
          total: 0,
          completed: 0,
          percent: 100,
          status: "not_applicable",
          blockers: []
        },
        runs: [],
        annotations: []
      }
    ],
    activeRecordIds: [],
    selectedRecordId,
    latestArtifact: null,
    duration: {
      wallClock: {
        available: false,
        startedAt: null,
        endedAt: null,
        calculatedAt: "2026-07-13T00:00:01.000Z",
        totalMs: null,
        unavailableReason: "Unavailable."
      },
      agentTime: {
        availability: "unavailable",
        totalMs: null,
        includedRunCount: 0,
        missingRunCount: 0,
        reason: "Unavailable."
      }
    },
    usage: {
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskCost: { available: false, totals: null, reason: "Unavailable." }
    }
  };
}

function workspace(selectedRecordId: string): TaskWorkspace {
  const header = workspaceHeader(selectedRecordId);
  return {
    ...header,
    blocks: header.blocks.map((block) => ({
      ...block,
      runs: runItems(selectedRecordId)
        .filter((item) => item.blockRef === block.ref)
        .map(({ blockRef: _blockRef, ...item }) => item)
    }))
  };
}

function record(recordId: string, readModel: RunnerRecordReadModel | null): DesktopRunRecord {
  const runId = recordId.split("::")[1] ?? "";
  return {
    recordId,
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    runId,
    executor: "codex",
    adapter: "codex-acp",
    executionCwd: "/projects/demo",
    projectRoot: "/projects/demo",
    agentSessionId: `session-${runId}`,
    codexSessionId: null,
    tmuxSessionId: null,
    tmuxAttachCommand: null,
    tmuxReadOnlyAttachCommand: null,
    exitCode: null,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: null,
    promptPath: null,
    reportPath: null,
    metadataPath: "/projects/demo/metadata.json",
    stdoutSummary: "",
    stderrSummary: "",
    promptMarkdown: "",
    reportMarkdown: "",
    displayMarkdown: "",
    displayMarkdownSource: "none",
    metadata: {},
    runnerReadModel: readModel
  };
}

function controllerApi(options: { readModel: (recordId: string) => RunnerRecordReadModel | null }) {
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  const api = {
    getBlockDetail: vi.fn(async (_ref: unknown, blockRef: string) => ({
      ref: blockRef,
      graphVersion: "pgv-1",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation" as const,
      title: "Implement",
      status: "in_progress" as const,
      executor: "codex",
      effectiveExecutor: "codex",
      promptMarkdown: "# Implement",
      promptHash: "block-prompt-hash",
      promptMissing: false,
      promptSurfaceMarkdown: "# Rendered implement prompt",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    })),
    getTaskWorkspace: vi.fn(async (input: { selectedRecordId?: string | null }) =>
      workspaceHeader(input.selectedRecordId ?? "T-001#B-001::RUN-001")
    ),
    listTaskWorkspaceRuns: vi.fn(async () => ({
      version: "planweave.task-workspace-runs-page/v1" as const,
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      limit: 50,
      items: runItems("T-001#B-001::RUN-001"),
      nextCursor: null
    })),
    getTaskWorkspaceRunDetail: vi.fn(async (input: { recordId: string }) => {
      const runId = input.recordId.split("::")[1] ?? "RUN-001";
      const run = projectedRun(runId);
      return {
        version: "planweave.task-workspace-run-detail/v1" as const,
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        item: {
          retryIndex: runId === "RUN-002" ? 2 : 1,
          active: false,
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run
        },
        record: record(input.recordId, options.readModel(input.recordId))
      };
    }),
    getGraphViewModel: vi.fn(async () => ({
      projectId: "project-1",
      projectTitle: "Demo",
      graphVersion: "pgv-1",
      packageFingerprint: "fingerprint-1",
      executorOptions: ["manual", "codex", "claude-code", "pi"],
      packageExecutorNames: [],
      agentTransport: "acp" as const,
      autoRunPreflightExecutorHint: "codex",
      tasks: [
        {
          taskId: "T-001",
          title: "Task workspace",
          status: "in_progress" as const,
          executor: "codex",
          executorLabel: "codex",
          promptMarkdown: "# Task workspace",
          promptMissing: false,
          promptPreview: "Task workspace",
          sharedResources: [],
          blocks: [
            {
              ref: "T-001#B-001",
              blockId: "B-001",
              type: "implementation" as const,
              title: "Implement",
              status: "in_progress" as const,
              executor: "codex",
              promptMissing: false,
              exceptionReason: null,
              dispatchable: false
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
    })),
    getTaskDetail: vi.fn(async () => ({
      taskId: "T-001",
      graphVersion: "pgv-1",
      title: "Task workspace",
      status: "in_progress" as const,
      executor: "codex",
      promptMarkdown: "# Task workspace",
      promptHash: "task-prompt-hash",
      promptMissing: false,
      acceptance: [],
      blockOrder: ["T-001#B-001"]
    })),
    subscribeRunnerRecord: vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(async (input) => {
      const unsubscribe = vi.fn(async () => undefined);
      unsubscribes.set(input.recordId, unsubscribe);
      return {
        subscriptionId: `subscription-${input.recordId}`,
        updateSequence: 0,
        snapshot: null,
        unsubscribe
      };
    }),
    onRuntimeStateChanged: vi.fn(() => () => undefined),
    onAutoRunChanged: vi.fn(() => () => undefined),
    updateBlockPrompt: vi.fn(async () => ({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    })),
    updateBlockExecutor: vi.fn(async () => ({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    })),
    updateTaskPrompt: vi.fn(async () => ({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    })),
    updateTaskExecutor: vi.fn(async () => ({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    }))
  };
  return { api, unsubscribes };
}

function useControllerHarness(
  api: ReturnType<typeof controllerApi>["api"],
  initialNavigation = navigation()
) {
  const [currentNavigation, setCurrentNavigation] = useState(initialNavigation);
  const replaceTaskWorkspaceTarget = useCallback(
    (target: TaskWorkspaceNavigationTarget) =>
      setCurrentNavigation(taskWorkspaceNavigationIdentity(target, source)),
    []
  );
  const history = useMemo<AppViewHistoryController>(
    () => ({
      graphSnapshot: null,
      historyError: null,
      historyIndex: 1,
      openTaskWorkspace: vi.fn(),
      replaceTaskWorkspaceTarget,
      returnToTaskWorkspaceSource: vi.fn(),
      route: { view: "task-workspace", navigation: currentNavigation },
      taskWorkspaceNavigation: currentNavigation
    }),
    [currentNavigation, replaceTaskWorkspaceTarget]
  );
  return useTaskWorkspaceController({ api, history });
}

function useControlledNavigationHarness(
  api: ReturnType<typeof controllerApi>["api"],
  currentNavigation: TaskWorkspaceNavigationIdentity | null
) {
  const history = useMemo<AppViewHistoryController>(
    () => ({
      graphSnapshot: null,
      historyError: null,
      historyIndex: 1,
      openTaskWorkspace: vi.fn(),
      replaceTaskWorkspaceTarget: vi.fn(),
      returnToTaskWorkspaceSource: vi.fn(),
      route: currentNavigation
        ? { view: "task-workspace", navigation: currentNavigation }
        : { view: "graph" },
      taskWorkspaceNavigation: currentNavigation
    }),
    [currentNavigation]
  );
  return useTaskWorkspaceController({ api, history });
}

describe("Task Workspace selected run controller", () => {
  it("finishes loading after a direct task target selects its initial run", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const directNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001"
      },
      source
    );
    const { result } = renderHook(() => useControllerHarness(api, directNavigation));

    await waitFor(() => expect(result.current.navigation?.recordId).toBe("T-001#B-001::RUN-002"));

    expect(result.current.status).toBe("ready");
    expect(result.current.workspace?.task.taskId).toBe("T-001");
    expect(api.getTaskWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps the last Task workspace cached while another page is active", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const backgroundRefresh = deferred<TaskWorkspace>();
    api.getTaskWorkspace
      .mockResolvedValueOnce(workspaceHeader("T-001#B-001::RUN-001"))
      .mockImplementationOnce(() => backgroundRefresh.promise);
    const taskNavigation = navigation();
    const { result, rerender } = renderHook(
      ({ currentNavigation }) => useControlledNavigationHarness(api, currentNavigation),
      {
        initialProps: {
          currentNavigation: taskNavigation as TaskWorkspaceNavigationIdentity | null
        }
      }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ currentNavigation: null });
    expect(result.current.status).toBe("idle");
    expect(result.current.workspace).toBeNull();

    rerender({ currentNavigation: taskNavigation });
    expect(result.current.status).toBe("ready");
    expect(result.current.workspace?.task.taskId).toBe("T-001");
    expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2);

    backgroundRefresh.resolve(workspaceHeader("T-001#B-001::RUN-001"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("keeps the loaded workspace mounted while an executor refresh is pending", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const initialWorkspace = workspaceHeader("T-001#B-001::RUN-001");
    const refreshedWorkspace = {
      ...initialWorkspace,
      task: { ...initialWorkspace.task, executor: "claude-code" }
    };
    const pendingRefresh = deferred<TaskWorkspace>();
    api.getTaskWorkspace
      .mockResolvedValueOnce(initialWorkspace)
      .mockImplementationOnce(() => pendingRefresh.promise);
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveTaskExecutor("claude-code");
    });
    await waitFor(() => expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2));

    expect(result.current.status).toBe("ready");
    expect(result.current.workspace?.task.executor).toBe(initialWorkspace.task.executor);

    pendingRefresh.resolve(refreshedWorkspace);
    await waitFor(() => expect(result.current.workspace?.task.executor).toBe("claude-code"));
  });

  it("saves a Task executor without changing Block overrides", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveTaskExecutor("claude-code");
    });

    expect(api.updateTaskExecutor).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      "T-001",
      "claude-code"
    );
    expect(api.updateBlockExecutor).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2));
  });

  it("clears a Block override when its executor is changed to inherit", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveBlockExecutor("T-001#B-001", null);
    });

    expect(api.updateBlockExecutor).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      "T-001#B-001",
      null
    );
  });

  it("surfaces executor edit diagnostics and does not refresh after failure", async () => {
    const { api } = controllerApi({ readModel: () => null });
    api.updateTaskExecutor.mockResolvedValueOnce({
      ok: false,
      affectedTasks: [],
      diagnostics: [{ code: "invalid_executor", message: "Executor is unavailable." }]
    });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(result.current.saveTaskExecutor("missing-agent")).rejects.toThrow(
      "Executor is unavailable."
    );
    expect(api.getTaskWorkspace).toHaveBeenCalledTimes(1);
  });

  it("saves Task prompts through the revision-checked graph edit path and refreshes the workspace", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveTaskPrompt({
        baseMarkdown: "# Task workspace",
        markdown: "# Updated Task workspace"
      });
    });

    expect(api.getTaskDetail).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      "T-001"
    );
    expect(api.updateTaskPrompt).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      "T-001",
      "# Updated Task workspace",
      { baseGraphVersion: "pgv-1", basePromptHash: "task-prompt-hash" }
    );
    await waitFor(() => expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2));
  });

  it("saves Block prompts through the revision-checked graph edit path", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveBlockPrompt("T-001#B-001", {
        baseMarkdown: "# Implement",
        markdown: "# Updated implementation"
      });
    });

    expect(api.getBlockDetail).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      "T-001#B-001"
    );
    expect(api.updateBlockPrompt).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      "T-001#B-001",
      "# Updated implementation",
      { baseGraphVersion: "pgv-1", basePromptHash: "block-prompt-hash" }
    );
  });

  it("refuses to overwrite a Task prompt changed outside the editor", async () => {
    const { api } = controllerApi({ readModel: () => null });
    api.getTaskDetail.mockResolvedValueOnce({
      ...(await api.getTaskDetail()),
      promptMarkdown: "# Changed elsewhere",
      promptHash: "new-task-prompt-hash"
    });
    api.getTaskDetail.mockClear();
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(
      result.current.saveTaskPrompt({
        baseMarkdown: "# Task workspace",
        markdown: "# Local draft"
      })
    ).rejects.toThrow("The Task prompt changed outside this editor.");
    expect(api.updateTaskPrompt).not.toHaveBeenCalled();
  });

  it("keeps Task Overview selected when more than one run is active", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const firstRecordId = "T-001#B-001::RUN-001";
    const secondRecordId = "T-001#B-001::RUN-002";
    api.getTaskWorkspace.mockResolvedValue({
      ...workspaceHeader(null),
      activeRecordIds: [firstRecordId, secondRecordId],
      selectedRecordId: null
    });
    api.listTaskWorkspaceRuns.mockResolvedValue({
      version: "planweave.task-workspace-runs-page/v1",
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      limit: 50,
      items: runItems(null).map((item) => ({ ...item, active: true, selected: false })),
      nextCursor: null
    });
    const taskNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001"
      },
      source
    );
    const { result } = renderHook(() => useControllerHarness(api, taskNavigation));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.selectedRun).toBeNull();
    expect(result.current.workspace?.activeRecordIds).toEqual([firstRecordId, secondRecordId]);
    expect(api.getTaskWorkspaceRunDetail).not.toHaveBeenCalled();
  });

  it("does not let a refresh steal an explicitly selected Task Overview", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.liveStatus).toBe("unavailable"));

    act(() => result.current.selectRun(null));
    expect(result.current.selectedRun).toBeNull();
    expect(result.current.selectedRecordId).toBeNull();
    act(() => result.current.refresh());

    await waitFor(() => expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2));
    expect(result.current.selectedRun).toBeNull();
    expect(result.current.selectedRecordId).toBeNull();
    expect(result.current.navigation?.recordId).toBe("T-001#B-001::RUN-001");
  });

  it("does not expose stale ACP state while selecting a Feedback run", async () => {
    const { api } = controllerApi({
      readModel: (recordId) => runnerModel(recordId.split("::")[1] ?? "")
    });
    api.subscribeRunnerRecord.mockImplementation(async (_input, callback) => {
      callback({
        kind: "closed",
        updateSequence: 1,
        close: {
          reason: "not_subscribable",
          lastSequence: 0,
          recoverable: false,
          message: "Runner record is not live-subscribable."
        }
      });
      return {
        subscriptionId: "subscription-not-subscribable",
        updateSequence: 0,
        snapshot: null,
        unsubscribe: vi.fn(async () => undefined)
      };
    });
    const feedbackRecordId = "FE-001::RUN-FEEDBACK-001";
    const feedbackDetail = deferred<Awaited<ReturnType<typeof api.getTaskWorkspaceRunDetail>>>();
    const getRunDetail = api.getTaskWorkspaceRunDetail.getMockImplementation();
    if (!getRunDetail) {
      throw new Error("Expected the controller API fixture to provide run detail loading.");
    }
    api.getTaskWorkspaceRunDetail.mockImplementation((input) =>
      input.recordId === feedbackRecordId ? feedbackDetail.promise : getRunDetail(input)
    );
    const observedStatuses: string[] = [];
    const { result } = renderHook(() => {
      const controller = useControllerHarness(api);
      observedStatuses.push(controller.liveStatus);
      return controller;
    });
    await waitFor(() => expect(result.current.liveStatus).toBe("error"));

    act(() => result.current.selectRun(null));
    await waitFor(() => expect(result.current.liveStatus).toBe("idle"));
    observedStatuses.length = 0;

    act(() =>
      result.current.selectRun({
        blockRef: "T-001#B-001",
        recordId: feedbackRecordId
      })
    );
    await waitFor(() => expect(result.current.liveStatus).toBe("loading"));

    expect(result.current.selectedRecordId).toBe(feedbackRecordId);
    expect(result.current.selectedRun).toBeNull();
    expect(observedStatuses).not.toContain("idle");
    expect(observedStatuses).not.toContain("error");
  });

  it("keeps a previously loaded Feedback run visible while revisiting it", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const feedbackRecordId = "FE-001::RUN-FEEDBACK-001";
    const feedbackRun: TaskWorkspaceRun = {
      ...projectedRun("RUN-FEEDBACK-001"),
      kind: "feedback",
      record: {
        ...projectedRun("RUN-FEEDBACK-001").record,
        recordId: feedbackRecordId
      }
    };
    const feedbackDetail = {
      version: "planweave.task-workspace-run-detail/v1" as const,
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      item: {
        retryIndex: 1,
        active: false,
        selected: true,
        waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
        run: feedbackRun
      },
      record: {
        ...record(feedbackRecordId, null),
        kind: "feedback" as const,
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#B-001"
      }
    };
    const revisitedFeedback = deferred<typeof feedbackDetail>();
    const getRunDetail = api.getTaskWorkspaceRunDetail.getMockImplementation();
    if (!getRunDetail) {
      throw new Error("Expected the controller API fixture to provide run detail loading.");
    }
    let feedbackRequests = 0;
    api.getTaskWorkspaceRunDetail.mockImplementation((input) => {
      if (input.recordId !== feedbackRecordId) {
        return getRunDetail(input);
      }
      feedbackRequests += 1;
      return feedbackRequests === 1 ? Promise.resolve(feedbackDetail) : revisitedFeedback.promise;
    });

    let revisitingFeedback = false;
    const observedRevisitKinds: Array<TaskWorkspaceRun["kind"] | null> = [];
    const { result } = renderHook(() => {
      const controller = useControllerHarness(api);
      if (revisitingFeedback) {
        observedRevisitKinds.push(controller.selectedRun?.item.run.kind ?? null);
      }
      return controller;
    });
    await waitFor(() => expect(result.current.liveStatus).toBe("unavailable"));

    act(() =>
      result.current.selectRun({
        blockRef: "T-001#B-001",
        recordId: feedbackRecordId
      })
    );
    await waitFor(() => expect(result.current.selectedRun?.item.run.kind).toBe("feedback"));

    act(() =>
      result.current.selectRun({
        blockRef: "T-001#B-001",
        recordId: "T-001#B-001::RUN-002"
      })
    );
    await waitFor(() =>
      expect(result.current.selectedRecord?.recordId).toBe("T-001#B-001::RUN-002")
    );

    revisitingFeedback = true;
    act(() =>
      result.current.selectRun({
        blockRef: "T-001#B-001",
        recordId: feedbackRecordId
      })
    );
    await waitFor(() => expect(feedbackRequests).toBe(2));

    expect(result.current.selectedRun?.item.run.kind).toBe("feedback");
    expect(result.current.selectedRecord?.recordId).toBe(feedbackRecordId);
    expect(result.current.liveStatus).toBe("unavailable");
    expect(observedRevisitKinds).not.toContain(null);
    expect(observedRevisitKinds).not.toContain("block");
  });

  it("rejects a stale block-only navigation target instead of opening the task fallback", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const staleNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-404"
      },
      source
    );
    const { result } = renderHook(() => useControllerHarness(api, staleNavigation));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Block 'T-001#B-404' is unavailable for task 'T-001'.");
    expect(result.current.workspace).toBeNull();
    expect(api.getTaskWorkspaceRunDetail).not.toHaveBeenCalled();
  });

  it("uses history as selected-run state and releases the old live subscription", async () => {
    const { api, unsubscribes } = controllerApi({
      readModel: (recordId) => runnerModel(recordId.split("::")[1] ?? "")
    });
    const { result } = renderHook(() => useControllerHarness(api));

    await waitFor(() => expect(result.current.liveStatus).toBe("live"));
    expect(result.current.navigation?.recordId).toBe("T-001#B-001::RUN-001");
    act(() => {
      result.current.onRunScrollTopChange("T-001#B-001::RUN-001", 120);
      result.current.selectRun({
        blockRef: "T-001#B-001",
        recordId: "T-001#B-001::RUN-002"
      });
    });

    await waitFor(() => expect(result.current.navigation?.recordId).toBe("T-001#B-001::RUN-002"));
    await waitFor(() => expect(result.current.liveStatus).toBe("live"));
    await waitFor(() => expect(unsubscribes.get("T-001#B-001::RUN-001")).toHaveBeenCalledOnce());
    expect(api.getTaskWorkspace).toHaveBeenCalledTimes(1);
    expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(1);
    expect(api.getGraphViewModel).toHaveBeenCalledTimes(1);
    expect(result.current.getRunScrollTop("T-001#B-001::RUN-001")).toBe(120);
  });

  it("reports a missing read model as unavailable without subscribing", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));

    await waitFor(() => expect(result.current.liveStatus).toBe("unavailable"));
    expect(result.current.runnerModel).toBeNull();
    expect(result.current.liveUnavailableReason).toBe("No prompt capability.");
    expect(api.subscribeRunnerRecord).not.toHaveBeenCalled();
  });

  it("keeps a rejected selected record load as an explicit route error", async () => {
    const { api } = controllerApi({ readModel: () => null });
    api.getTaskWorkspaceRunDetail.mockRejectedValueOnce(new Error("Run record could not be read."));
    const { result } = renderHook(() => useControllerHarness(api));

    await waitFor(() => expect(result.current.recordError).toBe("Run record could not be read."));
    expect(result.current.status).toBe("ready");
    expect(result.current.liveStatus).toBe("error");
    expect(result.current.error).toBe("Run record could not be read.");
    expect(result.current.workspace).not.toBeNull();
    expect(result.current.selectedRun).not.toBeNull();
  });

  it("loads additional run pages through listTaskWorkspaceRuns with nextCursor", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const listItem = (runId: string, retryIndex: number, selected: boolean) => ({
      blockRef: "T-001#B-001" as const,
      retryIndex,
      active: false,
      selected,
      waitingInteraction: { active: false as const, count: 0 as const, kinds: [] as [] },
      run: projectedRun(runId)
    });
    api.getTaskWorkspace.mockResolvedValue(workspaceHeader("T-001#B-001::RUN-050"));
    api.listTaskWorkspaceRuns
      .mockResolvedValueOnce({
        version: "planweave.task-workspace-runs-page/v1",
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        limit: 50,
        items: [listItem("RUN-050", 50, true), listItem("RUN-049", 49, false)],
        nextCursor: {
          version: "planweave.task-workspace-runs-cursor/v2",
          taskId: "T-001",
          canvasId: "canvas-main",
          orderedAt: "2026-07-13T00:00:00.000Z",
          recordId: "T-001#B-001::RUN-049"
        }
      })
      .mockResolvedValueOnce({
        version: "planweave.task-workspace-runs-page/v1",
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        limit: 50,
        items: [listItem("RUN-001", 1, false)],
        nextCursor: null
      });
    api.getTaskWorkspaceRunDetail.mockImplementation(async (input: { recordId: string }) => {
      const runId = input.recordId.split("::")[1] ?? "RUN-050";
      const run = projectedRun(runId);
      return {
        version: "planweave.task-workspace-run-detail/v1" as const,
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        item: {
          retryIndex: Number(runId.replace("RUN-", "")) || 1,
          active: false,
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run
        },
        record: record(input.recordId, null)
      };
    });

    const nav = navigation("T-001#B-001::RUN-050");
    const { result } = renderHook(() => useControllerHarness(api, nav));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.error).toBeNull();
    expect(result.current.hasMoreRuns).toBe(true);
    expect(result.current.workspace?.blocks[0]?.runs).toHaveLength(2);

    await act(async () => {
      await result.current.loadMoreRuns();
    });

    await waitFor(() => expect(result.current.hasMoreRuns).toBe(false));
    expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(2);
    expect(api.listTaskWorkspaceRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: {
          version: "planweave.task-workspace-runs-cursor/v2",
          taskId: "T-001",
          canvasId: "canvas-main",
          orderedAt: "2026-07-13T00:00:00.000Z",
          recordId: "T-001#B-001::RUN-049"
        }
      })
    );
    expect(result.current.workspace?.blocks[0]?.runs.map((run) => run.run.record.runId)).toEqual(
      expect.arrayContaining(["RUN-050", "RUN-049", "RUN-001"])
    );
  });

  it("rejects a selected record whose response identity differs from navigation", async () => {
    const { api } = controllerApi({ readModel: () => null });
    api.getTaskWorkspaceRunDetail.mockResolvedValueOnce({
      version: "planweave.task-workspace-run-detail/v1",
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      item: {
        retryIndex: 1,
        active: false,
        selected: true,
        waitingInteraction: { active: false, count: 0, kinds: [] },
        run: projectedRun("RUN-001")
      },
      record: {
        ...record("T-001#B-001::RUN-001", null),
        taskId: "T-OTHER"
      }
    });
    const { result } = renderHook(() => useControllerHarness(api));

    await waitFor(() =>
      expect(result.current.recordError).toBe(
        "Selected run record does not match its Task Workspace navigation identity."
      )
    );
    expect(result.current.status).toBe("ready");
    expect(result.current.liveStatus).toBe("error");
    expect(result.current.selectedRecord).toBeNull();
    expect(api.subscribeRunnerRecord).not.toHaveBeenCalled();
  });

  it("keeps a selected feedback detail outside block pagination and exposes its ACP record", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const runId = "RUN-FEEDBACK-001";
    const recordId = `FE-001::${runId}`;
    const feedbackRun: TaskWorkspaceRun = {
      ...projectedRun(runId),
      kind: "feedback",
      record: {
        ...projectedRun(runId).record,
        recordId
      }
    };
    api.getTaskWorkspaceRunDetail.mockResolvedValueOnce({
      version: "planweave.task-workspace-run-detail/v1",
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      item: {
        retryIndex: 1,
        active: false,
        selected: true,
        waitingInteraction: { active: false, count: 0, kinds: [] },
        run: feedbackRun
      },
      record: {
        ...record(recordId, null),
        kind: "feedback",
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#B-001"
      }
    });

    const { result } = renderHook(() => useControllerHarness(api, navigation(recordId)));

    await waitFor(() => expect(result.current.selectedRun?.item.run.kind).toBe("feedback"));
    expect(result.current.selectedRecord?.recordId).toBe(recordId);
    expect(result.current.workspace?.blocks[0]?.runs).toHaveLength(2);
    expect(api.subscribeRunnerRecord).not.toHaveBeenCalled();
  });

  it("selects a native review annotation without inventing an ACP record", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const annotation = {
      annotationId: "review-attempt:A-001",
      associatedRunRecordId: null,
      attemptId: "A-001",
      content: "The write path still needs serialization.",
      contentPreview: "The write path still needs serialization.",
      kind: "review_attempt" as const,
      reviewedAt: "2026-07-13T00:00:02.000Z",
      sourceReviewBlockRef: "T-001#R-001",
      verdict: "needs_changes" as const
    };
    const annotatedWorkspace = workspaceHeader("T-001#B-001::RUN-001");
    const implementationBlock = annotatedWorkspace.blocks[0];
    if (!implementationBlock) {
      throw new Error("Expected the controller fixture to contain an implementation Block.");
    }
    annotatedWorkspace.blocks.push({
      ...implementationBlock,
      ref: "T-001#R-001",
      blockId: "R-001",
      type: "review",
      title: "Review",
      annotations: [annotation]
    });
    api.getTaskWorkspace.mockResolvedValueOnce(annotatedWorkspace);

    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.selectAnnotation({
        annotationId: annotation.annotationId,
        blockRef: annotation.sourceReviewBlockRef
      });
    });

    await waitFor(() => expect(result.current.selectedAnnotation?.annotation).toEqual(annotation));
    expect(result.current.selectedRun).toBeNull();
    expect(result.current.selectedRecord).toBeNull();
  });
});

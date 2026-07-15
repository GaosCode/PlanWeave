/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopBridgeApi,
  DesktopRunRecord,
  RunnerRecordReadModel,
  TaskWorkspace,
  TaskWorkspaceRun
} from "@planweave-ai/runtime";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewHistoryController } from "../renderer/hooks/useAppViewHistory";
import {
  taskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationTarget
} from "../renderer/taskWorkspaceNavigation";
import { useTaskWorkspaceController } from "../renderer/task-workspace/useTaskWorkspaceController";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

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

function workspace(selectedRecordId: string): TaskWorkspace {
  const runs = ["RUN-001", "RUN-002"].map((runId, index) => {
    const run = projectedRun(runId);
    return {
      retryIndex: index + 1,
      active: false,
      selected: run.record.recordId === selectedRecordId,
      waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
      run
    };
  });
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
        runs,
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
        missingRunCount: 2,
        reason: "Unavailable."
      }
    },
    usage: {
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskCost: { available: false, totals: null, reason: "Unavailable." }
    }
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
      workspace(input.selectedRecordId ?? "T-001#B-001::RUN-001")
    ),
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
    getRunRecord: vi.fn(async (_ref: unknown, recordId: string) =>
      record(recordId, options.readModel(recordId))
    ),
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
    updateTaskPrompt: vi.fn(async () => ({
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
  const history = useMemo<AppViewHistoryController>(
    () => ({
      graphSnapshot: null,
      historyError: null,
      historyIndex: 1,
      openTaskWorkspace: vi.fn(),
      replaceTaskWorkspaceTarget: (target: TaskWorkspaceNavigationTarget) =>
        setCurrentNavigation(taskWorkspaceNavigationIdentity(target, source)),
      returnToTaskWorkspaceSource: vi.fn(),
      route: { view: "task-workspace", navigation: currentNavigation },
      taskWorkspaceNavigation: currentNavigation
    }),
    [currentNavigation]
  );
  return useTaskWorkspaceController({ api, history });
}

describe("Task Workspace selected run controller", () => {
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
    const aggregate = workspace(firstRecordId);
    api.getTaskWorkspace.mockResolvedValue({
      ...aggregate,
      activeRecordIds: [firstRecordId, secondRecordId],
      selectedRecordId: null,
      blocks: aggregate.blocks.map((block) => ({
        ...block,
        runs: block.runs.map((item) => ({ ...item, active: true, selected: false }))
      }))
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
    expect(api.getRunRecord).not.toHaveBeenCalled();
  });

  it("does not let a refresh steal an explicitly selected Task Overview", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.liveStatus).toBe("unavailable"));

    act(() => result.current.selectRun(null));
    expect(result.current.selectedRun).toBeNull();
    act(() => result.current.refresh());

    await waitFor(() => expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2));
    expect(result.current.selectedRun).toBeNull();
    expect(result.current.navigation?.recordId).toBe("T-001#B-001::RUN-001");
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
    expect(api.getRunRecord).not.toHaveBeenCalled();
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
    api.getRunRecord.mockRejectedValueOnce(new Error("Run record could not be read."));
    const { result } = renderHook(() => useControllerHarness(api));

    await waitFor(() => expect(result.current.recordError).toBe("Run record could not be read."));
    expect(result.current.status).toBe("ready");
    expect(result.current.liveStatus).toBe("error");
    expect(result.current.error).toBe("Run record could not be read.");
    expect(result.current.workspace).not.toBeNull();
    expect(result.current.selectedRun).not.toBeNull();
  });

  it("rejects a selected record whose response identity differs from navigation", async () => {
    const { api } = controllerApi({ readModel: () => null });
    api.getRunRecord.mockResolvedValueOnce({
      ...record("T-001#B-001::RUN-001", null),
      taskId: "T-OTHER"
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
});

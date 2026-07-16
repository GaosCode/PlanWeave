/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopBridgeApi,
  DesktopRunRecord,
  RunnerRecordReadModel,
  TaskWorkspace,
  TaskWorkspaceRun
} from "@planweave-ai/runtime";
import { useMemo, useState } from "react";
import type { AppViewHistoryController } from "../renderer/hooks/useAppViewHistory";
import { LiveRunElapsedText } from "../renderer/task-workspace/LiveDurationText";
import {
  taskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationTarget
} from "../renderer/taskWorkspaceNavigation";
import { useTaskWorkspaceController } from "../renderer/task-workspace/useTaskWorkspaceController";
import { useTaskWorkspaceClock } from "../renderer/task-workspace/useTaskWorkspaceClock";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import * as runtimeBrowser from "@planweave-ai/runtime/browser";

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const source = {
  view: "graph",
  graphSnapshot: {
    projectRoot: "/projects/demo",
    canvasId: "canvas-main",
    viewport: { x: 0, y: 0, zoom: 1 },
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

function projectedRun(runId: string, active: boolean): TaskWorkspaceRun {
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
      exitCode: active ? null : 0,
      terminalState: active ? null : "succeeded"
    },
    executionWaveId: null,
    duration: {
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: active ? null : "2026-07-13T00:00:05.000Z",
      calculatedAt: "2026-07-13T00:00:01.000Z",
      wallClockMs: active ? 1_000 : 5_000,
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

function runnerModel(runId: string): RunnerRecordReadModel {
  const identity = projectedRun(runId, true).runIdentity;
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

function workspaceHeader(active: boolean): TaskWorkspace {
  const recordId = "T-001#B-001::RUN-001";
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
    activeRecordIds: active ? [recordId] : [],
    selectedRecordId: recordId,
    latestArtifact: null,
    duration: {
      wallClock: {
        available: true,
        startedAt: "2026-07-13T00:00:00.000Z",
        endedAt: active ? null : "2026-07-13T00:00:05.000Z",
        calculatedAt: "2026-07-13T00:00:01.000Z",
        totalMs: active ? 1_000 : 5_000,
        unavailableReason: null
      },
      agentTime: {
        availability: "complete",
        totalMs: active ? 1_000 : 5_000,
        includedRunCount: 1,
        missingRunCount: 0,
        reason: null
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

function controllerApi(options: {
  active: boolean;
  readModel: RunnerRecordReadModel | null;
}) {
  const run = projectedRun("RUN-001", options.active);
  const api = {
    getBlockDetail: vi.fn(async () => ({
      ref: "T-001#B-001",
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
      promptSurfaceMarkdown: "# Rendered",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    })),
    getTaskWorkspace: vi.fn(async () => workspaceHeader(options.active)),
    listTaskWorkspaceRuns: vi.fn(async () => ({
      version: "planweave.task-workspace-runs-page/v1" as const,
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      limit: 50,
      items: [
        {
          blockRef: "T-001#B-001" as const,
          retryIndex: 1,
          active: options.active,
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run
        }
      ],
      nextCursor: null
    })),
    getTaskWorkspaceRunDetail: vi.fn(async (input: { recordId: string }) => ({
      version: "planweave.task-workspace-run-detail/v1" as const,
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      item: {
        retryIndex: 1,
        active: options.active,
        selected: true,
        waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
        run
      },
      record: record(input.recordId, options.readModel)
    })),
    getGraphViewModel: vi.fn(async () => ({
      projectId: "project-1",
      projectTitle: "Demo",
      graphVersion: "pgv-1",
      packageFingerprint: "fingerprint-1",
      executorOptions: ["manual", "codex"],
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
    subscribeRunnerRecord: vi.fn<DesktopBridgeApi["subscribeRunnerRecord"]>(async () => ({
      subscriptionId: "subscription-1",
      updateSequence: 0,
      snapshot: null,
      unsubscribe: vi.fn(async () => undefined)
    })),
    onRuntimeStateChanged: vi.fn(() => () => undefined),
    onAutoRunChanged: vi.fn(() => () => undefined),
    updateBlockPrompt: vi.fn(async () => ({ ok: true, affectedTasks: ["T-001"], diagnostics: [] })),
    updateBlockExecutor: vi.fn(async () => ({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: []
    })),
    updateTaskPrompt: vi.fn(async () => ({ ok: true, affectedTasks: ["T-001"], diagnostics: [] })),
    updateTaskExecutor: vi.fn(async () => ({ ok: true, affectedTasks: ["T-001"], diagnostics: [] }))
  };
  return api;
}

function useControllerHarness(api: ReturnType<typeof controllerApi>) {
  const [currentNavigation, setCurrentNavigation] = useState(navigation());
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

describe("Task Workspace clock isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-13T00:00:10.000Z"));
  });

  it("clears the leaf clock interval when disabled or unmounted", () => {
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useTaskWorkspaceClock(enabled),
      { initialProps: { enabled: true } }
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    rerender({ enabled: false });
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockClear();
    rerender({ enabled: true });
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("updates only leaf duration text when the clock ticks", () => {
    render(
      <div data-testid="elapsed">
        <LiveRunElapsedText
          active
          finishedAt={null}
          formatDuration={(ms) => `${ms}ms`}
          startedAt="2026-07-13T00:00:00.000Z"
          unavailable="Unavailable"
          wallClockMs={1_000}
        />
      </div>
    );
    expect(screen.getByTestId("elapsed")).toHaveTextContent("10000ms");
    act(() => {
      // Fake timers advance Date.now() with the interval; one tick → +1s elapsed.
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("11000ms");
  });

  it("does not re-project the full workspace on clock ticks when runs are active", async () => {
    const clockSpy = vi.spyOn(runtimeBrowser, "projectTaskWorkspaceClockSnapshot");
    const liveSpy = vi.spyOn(runtimeBrowser, "projectTaskWorkspaceLiveSnapshot");
    const api = controllerApi({ active: true, readModel: null });
    const { result } = renderHook(() => useControllerHarness(api));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    const workspaceBefore = result.current.workspace;
    const selectedBefore = result.current.selectedRun;
    const controllerBefore = result.current;
    const clockCallsBefore = clockSpy.mock.calls.length;
    const liveCallsBefore = liveSpy.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(result.current.workspace).toBe(workspaceBefore);
    expect(result.current.selectedRun).toBe(selectedBefore);
    expect(result.current).toBe(controllerBefore);
    expect(clockSpy.mock.calls.length).toBe(clockCallsBefore);
    expect(liveSpy.mock.calls.length).toBe(liveCallsBefore);
    expect(result.current.workspace?.blocks[0]?.runs).toHaveLength(1);
  });

  it("keeps terminal workspaces free of clock projection and controller churn", async () => {
    const clockSpy = vi.spyOn(runtimeBrowser, "projectTaskWorkspaceClockSnapshot");
    const api = controllerApi({ active: false, readModel: null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const workspaceBefore = result.current.workspace;
    const controllerBefore = result.current;
    const clockCallsBefore = clockSpy.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.workspace).toBe(workspaceBefore);
    expect(result.current).toBe(controllerBefore);
    expect(clockSpy.mock.calls.length).toBe(clockCallsBefore);
  });

  it("still applies live model projection when the runner model changes", async () => {
    const liveSpy = vi.spyOn(runtimeBrowser, "projectTaskWorkspaceLiveSnapshot");
    const api = controllerApi({ active: true, readModel: runnerModel("RUN-001") });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.liveStatus).toBe("live"));
    expect(liveSpy).toHaveBeenCalled();
    const workspaceAfterLive = result.current.workspace;
    expect(workspaceAfterLive).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    // Clock ticks must not re-invoke live projection.
    const liveCallsAfterTick = liveSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(liveSpy.mock.calls.length).toBe(liveCallsAfterTick);
  });
});

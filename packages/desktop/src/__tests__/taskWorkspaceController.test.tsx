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
  return {
    events: [],
    conversation: [],
    timeline: [],
    diagnostics: [],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId,
      afterSequence: 0,
      canonicalIdentity: null,
      terminal: false
    },
    terminal: false,
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
      exitCode: null
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
    }
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
        status: "running",
        effectiveExecutor: "codex",
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
    getTaskWorkspace: vi.fn(async (input: { selectedRecordId?: string | null }) =>
      workspace(input.selectedRecordId ?? "T-001#B-001::RUN-001")
    ),
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
    onAutoRunChanged: vi.fn(() => () => undefined)
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

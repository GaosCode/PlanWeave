import type { DesktopBridgeApi, RunnerRecordReadModel } from "@planweave-ai/runtime";
import { useCallback, useMemo, useState } from "react";
import { vi } from "vitest";
import type { AppViewHistoryController } from "../../renderer/hooks/useAppViewHistory";
import {
  taskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationTarget
} from "../../renderer/taskWorkspaceNavigation";
import { useTaskWorkspaceController } from "../../renderer/task-workspace/useTaskWorkspaceController";
import {
  navigation,
  projectedRun,
  record,
  runItems,
  taskWorkspaceSource,
  workspaceHeader
} from "./taskWorkspaceControllerModelFixture";

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
      setCurrentNavigation(taskWorkspaceNavigationIdentity(target, taskWorkspaceSource)),
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

export { controllerApi, useControlledNavigationHarness, useControllerHarness };

/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { TaskWorkspace } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  taskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationIdentity
} from "../renderer/taskWorkspaceNavigation";
import { deferred } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  controllerApi,
  useControlledNavigationHarness,
  useControllerHarness
} from "./helpers/taskWorkspaceControllerHarness";
import {
  navigation,
  projectedRun,
  record,
  runItems,
  runnerModel,
  taskWorkspaceSource,
  workspaceHeader
} from "./helpers/taskWorkspaceControllerModelFixture";

afterEach(cleanupRendererTestEnvironment);

describe("Task Workspace selected run controller", () => {
  it("keeps a compatible remote Endpoint available for both Task and Block selection", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const remoteEndpoint = {
      id: "remote:endpoint-windows",
      source: "remote" as const,
      executorName: "codex",
      displayName: "Codex",
      locationName: "LINANIML",
      capabilities: ["explicit-block-capability"],
      available: true,
      unavailableReason: null,
      remoteEndpointId: "endpoint-windows"
    };
    const { result } = renderHook(() =>
      useControllerHarness(api, navigation(), null, [remoteEndpoint])
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.agentEndpointsForTask[0]).toMatchObject({
      id: remoteEndpoint.id,
      available: true,
      unavailableReason: null
    });
    expect(result.current.agentEndpointsForBlock("T-001#B-001")[0]).toMatchObject({
      id: remoteEndpoint.id,
      available: true,
      unavailableReason: null
    });
  });

  it("does not apply an explicit Block executor capability to the Task Endpoint selector", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api, navigation()));

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(
      result.current.agentEndpointsForTask.find((endpoint) => endpoint.id === "local:codex")
    ).toMatchObject({ available: true });
    expect(
      result.current
        .agentEndpointsForBlock("T-001#B-001")
        .find((endpoint) => endpoint.id === "local:codex")
    ).toMatchObject({
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("opens a direct task target on Task Overview even when the workspace suggests a run", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const taskNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001"
      },
      taskWorkspaceSource
    );
    const { result } = renderHook(() => useControllerHarness(api, taskNavigation));

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.selectedRun).toBeNull();
    expect(result.current.selectedRecordId).toBeNull();
    expect(result.current.navigation?.recordId).toBeUndefined();
    expect(api.getTaskWorkspaceRunDetail).not.toHaveBeenCalled();
  });

  it("finishes loading after a direct block target selects its initial run", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const directNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001"
      },
      taskWorkspaceSource
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
      task: { ...initialWorkspace.task, executor: "codex" }
    };
    const pendingRefresh = deferred<TaskWorkspace>();
    api.getTaskWorkspace
      .mockResolvedValueOnce(initialWorkspace)
      .mockImplementationOnce(() => pendingRefresh.promise);
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveTaskAgentEndpoint("local:codex");
    });
    await waitFor(() => expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2));

    expect(result.current.status).toBe("ready");
    expect(result.current.workspace?.task.executor).toBe(initialWorkspace.task.executor);

    pendingRefresh.resolve(refreshedWorkspace);
    await waitFor(() => expect(result.current.workspace?.task.executor).toBe("codex"));
  });

  it("saves a Task executor without changing Block overrides", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveTaskAgentEndpoint("local:codex");
    });

    expect(api.updateTaskExecutor).toHaveBeenCalledWith(
      { projectRoot: "/projects/demo", canvasId: "canvas-main" },
      "T-001",
      "codex"
    );
    expect(api.updateBlockExecutor).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getTaskWorkspace).toHaveBeenCalledTimes(2));
  });

  it("clears a Block override when its executor is changed to inherit", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.saveBlockAgentEndpoint("T-001#B-001", null);
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

    await expect(result.current.saveTaskAgentEndpoint("local:codex")).rejects.toThrow(
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
      promptHash: "externally-updated-task-prompt-hash"
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
      taskWorkspaceSource
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

  it("reuses a previously loaded Feedback run while revisiting it", async () => {
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
      return Promise.resolve(feedbackDetail);
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
    await waitFor(() => expect(result.current.selectedRun?.item.run.kind).toBe("feedback"));

    expect(feedbackRequests).toBe(1);
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
      taskWorkspaceSource
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

  it("clears run scroll positions when the Task Workspace authority changes", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const firstNavigation = navigation();
    const secondNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/other",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        recordId: "T-001#B-001::RUN-001"
      },
      taskWorkspaceSource
    );
    const { result, rerender } = renderHook(
      ({ currentNavigation }) => useControlledNavigationHarness(api, currentNavigation),
      { initialProps: { currentNavigation: firstNavigation } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.onRunScrollTopChange("T-001#B-001::RUN-001", 120));
    expect(result.current.getRunScrollTop("T-001#B-001::RUN-001")).toBe(120);

    rerender({ currentNavigation: secondNavigation });

    expect(result.current.getRunScrollTop("T-001#B-001::RUN-001")).toBe(0);
  });

  it("does not publish an old-authority record promise after navigation changes", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const recordId = "T-001#B-001::RUN-001";
    const oldDetail = deferred<Awaited<ReturnType<typeof api.getTaskWorkspaceRunDetail>>>();
    const makeDetail = (projectRoot: string, summary: string) => ({
      version: "planweave.task-workspace-run-detail/v1" as const,
      projectRoot,
      canvasId: "canvas-main" as const,
      taskId: "T-001" as const,
      blockRef: "T-001#B-001" as const,
      item: {
        retryIndex: 1,
        active: false,
        selected: true,
        waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
        run: projectedRun("RUN-001")
      },
      record: { ...record(recordId, null), stdoutSummary: summary }
    });
    api.getTaskWorkspaceRunDetail.mockImplementation((input) =>
      input.projectRoot === "/projects/demo"
        ? oldDetail.promise
        : Promise.resolve(makeDetail(input.projectRoot, "new authority"))
    );
    const nextNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/other",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        recordId
      },
      taskWorkspaceSource
    );
    const { result, rerender } = renderHook(
      ({ currentNavigation }) => useControlledNavigationHarness(api, currentNavigation),
      { initialProps: { currentNavigation: navigation() } }
    );
    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledOnce());

    rerender({ currentNavigation: nextNavigation });
    await waitFor(() => expect(result.current.selectedRecord?.stdoutSummary).toBe("new authority"));
    oldDetail.resolve(makeDetail("/projects/demo", "old authority"));
    await act(async () => oldDetail.promise);

    expect(result.current.selectedRecord?.stdoutSummary).toBe("new authority");
    expect(result.current.recordError).toBeNull();
  });

  it("does not reuse or publish a same-record detail across Block selections", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const recordId = "FE-SHARED::RUN-FEEDBACK-001";
    const baseWorkspace = workspaceHeader(null);
    const firstBlock = baseWorkspace.blocks[0];
    if (!firstBlock) throw new Error("Expected the controller fixture to contain a Block.");
    api.getTaskWorkspace.mockResolvedValue({
      ...baseWorkspace,
      blocks: [
        firstBlock,
        {
          ...firstBlock,
          ref: "T-001#B-002",
          blockId: "B-002",
          title: "Implement second Block"
        }
      ]
    });
    const detailForBlock = (blockRef: string, marker: string) => {
      const blockId = blockRef.split("#")[1] ?? "B-001";
      const run = projectedRun("RUN-FEEDBACK-001");
      return {
        version: "planweave.task-workspace-run-detail/v1" as const,
        projectRoot: "/projects/demo",
        canvasId: "canvas-main" as const,
        taskId: "T-001" as const,
        blockRef,
        item: {
          retryIndex: 1,
          active: false,
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run: {
            ...run,
            kind: "feedback" as const,
            record: { ...run.record, blockId, recordId, ref: blockRef }
          }
        },
        record: {
          ...record(recordId, null),
          blockId,
          feedbackId: "FE-SHARED",
          kind: "feedback" as const,
          ref: blockRef,
          sourceReviewBlockRef: blockRef,
          stdoutSummary: marker
        }
      };
    };
    const firstDetail = deferred<ReturnType<typeof detailForBlock>>();
    api.getTaskWorkspaceRunDetail
      .mockImplementationOnce(() => firstDetail.promise)
      .mockResolvedValueOnce(detailForBlock("T-001#B-002", "second Block"));
    const navigationForBlock = (blockRef: string) =>
      taskWorkspaceNavigationIdentity(
        {
          projectRoot: "/projects/demo",
          canvasId: "canvas-main",
          taskId: "T-001",
          blockRef,
          recordId
        },
        taskWorkspaceSource
      );
    const { result, rerender } = renderHook(
      ({ currentNavigation }) => useControlledNavigationHarness(api, currentNavigation),
      { initialProps: { currentNavigation: navigationForBlock("T-001#B-001") } }
    );
    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledOnce());
    act(() => result.current.onRunScrollTopChange(recordId, 88));

    rerender({ currentNavigation: navigationForBlock("T-001#B-002") });
    expect(result.current.selectedRecord).toBeNull();
    expect(result.current.getRunScrollTop(recordId)).toBe(0);
    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.selectedRecord?.stdoutSummary).toBe("second Block"));
    expect(result.current.selectedRun?.block.ref).toBe("T-001#B-002");

    firstDetail.resolve(detailForBlock("T-001#B-001", "first Block"));
    await act(async () => firstDetail.promise);

    expect(result.current.selectedRecord?.stdoutSummary).toBe("second Block");
    expect(result.current.selectedRun?.block.ref).toBe("T-001#B-002");
  });

  it("does not read a synthetic remote-live record from disk", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const operationId = "operation-remote-001";
    const recordId = `T-001#B-001::remote-live-${operationId}`;
    api.getTaskWorkspace.mockResolvedValue({
      ...workspaceHeader(null),
      blocks: workspaceHeader(null).blocks.map((block) => ({
        ...block,
        remoteExecution: {
          identity: { operationId },
          controlPlane: "owner" as const,
          phase: "active" as const,
          status: "running" as const,
          actionRequired: false,
          source: { revision: "revision-001", graphFingerprint: "fingerprint-001" },
          dispatchAttempt: { dispatchId: "dispatch-001", executionAttemptId: "attempt-001" }
        }
      }))
    });
    const remoteNavigation = taskWorkspaceNavigationIdentity(
      {
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        recordId
      },
      taskWorkspaceSource
    );
    const { result } = renderHook(() => useControllerHarness(api, remoteNavigation));

    await waitFor(() => expect(result.current.selectedRecordId).toBe(recordId));
    expect(api.getTaskWorkspaceRunDetail).not.toHaveBeenCalled();
    expect(api.getTaskWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ selectedRecordId: null })
    );
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
});

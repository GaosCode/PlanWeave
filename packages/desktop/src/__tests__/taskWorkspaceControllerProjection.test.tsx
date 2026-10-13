/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopRuntimeStateChangeEvent, TaskWorkspaceRun } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { controllerApi, useControllerHarness } from "./helpers/taskWorkspaceControllerHarness";
import {
  navigation,
  projectedRun,
  record,
  runItems,
  workspaceHeader
} from "./helpers/taskWorkspaceControllerModelFixture";

afterEach(cleanupRendererTestEnvironment);

describe("Task Workspace run pagination and selected record projection", () => {
  it("refreshes the same CLI record at terminal and later report submission without unrelated detail reads", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const recordId = "T-001#B-001::RUN-001";
    let phase: "running" | "terminal" | "submitted" = "running";
    let failNextRead = false;
    const runForPhase = () => {
      const run = projectedRun("RUN-001");
      return {
        ...run,
        metadata: {
          ...run.metadata,
          adapter: "codex-cli",
          runnerKind: "cli" as const,
          exitCode: phase === "running" ? null : 0,
          submittedAt: phase === "submitted" ? "2026-07-13T00:00:04.000Z" : null
        },
        duration: {
          ...run.duration,
          finishedAt: phase === "running" ? null : "2026-07-13T00:00:03.000Z"
        }
      };
    };
    api.listTaskWorkspaceRuns.mockImplementation(async () => ({
      version: "planweave.task-workspace-runs-page/v1" as const,
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      limit: 50,
      items: runItems(recordId).map((item) =>
        item.run.record.recordId === recordId
          ? { ...item, active: phase === "running", run: runForPhase() }
          : item
      ),
      nextCursor: null
    }));
    api.getTaskWorkspaceRunDetail.mockImplementation(async () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("Temporary detail read failure");
      }
      const run = runForPhase();
      return {
        version: "planweave.task-workspace-run-detail/v1" as const,
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        item: {
          retryIndex: 1,
          active: phase === "running",
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run
        },
        record: {
          ...record(recordId, null),
          adapter: "codex-cli",
          finishedAt: phase === "running" ? null : "2026-07-13T00:00:03.000Z",
          reportPath: phase === "submitted" ? "/projects/demo/report.md" : null,
          reportMarkdown: phase === "submitted" ? "# Final report" : "",
          displayMarkdown: phase === "submitted" ? "# Final report" : "",
          displayMarkdownSource: phase === "submitted" ? ("report" as const) : ("none" as const)
        }
      };
    });
    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.selectedRecord?.reportMarkdown).toBe(""));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledOnce();
    const onRuntimeStateChanged = api.onRuntimeStateChanged.mock.calls[0]?.[0];
    if (!onRuntimeStateChanged) throw new Error("Expected runtime state listener.");
    const event: DesktopRuntimeStateChangeEvent = {
      projectRoot: "/projects/demo",
      workspaceRoot: "/projects/demo",
      registrationId: "task-controller-runtime-watch",
      canvasId: "canvas-main",
      stateFile: "/projects/demo/state.json",
      changedAt: "2026-07-13T00:00:02.000Z"
    };

    act(() => onRuntimeStateChanged(event));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(2));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledOnce();

    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2), {
      timeout: 4_000
    });
    expect(result.current.selectedRecord?.finishedAt).toBeNull();
    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(3), {
      timeout: 4_000
    });
    expect(result.current.selectedRecord?.finishedAt).toBeNull();

    failNextRead = true;
    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(4), {
      timeout: 4_000
    });
    await waitFor(() => expect(result.current.recordError).toBe("Temporary detail read failure"));
    expect(result.current.selectedRecord?.recordId).toBe(recordId);
    expect(result.current.selectedRecord?.finishedAt).toBeNull();

    phase = "terminal";
    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(5), {
      timeout: 4_000
    });
    expect(result.current.selectedRecord?.finishedAt).toBe("2026-07-13T00:00:03.000Z");
    expect(result.current.selectedRecord?.reportMarkdown).toBe("");

    phase = "submitted";
    act(() => onRuntimeStateChanged(event));
    await waitFor(() =>
      expect(result.current.selectedRecord?.reportMarkdown).toBe("# Final report")
    );
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(6);
    expect(result.current.selectedRun?.item.run.metadata.submittedAt).toBe(
      "2026-07-13T00:00:04.000Z"
    );

    act(() => result.current.selectRun(null));
    expect(result.current.selectedRecord).toBeNull();
    act(() => result.current.selectRun({ blockRef: "T-001#B-001", recordId }));
    await waitFor(() =>
      expect(result.current.selectedRecord?.reportMarkdown).toBe("# Final report")
    );
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(6);
  }, 18_000);

  it("refreshes an off-page CLI report after submission without rereading for unrelated state events", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const recordId = "T-001#B-001::RUN-001";
    let phase: "running" | "terminal" | "submitted" = "running";
    let holdStaleRead = false;
    let releaseStaleRead: (() => void) | null = null;
    const staleRead = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const runForPhase = (readPhase: typeof phase) => {
      const run = projectedRun("RUN-001");
      return {
        ...run,
        metadata: {
          ...run.metadata,
          adapter: "codex-cli",
          runnerKind: "cli" as const,
          exitCode: readPhase === "running" ? null : 0,
          submittedAt: readPhase === "submitted" ? "2026-07-13T00:00:04.000Z" : null
        },
        duration: {
          ...run.duration,
          finishedAt: readPhase === "running" ? null : "2026-07-13T00:00:03.000Z"
        }
      };
    };
    api.getTaskWorkspace.mockImplementation(async () => {
      const header = workspaceHeader(recordId);
      return {
        ...header,
        activeRecordIds: phase === "running" ? [recordId] : [],
        blocks: header.blocks.map((block) => ({
          ...block,
          status: phase === "submitted" ? ("completed" as const) : ("in_progress" as const)
        }))
      };
    });
    api.listTaskWorkspaceRuns.mockImplementation(async () => ({
      version: "planweave.task-workspace-runs-page/v1" as const,
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      limit: 50,
      items: runItems(null).filter((item) => item.run.record.recordId !== recordId),
      nextCursor: null
    }));
    api.getTaskWorkspaceRunDetail.mockImplementation(async () => {
      const readPhase = phase;
      if (holdStaleRead) {
        holdStaleRead = false;
        await staleRead;
      }
      const run = runForPhase(readPhase);
      return {
        version: "planweave.task-workspace-run-detail/v1" as const,
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        item: {
          retryIndex: 1,
          active: readPhase === "running",
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run
        },
        record: {
          ...record(recordId, null),
          adapter: "codex-cli",
          finishedAt: readPhase === "running" ? null : "2026-07-13T00:00:03.000Z",
          reportPath: readPhase === "submitted" ? "/projects/demo/report.md" : null,
          reportMarkdown: readPhase === "submitted" ? "# Off-page report" : "",
          displayMarkdown: readPhase === "submitted" ? "# Off-page report" : "",
          displayMarkdownSource: readPhase === "submitted" ? ("report" as const) : ("none" as const)
        }
      };
    });

    const { result } = renderHook(() => useControllerHarness(api));
    await waitFor(() => expect(result.current.selectedRecord?.recordId).toBe(recordId));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledOnce();
    const onRuntimeStateChanged = api.onRuntimeStateChanged.mock.calls[0]?.[0];
    if (!onRuntimeStateChanged) throw new Error("Expected runtime state listener.");
    const event: DesktopRuntimeStateChangeEvent = {
      projectRoot: "/projects/demo",
      workspaceRoot: "/projects/demo",
      registrationId: "task-controller-runtime-watch",
      canvasId: "canvas-main",
      stateFile: "/projects/demo/state.json",
      changedAt: "2026-07-13T00:00:02.000Z"
    };

    phase = "terminal";
    await waitFor(() => expect(result.current.selectedRecord?.finishedAt).not.toBeNull(), {
      timeout: 4_000
    });
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2);
    expect(result.current.selectedRecord?.reportMarkdown).toBe("");

    act(() => onRuntimeStateChanged(event));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(2));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2);
    act(() => onRuntimeStateChanged(event));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(3));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2);

    holdStaleRead = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(4));

    phase = "submitted";
    act(() => onRuntimeStateChanged(event));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(5));
    await waitFor(() =>
      expect(result.current.selectedRecord?.reportMarkdown).toBe("# Off-page report")
    );
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(4);

    await act(async () => {
      releaseStaleRead?.();
      await staleRead;
    });
    expect(result.current.selectedRecord?.reportMarkdown).toBe("# Off-page report");
    act(() => onRuntimeStateChanged(event));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(6));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(4);
  }, 12_000);

  it("refreshes an off-page CLI report when its first state event follows an A-to-B selection", async () => {
    const { api } = controllerApi({ readModel: () => null });
    const firstRecordId = "T-001#B-001::RUN-002";
    const offPageRecordId = "T-001#B-001::RUN-001";
    let submitted = false;
    api.getTaskWorkspace.mockImplementation(async () => {
      const header = workspaceHeader(firstRecordId);
      return {
        ...header,
        blocks: header.blocks.map((block) => ({
          ...block,
          status: submitted ? ("completed" as const) : ("in_progress" as const)
        }))
      };
    });
    api.listTaskWorkspaceRuns.mockImplementation(async () => ({
      version: "planweave.task-workspace-runs-page/v1" as const,
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      limit: 50,
      items: runItems(firstRecordId).filter((item) => item.run.record.recordId === firstRecordId),
      nextCursor: null
    }));
    api.getTaskWorkspaceRunDetail.mockImplementation(async (input: { recordId: string }) => {
      const isOffPage = input.recordId === offPageRecordId;
      const run = projectedRun(isOffPage ? "RUN-001" : "RUN-002");
      const terminalRun = {
        ...run,
        metadata: {
          ...run.metadata,
          adapter: "codex-cli",
          runnerKind: "cli" as const,
          exitCode: 0,
          submittedAt: submitted ? "2026-07-13T00:00:04.000Z" : null
        },
        duration: { ...run.duration, finishedAt: "2026-07-13T00:00:03.000Z" }
      };
      return {
        version: "planweave.task-workspace-run-detail/v1" as const,
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        item: {
          retryIndex: isOffPage ? 1 : 2,
          active: false,
          selected: true,
          waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
          run: isOffPage ? terminalRun : run
        },
        record: {
          ...record(input.recordId, null),
          finishedAt: isOffPage ? "2026-07-13T00:00:03.000Z" : null,
          reportPath: isOffPage && submitted ? "/projects/demo/report.md" : null,
          reportMarkdown: isOffPage && submitted ? "# B report" : "",
          displayMarkdown: isOffPage && submitted ? "# B report" : "",
          displayMarkdownSource: isOffPage && submitted ? ("report" as const) : ("none" as const)
        }
      };
    });

    const { result } = renderHook(() => useControllerHarness(api, navigation(firstRecordId)));
    await waitFor(() => expect(result.current.selectedRecord?.recordId).toBe(firstRecordId));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledOnce();
    act(() => result.current.selectRun({ blockRef: "T-001#B-001", recordId: offPageRecordId }));
    await waitFor(() => expect(result.current.selectedRecord?.recordId).toBe(offPageRecordId));
    expect(result.current.selectedRecord?.reportMarkdown).toBe("");
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(2);
    expect(api.listTaskWorkspaceRuns).toHaveBeenCalledOnce();

    const onRuntimeStateChanged = api.onRuntimeStateChanged.mock.calls[0]?.[0];
    if (!onRuntimeStateChanged) throw new Error("Expected runtime state listener.");
    const event: DesktopRuntimeStateChangeEvent = {
      projectRoot: "/projects/demo",
      workspaceRoot: "/projects/demo",
      registrationId: "task-controller-runtime-watch",
      canvasId: "canvas-main",
      stateFile: "/projects/demo/state.json",
      changedAt: "2026-07-13T00:00:04.000Z"
    };
    submitted = true;
    act(() => onRuntimeStateChanged(event));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.selectedRecord?.reportMarkdown).toBe("# B report"));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(3);

    act(() => onRuntimeStateChanged(event));
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalledTimes(3));
    expect(api.getTaskWorkspaceRunDetail).toHaveBeenCalledTimes(3);
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

/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { TaskWorkspaceRun } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { controllerApi, useControllerHarness } from "./helpers/taskWorkspaceControllerHarness";
import {
  navigation,
  projectedRun,
  record,
  workspaceHeader
} from "./helpers/taskWorkspaceControllerModelFixture";

afterEach(cleanupRendererTestEnvironment);

describe("Task Workspace run pagination and selected record projection", () => {
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

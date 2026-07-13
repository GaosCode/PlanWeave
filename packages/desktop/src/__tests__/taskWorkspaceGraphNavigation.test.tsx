/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewHistoryController } from "../renderer/hooks/useAppViewHistory";
import { useTaskWorkspaceGraphNavigation } from "../renderer/task-workspace/useTaskWorkspaceGraphNavigation";
import type { GraphNavigationSnapshot } from "../renderer/taskWorkspaceNavigation";
import type { AppFlowNode } from "../renderer/types";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { graph } from "./helpers/graphFixtures";
import { deferred, project } from "./helpers/desktopProjectFixtures";

afterEach(cleanupRendererTestEnvironment);

const snapshot: GraphNavigationSnapshot = {
  projectRoot: project.rootPath,
  canvasId: "canvas-main",
  viewport: { x: 120, y: -80, zoom: 1.25 },
  selectedTaskId: "T-ALPHA",
  selectedBlockRef: "T-ALPHA#B-001"
};

const graphWithBlock: DesktopGraphViewModel = {
  ...graph,
  tasks: graph.tasks.map((task) =>
    task.taskId === "T-ALPHA"
      ? {
          ...task,
          blocks: [
            {
              ref: "T-ALPHA#B-001",
              blockId: "B-001",
              type: "implementation",
              title: "Implement workspace",
              status: "ready",
              executor: null,
              promptMissing: false,
              exceptionReason: null,
              dispatchable: true,
              waitingOn: null
            }
          ]
        }
      : task
  )
};

function historyController(
  graphSnapshot: GraphNavigationSnapshot | null = null
): AppViewHistoryController {
  return {
    graphSnapshot,
    historyError: null,
    historyIndex: 1,
    openTaskWorkspace: vi.fn(),
    replaceTaskWorkspaceTarget: vi.fn(),
    returnToTaskWorkspaceSource: vi.fn(),
    route: graphSnapshot ? { view: "graph", graphSnapshot } : { view: "graph" },
    taskWorkspaceNavigation: null
  };
}

function flowInstance() {
  return {
    getViewport: vi.fn(() => ({ x: 12, y: 34, zoom: 0.8 })),
    setViewport: vi.fn().mockResolvedValue(true)
  } as ReactFlowInstance<AppFlowNode, Edge>;
}

describe("Task Workspace graph navigation", () => {
  it("captures the exact graph identity and viewport for Task and Block entry", () => {
    const history = historyController();
    const flow = flowInstance();
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useTaskWorkspaceGraphNavigation({
        flowInstance: flow,
        graph: graphWithBlock,
        history,
        openProject: vi.fn(),
        projectLoading: false,
        projects: [project],
        restoreSelection: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError
      })
    );

    act(() => result.current.openTaskWorkspace("T-ALPHA"));
    expect(history.openTaskWorkspace).toHaveBeenLastCalledWith(
      {
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        taskId: "T-ALPHA"
      },
      {
        view: "graph",
        graphSnapshot: {
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          viewport: { x: 12, y: 34, zoom: 0.8 },
          selectedTaskId: "T-ALPHA",
          selectedBlockRef: null
        }
      }
    );

    act(() => result.current.openBlockWorkspace("T-ALPHA#B-001"));
    expect(history.openTaskWorkspace).toHaveBeenLastCalledWith(
      {
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        taskId: "T-ALPHA",
        blockRef: "T-ALPHA#B-001"
      },
      expect.objectContaining({
        view: "graph",
        graphSnapshot: expect.objectContaining({
          selectedTaskId: "T-ALPHA",
          selectedBlockRef: "T-ALPHA#B-001"
        })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps source selection empty when a cross-authority run target reuses local refs", () => {
    const history = historyController();
    const { result } = renderHook(() =>
      useTaskWorkspaceGraphNavigation({
        flowInstance: flowInstance(),
        graph: graphWithBlock,
        history,
        openProject: vi.fn(),
        projectLoading: false,
        projects: [project],
        restoreSelection: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn()
      })
    );

    act(() =>
      result.current.openRunWorkspace({
        projectRoot: "/projects/other",
        canvasId: "canvas-other",
        taskId: "T-ALPHA",
        blockRef: "T-ALPHA#B-001",
        recordId: "T-ALPHA#B-001::RUN-001"
      })
    );

    expect(history.openTaskWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/projects/other",
        canvasId: "canvas-other",
        taskId: "T-ALPHA",
        blockRef: "T-ALPHA#B-001",
        recordId: "T-ALPHA#B-001::RUN-001"
      }),
      expect.objectContaining({
        view: "graph",
        graphSnapshot: expect.objectContaining({
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          selectedTaskId: null,
          selectedBlockRef: null
        })
      })
    );
  });

  it("reloads the captured canvas before restoring selection and viewport", async () => {
    const history = historyController(snapshot);
    const flow = flowInstance();
    const projectLoad = deferred<void>();
    const openProject = vi.fn(() => projectLoad.promise);
    const restoreSelection = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    const { rerender } = renderHook(
      (props: { selected: boolean }) =>
        useTaskWorkspaceGraphNavigation({
          flowInstance: props.selected ? flow : null,
          graph: props.selected ? graphWithBlock : null,
          history,
          openProject,
          projectLoading: false,
          projects: [project],
          restoreSelection,
          selectedCanvasId: props.selected ? "canvas-main" : null,
          selectedProject: props.selected ? project : null,
          setError
        }),
      { initialProps: { selected: false } }
    );

    await waitFor(() =>
      expect(openProject).toHaveBeenCalledWith(project, "canvas-main", {
        recordCanvasSelection: false
      })
    );
    rerender({ selected: true });
    expect(restoreSelection).not.toHaveBeenCalled();

    await act(async () => projectLoad.resolve());

    await waitFor(() => expect(restoreSelection).toHaveBeenCalledWith("T-ALPHA", "T-ALPHA#B-001"));
    expect(flow.setViewport).toHaveBeenCalledWith(snapshot.viewport, { duration: 0 });
    expect(openProject.mock.invocationCallOrder[0]).toBeLessThan(
      restoreSelection.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("cancels a deferred canvas restore after leaving its graph route", async () => {
    const projectLoad = deferred<void>();
    const openProject = vi.fn(() => projectLoad.promise);
    const restoreSelection = vi.fn().mockResolvedValue(undefined);
    const flow = flowInstance();
    const setError = vi.fn();
    const { rerender } = renderHook(
      (props: { history: AppViewHistoryController }) =>
        useTaskWorkspaceGraphNavigation({
          flowInstance: flow,
          graph: graphWithBlock,
          history: props.history,
          openProject,
          projectLoading: false,
          projects: [project],
          restoreSelection,
          selectedCanvasId: null,
          selectedProject: null,
          setError
        }),
      { initialProps: { history: historyController(snapshot) } }
    );

    await waitFor(() => expect(openProject).toHaveBeenCalledOnce());
    rerender({
      history: {
        ...historyController(null),
        historyIndex: 2,
        route: { view: "canvas-map" }
      }
    });
    await act(async () => projectLoad.resolve());

    expect(restoreSelection).not.toHaveBeenCalled();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("lets a rapid newer graph route win over an older deferred restore", async () => {
    const olderProjectLoad = deferred<void>();
    const openProject = vi.fn(() => olderProjectLoad.promise);
    const restoreSelection = vi.fn().mockResolvedValue(undefined);
    const flow = flowInstance();
    const setError = vi.fn();
    const newerSnapshot: GraphNavigationSnapshot = {
      ...snapshot,
      viewport: { x: -40, y: 75, zoom: 0.7 },
      selectedBlockRef: null
    };
    const { rerender } = renderHook(
      (props: {
        history: AppViewHistoryController;
        selectedCanvasId: string | null;
        selectedProject: typeof project | null;
      }) =>
        useTaskWorkspaceGraphNavigation({
          flowInstance: flow,
          graph: graphWithBlock,
          history: props.history,
          openProject,
          projectLoading: false,
          projects: [project],
          restoreSelection,
          selectedCanvasId: props.selectedCanvasId,
          selectedProject: props.selectedProject,
          setError
        }),
      {
        initialProps: {
          history: historyController(snapshot),
          selectedCanvasId: null,
          selectedProject: null
        }
      }
    );

    await waitFor(() => expect(openProject).toHaveBeenCalledOnce());
    rerender({
      history: { ...historyController(newerSnapshot), historyIndex: 3 },
      selectedCanvasId: "canvas-main",
      selectedProject: project
    });
    await waitFor(() =>
      expect(flow.setViewport).toHaveBeenCalledWith(newerSnapshot.viewport, { duration: 0 })
    );
    await act(async () => olderProjectLoad.resolve());

    expect(restoreSelection).toHaveBeenCalledTimes(1);
    expect(restoreSelection).toHaveBeenCalledWith("T-ALPHA", null);
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("reports stale graph identity without restoring a fallback selection", async () => {
    const history = historyController(snapshot);
    const flow = flowInstance();
    const restoreSelection = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    renderHook(() =>
      useTaskWorkspaceGraphNavigation({
        flowInstance: flow,
        graph,
        history,
        openProject: vi.fn(),
        projectLoading: false,
        projects: [project],
        restoreSelection,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError
      })
    );

    await waitFor(() =>
      expect(setError).toHaveBeenCalledWith(
        expect.stringContaining("Block 'T-ALPHA#B-001' is unavailable")
      )
    );
    expect(restoreSelection).not.toHaveBeenCalled();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});

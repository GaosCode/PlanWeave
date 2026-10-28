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
              dispatchable: true
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
        captureEntrySelection: () => ({ isCurrent: () => true }),
        captureSelectionScope: () => ({ isCurrent: () => true }),
        flowInstance: flow,
        getFlowInstance: () => flow,
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

  it("opens a Block workspace from Server authority without requiring a local project path", () => {
    const history = historyController();
    const flow = flowInstance();
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useTaskWorkspaceGraphNavigation({
        captureEntrySelection: () => ({ isCurrent: () => true }),
        captureSelectionScope: () => ({ isCurrent: () => true }),
        canvasLocator: {
          kind: "workspace",
          connectionProfileId: "profile-workspace",
          workspaceId: "workspace-demo",
          projectId: "project-demo",
          canvasId: "canvas-main"
        },
        flowInstance: flow,
        getFlowInstance: () => flow,
        graph: graphWithBlock,
        history,
        openProject: vi.fn(),
        projectLoading: false,
        projects: [project],
        restoreSelection: vi.fn(),
        selectedCanvasId: null,
        selectedProject: null,
        setError
      })
    );

    act(() => result.current.openBlockWorkspace("T-ALPHA#B-001"));

    expect(history.openTaskWorkspace).toHaveBeenCalledWith(
      {
        authority: "workspace",
        connectionProfileId: "profile-workspace",
        workspaceId: "workspace-demo",
        projectId: "project-demo",
        canvasId: "canvas-main",
        taskId: "T-ALPHA",
        blockRef: "T-ALPHA#B-001"
      },
      { view: "graph" }
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps source selection empty when a cross-authority run target reuses local refs", () => {
    const history = historyController();
    const flow = flowInstance();
    const { result } = renderHook(() =>
      useTaskWorkspaceGraphNavigation({
        captureEntrySelection: () => ({ isCurrent: () => true }),
        captureSelectionScope: () => ({ isCurrent: () => true }),
        flowInstance: flow,
        getFlowInstance: () => flow,
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
    const restoreSelection = vi.fn().mockResolvedValue({ isCurrent: () => true });
    const setError = vi.fn();
    const { rerender } = renderHook(
      (props: { selected: boolean }) =>
        useTaskWorkspaceGraphNavigation({
          captureEntrySelection: () => ({ isCurrent: () => true }),
          captureSelectionScope: () => ({ isCurrent: () => true }),
          flowInstance: props.selected ? flow : null,
          getFlowInstance: () => (props.selected ? flow : null),
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
    const restoreSelection = vi.fn().mockResolvedValue({ isCurrent: () => true });
    const flow = flowInstance();
    const setError = vi.fn();
    const { rerender } = renderHook(
      (props: { history: AppViewHistoryController }) =>
        useTaskWorkspaceGraphNavigation({
          captureEntrySelection: () => ({ isCurrent: () => true }),
          captureSelectionScope: () => ({ isCurrent: () => true }),
          flowInstance: flow,
          getFlowInstance: () => flow,
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
    const restoreSelection = vi.fn().mockResolvedValue({ isCurrent: () => true });
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
          captureEntrySelection: () => ({ isCurrent: () => true }),
          captureSelectionScope: () => ({ isCurrent: () => true }),
          flowInstance: flow,
          getFlowInstance: () => flow,
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
    const restoreSelection = vi.fn().mockResolvedValue({ isCurrent: () => true });
    const setError = vi.fn();
    renderHook(() =>
      useTaskWorkspaceGraphNavigation({
        captureEntrySelection: () => ({ isCurrent: () => true }),
        captureSelectionScope: () => ({ isCurrent: () => true }),
        flowInstance: flow,
        getFlowInstance: () => flow,
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
  it.each([
    "selection pending",
    "viewport false",
    "viewport pending",
    "viewport reject"
  ] as const)("restores on the current instance after %s without retrying an unavailable instance", async (phase) => {
    const selection = deferred<{ isCurrent: () => boolean }>();
    const viewport = deferred<boolean>();
    const oldFlow = flowInstance();
    const newFlow = flowInstance();
    const restoreSelection = vi.fn().mockResolvedValue({ isCurrent: () => true });
    if (phase === "selection pending")
      restoreSelection.mockImplementationOnce(() => selection.promise);
    if (phase === "viewport false") vi.mocked(oldFlow.setViewport).mockResolvedValue(false);
    if (phase === "viewport pending" || phase === "viewport reject")
      vi.mocked(oldFlow.setViewport).mockImplementationOnce(() => viewport.promise);
    const history = historyController(snapshot);
    const setError = vi.fn();
    let currentFlow = oldFlow;
    const getFlowInstance = () => currentFlow;
    const { rerender } = renderHook(
      ({ flow, currentGraph }) =>
        useTaskWorkspaceGraphNavigation({
          captureEntrySelection: () => ({ isCurrent: () => true }),
          captureSelectionScope: () => ({ isCurrent: () => true }),
          flowInstance: flow,
          getFlowInstance,
          graph: currentGraph,
          history,
          openProject: vi.fn(),
          projectLoading: false,
          projects: [project],
          restoreSelection,
          selectedCanvasId: "canvas-main",
          selectedProject: project,
          setError
        }),
      { initialProps: { flow: oldFlow, currentGraph: graphWithBlock } }
    );
    await waitFor(() => expect(restoreSelection).toHaveBeenCalledOnce());
    if (phase !== "selection pending") {
      await waitFor(() => expect(oldFlow.setViewport).toHaveBeenCalledOnce());
      await act(async () => undefined);
      rerender({ flow: oldFlow, currentGraph: { ...graphWithBlock } });
      await act(async () => undefined);
      expect(restoreSelection).toHaveBeenCalledOnce();
    }
    currentFlow = newFlow;
    rerender({ flow: newFlow, currentGraph: graphWithBlock });
    await act(async () => {
      selection.resolve({ isCurrent: () => true });
      if (phase === "viewport reject") viewport.reject(new Error("old instance failed"));
      else viewport.resolve(true);
    });
    await waitFor(() =>
      expect(newFlow.setViewport).toHaveBeenCalledWith(snapshot.viewport, { duration: 0 })
    );
    expect(oldFlow.setViewport).toHaveBeenCalledTimes(phase === "selection pending" ? 0 : 1);
    expect(newFlow.setViewport).toHaveBeenCalledOnce();
    expect(setError).not.toHaveBeenCalled();
  });
  it("retires an accepted selection after viewport false if a new selection wins before the next onInit", async () => {
    const oldFlow = flowInstance();
    const newFlow = flowInstance();
    vi.mocked(oldFlow.setViewport).mockResolvedValue(false);
    let current = true;
    const restoreSelection = vi.fn().mockResolvedValue({ isCurrent: () => current });
    const history = historyController(snapshot);
    const { rerender } = renderHook(
      ({ flow }) =>
        useTaskWorkspaceGraphNavigation({
          captureEntrySelection: () => ({ isCurrent: () => true }),
          captureSelectionScope: () => ({ isCurrent: () => true }),
          flowInstance: flow,
          getFlowInstance: () => flow,
          graph: graphWithBlock,
          history,
          openProject: vi.fn(),
          projectLoading: false,
          projects: [project],
          restoreSelection,
          selectedCanvasId: "canvas-main",
          selectedProject: project,
          setError: vi.fn()
        }),
      { initialProps: { flow: oldFlow } }
    );
    await waitFor(() => expect(oldFlow.setViewport).toHaveBeenCalledOnce());
    await act(async () => undefined);
    current = false;
    rerender({ flow: newFlow });
    await act(async () => undefined);
    expect(restoreSelection).toHaveBeenCalledOnce();
    expect(newFlow.setViewport).not.toHaveBeenCalled();
  });
  it.each([
    "Block",
    "Task",
    "Run"
  ] as const)("waits for the current owner before opening a %s target", async (kind) => {
    const history = historyController();
    let owner: ReturnType<typeof flowInstance> | null = null;
    const getFlowInstance = () => owner;
    const setError = vi.fn();
    const { result, rerender } = renderHook(
      ({ flow }) =>
        useTaskWorkspaceGraphNavigation({
          captureEntrySelection: () => ({ isCurrent: () => true }),
          captureSelectionScope: () => ({ isCurrent: () => true }),
          flowInstance: flow,
          getFlowInstance,
          graph: graphWithBlock,
          history,
          openProject: vi.fn(),
          projectLoading: false,
          projects: [project],
          restoreSelection: vi.fn(),
          selectedCanvasId: "canvas-main",
          selectedProject: project,
          setError
        }),
      { initialProps: { flow: owner } }
    );
    act(() => {
      if (kind === "Block") result.current.openBlockWorkspace("T-ALPHA#B-001");
      else if (kind === "Task") result.current.openTaskWorkspace("T-ALPHA");
      else
        result.current.openRunWorkspace({
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          taskId: "T-ALPHA",
          blockRef: "T-ALPHA#B-001",
          recordId: "T-ALPHA#B-001::RUN-001"
        });
    });
    expect(history.openTaskWorkspace).not.toHaveBeenCalled();
    owner = flowInstance();
    rerender({ flow: owner });
    await waitFor(() => expect(history.openTaskWorkspace).toHaveBeenCalledOnce());
    expect(history.openTaskWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "T-ALPHA" }),
      expect.objectContaining({
        graphSnapshot: expect.objectContaining({ viewport: { x: 12, y: 34, zoom: 0.8 } })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it.each([
    "canvas",
    "route",
    "same-scope reopen",
    "unmount"
  ] as const)("cancels pending entry and old callbacks on %s", async (change) => {
    let generation = 0;
    const captureSelectionScope = () => {
      const captured = generation;
      return { isCurrent: () => captured === generation };
    };
    const originalHistory = historyController();
    let owner: ReturnType<typeof flowInstance> | null = null;
    const getFlowInstance = () => owner;
    const { result, rerender, unmount } = renderHook(
      ({ canvasId, history, flow }) =>
        useTaskWorkspaceGraphNavigation({
          captureEntrySelection: () => ({ isCurrent: () => true }),
          captureSelectionScope,
          flowInstance: flow,
          getFlowInstance,
          graph: graphWithBlock,
          history,
          openProject: vi.fn(),
          projectLoading: false,
          projects: [project],
          restoreSelection: vi.fn(),
          selectedCanvasId: canvasId,
          selectedProject: project,
          setError: vi.fn()
        }),
      { initialProps: { canvasId: "canvas-main", history: originalHistory, flow: owner } }
    );
    const oldEntry = result.current.openBlockWorkspace;
    act(() => oldEntry("T-ALPHA#B-001"));
    if (change === "unmount") unmount();
    else {
      if (change === "same-scope reopen") generation++;
      rerender({
        canvasId: change === "canvas" ? "canvas-next" : "canvas-main",
        history:
          change === "route"
            ? { ...originalHistory, historyIndex: 2, route: { view: "search" } }
            : originalHistory,
        flow: null
      });
      owner = flowInstance();
      // Returning to the same IDs must not revive the previous generation.
      rerender({ canvasId: "canvas-main", history: originalHistory, flow: owner });
    }
    act(() => oldEntry("T-ALPHA#B-001"));
    await act(async () => undefined);
    expect(originalHistory.openTaskWorkspace).not.toHaveBeenCalled();
    if (change !== "unmount") {
      act(() => result.current.openBlockWorkspace("T-ALPHA#B-001"));
      expect(originalHistory.openTaskWorkspace).toHaveBeenCalledOnce();
    }
  });
});

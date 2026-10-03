/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopBlockDetail,
  DesktopBridgeApi,
  DesktopGraphEditResult
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";
import type { AppFlowNode, DesktopUiSettings } from "../renderer/types";
import { deferred, layout, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function dependencyEdge(to: string) {
  return {
    id: to,
    source: to,
    target: "T",
    data: { manifestEdgeType: "depends_on", manifestFrom: "T", manifestTo: to }
  };
}

async function renderDeletionActions(overrides: Partial<DesktopBridgeApi> = {}) {
  const removeDependencyEdge = vi
    .fn<DesktopBridgeApi["removeDependencyEdge"]>()
    .mockResolvedValue({ ok: true, affectedTasks: [], diagnostics: [], graphVersion: "pgv-2" });
  const bridge = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([]),
    getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
    getGraphViewModel: vi.fn().mockResolvedValue(graph),
    removeDependencyEdge,
    ...overrides
  });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
  const setError = vi.fn();
  const t = createTranslator("en");
  const updateSettings = vi.fn();
  const hook = renderHook(() => {
    const desktop = useDesktopProject({ planweaveHome: "", setError, t, updateSettings });
    const actions = useGraphPaletteActions({
      captureProjectSelection: desktop.captureProjectSelection,
      flowInstance: null,
      graph: desktop.graph,
      layout: null,
      loadProject: desktop.loadProject,
      nodes: [],
      refreshProjectDerivedState: desktop.refreshProjectDerivedState,
      selectedCanvasId: desktop.selectedCanvasId,
      selectedBlock: null,
      selectedProject: desktop.selectedProject,
      selectedTaskPanelId: null,
      setError,
      setLayout: vi.fn(),
      selectTaskPanel: vi.fn(),
      settings: { defaultExecutor: "" } as DesktopUiSettings,
      t
    });
    return { desktop, actions };
  });
  await act(async () => {
    await hook.result.current.desktop.loadProject(project, "canvas-main");
  });
  vi.mocked(bridge.getDesktopProjectSnapshot).mockClear();
  setError.mockClear();
  return { ...hook, bridge, setError };
}

describe("desktop renderer hook interfaces", () => {
  it("uses the latest graphVersion when deleting dependency edges after a graph refresh", async () => {
    const bridge = createDesktopBridgeMock({
      removeDependencyEdge: vi
        .fn()
        .mockResolvedValue({ ok: true, graphVersion: "pgv-deleted", diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const visibleNodes = [
      { id: "T-ALPHA", position: { x: 120, y: 80 } },
      { id: "T-BETA", position: { x: 580, y: 80 } }
    ] as AppFlowNode[];
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const baseArgs = {
      captureProjectSelection: () => ({ isCurrent: () => true }),
      flowInstance: null,
      layout: null,
      loadProject: vi.fn().mockResolvedValue(undefined),
      nodes: visibleNodes,
      refreshProjectDerivedState,
      selectedCanvasId: "canvas-main",
      selectedBlock: null,
      selectedProject: project,
      selectedTaskPanelId: null,
      setError: vi.fn(),
      setLayout: vi.fn(),
      selectTaskPanel: vi.fn(),
      settings: {
        defaultExecutor: "",
        palette: {
          defaultBlockSet: ["implementation"],
          dragHint: true,
          visible: { task: true, implementation: true, review: true }
        }
      } as unknown as DesktopUiSettings,
      t: createTranslator("en")
    };
    const { result, rerender } = renderHook(
      ({ currentGraph }) =>
        useGraphPaletteActions({
          ...baseArgs,
          graph: currentGraph
        }),
      {
        initialProps: { currentGraph: { ...graph, graphVersion: "pgv-before" } }
      }
    );

    rerender({ currentGraph: { ...graph, graphVersion: "pgv-after" } });
    await act(async () => {
      await result.current.handleEdgesDelete([
        {
          id: "T-ALPHA->T-BETA",
          source: "T-BETA",
          target: "T-ALPHA",
          data: { manifestEdgeType: "depends_on", manifestFrom: "T-ALPHA", manifestTo: "T-BETA" }
        } as never
      ]);
    });

    expect(bridge.removeDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "pgv-after",
      {
        version: "desktop-layout/v1",
        projectId: graph.projectId,
        nodes: [
          { nodeId: "T-ALPHA", x: 120, y: 80 },
          { nodeId: "T-BETA", x: 580, y: 80 }
        ],
        updatedAt: new Date(0).toISOString()
      }
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it.each([
    "success",
    "conflict",
    "io"
  ])("finishes sequential dependency deletion on %s", async (outcome) => {
    let version = "pgv-before";
    let completed = 0;
    const removeDependencyEdge = vi.fn(async (_canvas, _from, _to, baseVersion) => {
      if (baseVersion !== version)
        return { ok: false, diagnostics: [{ message: "stale version" }] };
      if (completed === 1 && outcome === "conflict")
        return { ok: false, diagnostics: [{ message: "external conflict" }] };
      if (completed === 1 && outcome === "io") throw new Error("disk failed");
      completed += 1;
      version = `pgv-${completed + 1}`;
      return { ok: true, graphVersion: version, diagnostics: [] };
    });
    vi.stubGlobal("planweave", createDesktopBridgeMock({ removeDependencyEdge }));
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const refreshProjectDerivedState = vi.fn(async () => {
      if (outcome !== "success") throw new Error("refresh failed");
    });
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        captureProjectSelection: () => ({ isCurrent: () => true }),
        flowInstance: null,
        graph: { ...graph, graphVersion: version },
        layout: null,
        loadProject: vi.fn(),
        nodes: [],
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError,
        setLayout: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: { defaultExecutor: "" } as DesktopUiSettings,
        t: createTranslator("en")
      })
    );
    const edges = ["C", "A", "B", "A"].map((to) => ({
      id: to,
      source: to,
      target: "T",
      data: { manifestEdgeType: "depends_on", manifestFrom: "T", manifestTo: to }
    }));
    await act(async () => {
      await result.current.handleEdgesDelete(edges);
    });
    expect(completed).toBe(outcome === "success" ? 3 : 1);
    expect(removeDependencyEdge).toHaveBeenCalledTimes(outcome === "success" ? 3 : 2);
    expect(removeDependencyEdge.mock.calls.map((call) => call[2])).toEqual(
      outcome === "success" ? ["A", "B", "C"] : ["A", "B"]
    );
    expect(removeDependencyEdge.mock.calls.map((call) => call[3])).toEqual(
      outcome === "success" ? ["pgv-before", "pgv-2", "pgv-3"] : ["pgv-before", "pgv-2"]
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    if (outcome !== "success") {
      expect(setError).toHaveBeenLastCalledWith(
        `Deleted 1 dependencies; 2 not deleted.\n${outcome === "conflict" ? "external conflict" : "disk failed"}\nGraph refresh failed: refresh failed`
      );
    }
  });

  it("counts the second committed deletion despite a post-commit failure and stops remaining writes", async () => {
    const removeDependencyEdge = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        graphVersion: "pgv-2",
        affectedTasks: [],
        diagnostics: []
      })
      .mockResolvedValueOnce({
        ok: false,
        graphVersion: "pgv-3",
        committed: { graphVersion: "pgv-3" },
        affectedTasks: ["T"],
        diagnostics: [{ code: "desktop_post_commit_failed", message: "Layout save failed: EISDIR" }]
      });
    const { result, bridge, setError } = await renderDeletionActions({ removeDependencyEdge });
    await act(async () => {
      await result.current.actions.handleEdgesDelete([
        dependencyEdge("A"),
        dependencyEdge("B"),
        dependencyEdge("C")
      ]);
    });
    expect(removeDependencyEdge).toHaveBeenCalledTimes(2);
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith(
      "Deleted 2 dependencies; 1 not deleted.\nLayout save failed: EISDIR"
    );
  });

  it("refreshes and reports zero completed dependencies after the first rejection", async () => {
    const removeDependencyEdge = vi
      .fn<DesktopBridgeApi["removeDependencyEdge"]>()
      .mockResolvedValue({
        ok: false,
        affectedTasks: [],
        diagnostics: [{ code: "graph_version_conflict", message: "first external conflict" }]
      });
    const { result, bridge, setError } = await renderDeletionActions({ removeDependencyEdge });
    await act(async () => {
      await result.current.actions.handleEdgesDelete([
        dependencyEdge("A"),
        dependencyEdge("B"),
        dependencyEdge("C")
      ]);
    });
    expect(removeDependencyEdge).toHaveBeenCalledTimes(1);
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith(
      "Deleted 0 dependencies; 3 not deleted.\nfirst external conflict"
    );
  });

  it.each(["empty", "invalid", "mixed"])("filters %s dependency deletion input", async (kind) => {
    const { result, bridge, setError } = await renderDeletionActions();
    const invalid = [
      { id: "self", source: "T", target: "T" },
      { ...dependencyEdge("ignored"), data: { manifestEdgeType: "contains" } }
    ];
    const edges =
      kind === "empty"
        ? []
        : kind === "invalid"
          ? invalid
          : [
              dependencyEdge("B"),
              dependencyEdge("A"),
              { ...dependencyEdge("A"), id: "duplicate-view-id" },
              ...invalid
            ];
    await act(async () => {
      await result.current.actions.handleEdgesDelete(edges);
    });
    expect(bridge.removeDependencyEdge).toHaveBeenCalledTimes(kind === "mixed" ? 2 : 0);
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(kind === "mixed" ? 1 : 0);
    if (kind === "mixed")
      expect(vi.mocked(bridge.removeDependencyEdge).mock.calls.map((call) => call[2])).toEqual([
        "A",
        "B"
      ]);
    expect(setError).not.toHaveBeenCalled();
  });

  it.each([
    ["canvas", "success"],
    ["canvas", "failure"],
    ["aba", "success"],
    ["aba", "failure"],
    ["unmount", "success"],
    ["unmount", "failure"]
  ])("stops unissued deletions after %s and an in-flight %s", async (navigation, completion) => {
    const pendingDelete = deferred<DesktopGraphEditResult>();
    const removeDependencyEdge = vi
      .fn<DesktopBridgeApi["removeDependencyEdge"]>()
      .mockReturnValue(pendingDelete.promise);
    const { result, unmount, bridge, setError } = await renderDeletionActions({
      removeDependencyEdge
    });
    let deletion!: Promise<void>;
    act(() => {
      deletion = result.current.actions.handleEdgesDelete([
        dependencyEdge("A"),
        dependencyEdge("B"),
        dependencyEdge("C")
      ]);
    });
    expect(removeDependencyEdge).toHaveBeenCalledTimes(1);
    if (navigation === "unmount") unmount();
    else {
      act(() => {
        result.current.desktop.setSelectedCanvasId("canvas-other");
      });
      if (navigation === "aba")
        act(() => {
          result.current.desktop.setSelectedCanvasId("canvas-main");
        });
    }
    await act(async () => {
      if (completion === "success")
        pendingDelete.resolve({
          ok: true,
          graphVersion: "pgv-2",
          affectedTasks: [],
          diagnostics: []
        });
      else pendingDelete.reject(new Error("obsolete deletion failed"));
      await expect(deletion).resolves.toBeUndefined();
    });
    expect(removeDependencyEdge).toHaveBeenCalledTimes(1);
    expect(removeDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T",
      "A",
      graph.graphVersion,
      undefined
    );
    expect(bridge.getDesktopProjectSnapshot).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    if (navigation !== "unmount")
      expect(result.current.desktop.selectedCanvasId).toBe(
        navigation === "aba" ? "canvas-main" : "canvas-other"
      );
  });

  it.each([
    "canvas",
    "unmount"
  ])("does not publish a pending refresh failure after %s", async (navigation) => {
    const { result, unmount, bridge, setError } = await renderDeletionActions();
    const pendingRefresh =
      deferred<Awaited<ReturnType<DesktopBridgeApi["getDesktopProjectSnapshot"]>>>();
    vi.mocked(bridge.getDesktopProjectSnapshot).mockReturnValueOnce(pendingRefresh.promise);
    let deletion!: Promise<void>;
    act(() => {
      deletion = result.current.actions.handleEdgesDelete([dependencyEdge("A")]);
    });
    await waitFor(() => expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(1));
    if (navigation === "unmount") unmount();
    else
      act(() => {
        result.current.desktop.setSelectedCanvasId("canvas-other");
      });
    await act(async () => {
      pendingRefresh.reject(new Error("obsolete refresh failed"));
      await expect(deletion).resolves.toBeUndefined();
    });
    expect(setError).not.toHaveBeenCalled();
    expect(bridge.removeDependencyEdge).toHaveBeenCalledTimes(1);
  });

  it("does not publish or start snapshots for an obsolete mutation owner", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      getGraphViewModel: vi.fn().mockResolvedValue(graph)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );
    await act(async () => {
      await result.current.loadProject(project);
    });
    let ownerCurrent = true;
    const snapshot = deferred<Awaited<ReturnType<typeof bridge.getDesktopProjectSnapshot>>>();
    vi.mocked(bridge.getDesktopProjectSnapshot).mockReturnValueOnce(snapshot.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refreshProjectDerivedState({ isOwnerCurrent: () => ownerCurrent });
    });
    ownerCurrent = false;
    const previousGraph = result.current.graph;
    setError.mockClear();
    await act(async () => {
      snapshot.resolve(projectSnapshot({ graph: { ...graph, graphVersion: "obsolete-owner" } }));
      await pending;
    });
    expect(result.current.graph).toBe(previousGraph);
    expect(setError).not.toHaveBeenCalled();
    vi.mocked(bridge.getDesktopProjectSnapshot).mockClear();
    await act(async () => {
      await result.current.refreshProjectDerivedState({ isOwnerCurrent: () => false });
    });
    expect(bridge.getDesktopProjectSnapshot).not.toHaveBeenCalled();
  });

  it("refreshes derived project state after adding dependency edges", async () => {
    const bridge = createDesktopBridgeMock({
      addDependencyEdge: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        captureProjectSelection: () => ({ isCurrent: () => true }),
        flowInstance: null,
        graph: { ...graph, graphVersion: "pgv-before" },
        layout: null,
        loadProject: vi.fn().mockResolvedValue(undefined),
        nodes: [],
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: {
          defaultExecutor: "",
          palette: {
            defaultBlockSet: ["implementation"],
            dragHint: true,
            visible: { task: true, implementation: true, review: true }
          }
        } as unknown as DesktopUiSettings,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await result.current.handleConnect({
        source: "T-BETA",
        target: "T-ALPHA",
        sourceHandle: null,
        targetHandle: null
      });
    });

    expect(bridge.addDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "pgv-before",
      undefined
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("refreshes derived project state after reconnecting dependency edges", async () => {
    const bridge = createDesktopBridgeMock({
      reconnectDependencyEdge: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        captureProjectSelection: () => ({ isCurrent: () => true }),
        flowInstance: null,
        graph: { ...graph, graphVersion: "pgv-before" },
        layout: null,
        loadProject: vi.fn().mockResolvedValue(undefined),
        nodes: [],
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: {
          defaultExecutor: "",
          palette: {
            defaultBlockSet: ["implementation"],
            dragHint: true,
            visible: { task: true, implementation: true, review: true }
          }
        } as unknown as DesktopUiSettings,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await result.current.handleReconnectEdge(
        {
          id: "T-ALPHA->T-BETA",
          source: "T-BETA",
          target: "T-ALPHA",
          data: { manifestEdgeType: "depends_on", manifestFrom: "T-ALPHA", manifestTo: "T-BETA" }
        } as never,
        { source: "T-ALPHA", target: "T-BETA", sourceHandle: null, targetHandle: null }
      );
    });

    expect(bridge.reconnectDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "T-BETA",
      "T-ALPHA",
      "pgv-before",
      undefined
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("adds dropped tasks with their initial layout in a single graph edit", async () => {
    const addTaskNode = vi
      .fn()
      .mockResolvedValue({ ok: true, affectedTasks: ["T-NEW"], diagnostics: [] });
    const bridge = createDesktopBridgeMock({
      addTaskNode,
      getDesktopLayout: vi.fn().mockResolvedValue(layout),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      saveDesktopLayout: vi.fn().mockResolvedValue(layout)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const selectTaskPanel = vi.fn();
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        captureProjectSelection: () => ({ isCurrent: () => true }),
        flowInstance: null,
        graph,
        layout,
        loadProject,
        nodes: [],
        refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout: vi.fn(),
        selectTaskPanel,
        settings: {
          defaultExecutor: "",
          palette: {
            defaultBlockSet: ["implementation"],
            dragHint: true,
            visible: { task: true, implementation: true, review: true }
          }
        } as unknown as DesktopUiSettings,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await result.current.addPaletteComponent("task", { x: 42, y: 64 });
    });

    expect(addTaskNode).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      expect.objectContaining({ layoutPosition: { x: 42, y: 64 } })
    );
    expect(bridge.saveDesktopLayout).not.toHaveBeenCalled();
    expect(loadProject).toHaveBeenCalledWith(project, "canvas-main");
    expect(selectTaskPanel).toHaveBeenCalledWith("T-NEW");
  });

  it("clears stale review task selection after deleting a task", async () => {
    const bridge = createDesktopBridgeMock({
      removeTaskNode: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { useGraphDeleteActions } = await import("../renderer/hooks/useGraphDeleteActions");
    const clearReviewTaskSelection = vi.fn();
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useGraphDeleteActions({
        clearReviewTaskSelection,
        clearTaskPanelSelection: vi.fn(),
        clearSelectedBlockRecords: vi.fn(),
        deleteBlockConfirm: "Delete block?",
        deleteTaskConfirm: "Delete task?",
        loadProject,
        refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setBlockInspectorOpen: vi.fn(),
        setError: vi.fn(),
        setSelectedBlock: vi.fn(),
        setSelectedRunRecord: vi.fn()
      })
    );

    await act(async () => {
      await result.current.handleDeleteTaskNode("T-ALPHA");
    });

    expect(bridge.removeTaskNode).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA"
    );
    expect(clearReviewTaskSelection).toHaveBeenCalledWith("T-ALPHA");
    expect(loadProject).toHaveBeenCalledWith(project, "canvas-main");
  });

  it("refreshes derived project state after deleting a block", async () => {
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-ALPHA#B-001",
      graphVersion: "pgv-before",
      taskId: "T-ALPHA",
      blockId: "B-001",
      type: "implementation",
      title: "Block",
      status: "ready",
      executor: null,
      effectiveExecutor: null,
      promptMarkdown: "# Block",
      promptHash: "hash-before",
      promptMissing: false,
      promptSurfaceMarkdown: "# Block",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };
    const bridge = createDesktopBridgeMock({
      removeBlock: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { useGraphDeleteActions } = await import("../renderer/hooks/useGraphDeleteActions");
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const clearSelectedBlockRecords = vi.fn();
    const setBlockInspectorOpen = vi.fn();
    const setSelectedBlock = vi.fn();
    const setSelectedRunRecord = vi.fn();
    const { result } = renderHook(() =>
      useGraphDeleteActions({
        clearReviewTaskSelection: vi.fn(),
        clearTaskPanelSelection: vi.fn(),
        clearSelectedBlockRecords,
        deleteBlockConfirm: "Delete block?",
        deleteTaskConfirm: "Delete task?",
        loadProject: vi.fn().mockResolvedValue(undefined),
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock,
        selectedProject: project,
        selectedTaskPanelId: null,
        setBlockInspectorOpen,
        setError: vi.fn(),
        setSelectedBlock,
        setSelectedRunRecord
      })
    );

    await act(async () => {
      await result.current.handleDeleteBlock(selectedBlock.ref);
    });

    expect(bridge.removeBlock).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      selectedBlock.ref
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(setSelectedBlock).toHaveBeenCalledWith(null);
    expect(setSelectedRunRecord).toHaveBeenCalledWith(null);
    expect(setBlockInspectorOpen).toHaveBeenCalledWith(false);
    expect(clearSelectedBlockRecords).toHaveBeenCalledTimes(1);
  });
});

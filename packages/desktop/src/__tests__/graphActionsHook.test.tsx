/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { DesktopBlockDetail } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";
import type { AppFlowNode, DesktopUiSettings } from "../renderer/types";
import { layout, project } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer hook interfaces", () => {
  it("uses the latest graphVersion when deleting dependency edges after a graph refresh", async () => {
    const bridge = createDesktopBridgeMock({
      removeDependencyEdge: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
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
      setNewTaskTargetId: vi.fn(),
      selectTaskPanel: vi.fn(),
      settings: {
        defaultExecutor: "",
        palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
      } as unknown as DesktopUiSettings,
      t: createTranslator("en")
    };
    const { result, rerender } = renderHook(({ currentGraph }) => useGraphPaletteActions({ ...baseArgs, graph: currentGraph }), {
      initialProps: { currentGraph: { ...graph, graphVersion: "pgv-before" } }
    });

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
        setNewTaskTargetId: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: {
          defaultExecutor: "",
          palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
        } as unknown as DesktopUiSettings,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await result.current.handleConnect({ source: "T-BETA", target: "T-ALPHA", sourceHandle: null, targetHandle: null });
    });

    expect(bridge.addDependencyEdge).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, "T-ALPHA", "T-BETA", "pgv-before", undefined);
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
        setNewTaskTargetId: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: {
          defaultExecutor: "",
          palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
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
    const addTaskNode = vi.fn().mockResolvedValue({ ok: true, affectedTasks: ["T-NEW"], diagnostics: [] });
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
    const setNewTaskTargetId = vi.fn();
    const { result } = renderHook(() =>
      useGraphPaletteActions({
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
        setNewTaskTargetId,
        selectTaskPanel,
        settings: {
          defaultExecutor: "",
          palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
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
    expect(setNewTaskTargetId).toHaveBeenCalledWith("T-NEW");
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

    expect(bridge.removeBlock).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, selectedBlock.ref);
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(setSelectedBlock).toHaveBeenCalledWith(null);
    expect(setSelectedRunRecord).toHaveBeenCalledWith(null);
    expect(setBlockInspectorOpen).toHaveBeenCalledWith(false);
    expect(clearSelectedBlockRecords).toHaveBeenCalledTimes(1);
  });

});

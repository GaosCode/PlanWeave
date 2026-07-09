/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import type * as React from "react";
import type { Edge, Node } from "@xyflow/react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import type { AppFlowNode, DesktopUiSettings } from "../renderer/types";

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      taskCount: 2,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    }
  ]
};

const graph: DesktopGraphViewModel = {
  projectId: project.projectId,
  projectTitle: project.name,
  graphVersion: "pgv-test",
  packageFingerprint: "pkg-test",
  executorOptions: ["codex"],
  tasks: [
    {
      taskId: "T-ALPHA",
      title: "Alpha task",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Alpha",
      promptPreview: "Alpha",
      blocks: [],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    },
    {
      taskId: "T-BETA",
      title: "Beta task",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Beta",
      promptPreview: "Beta",
      blocks: [],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

const layout: DesktopLayout = {
  version: "desktop-layout/v1",
  projectId: project.projectId,
  nodes: [],
  updatedAt: "2026-05-23T00:00:00.000Z"
};

const graphPaletteSettings: DesktopUiSettings = {
  ...defaultDesktopSettings,
  defaultExecutor: "",
  palette: {
    ...defaultDesktopSettings.palette,
    defaultBlockSet: ["implementation"],
    dragHint: true,
    visible: { task: true, implementation: true, review: true }
  }
};

const renderedNodes = [
  { id: "T-ALPHA", position: { x: 48, y: 32 } },
  { id: "T-BETA", position: { x: 580, y: 80 } }
] as AppFlowNode[];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useGraphPaletteActions layout snapshots", () => {
  it("saves node drag layout from the committed layout nodes callback", async () => {
    const saveDesktopLayout = vi.fn().mockResolvedValue(layout);
    const bridge = createDesktopBridgeMock({
      saveDesktopLayout
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const committedNodes = [
      { id: "T-ALPHA", position: { x: 120, y: 96 } },
      { id: "T-BETA", position: { x: 580, y: 80 } }
    ] as AppFlowNode[];
    const getLayoutNodes = vi.fn(() => committedNodes);
    const setLayout = vi.fn();
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        flowInstance: null,
        getLayoutNodes,
        graph,
        layout,
        loadProject: vi.fn().mockResolvedValue(undefined),
        nodes: renderedNodes,
        refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout,
        setNewTaskTargetId: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: graphPaletteSettings,
        t: createTranslator("en")
      })
    );
    const stoppedNode: Node = { id: "T-ALPHA", position: { x: 48, y: 32 }, data: {} };

    await act(async () => {
      await result.current.handleNodeDragStop({} as React.MouseEvent, stoppedNode);
    });

    expect(getLayoutNodes).toHaveBeenCalledTimes(1);
    expect(saveDesktopLayout).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      {
        ...layout,
        nodes: [
          { nodeId: "T-ALPHA", x: 120, y: 96 },
          { nodeId: "T-BETA", x: 580, y: 80 }
        ]
      }
    );
    expect(setLayout).toHaveBeenCalledWith(layout);
  });

  it("uses committed layout nodes for dependency edge snapshots", async () => {
    const addDependencyEdge = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const removeDependencyEdge = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const reconnectDependencyEdge = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const bridge = createDesktopBridgeMock({
      addDependencyEdge,
      removeDependencyEdge,
      reconnectDependencyEdge
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const committedNodes = [
      { id: "T-ALPHA", position: { x: 120, y: 96 } },
      { id: "T-BETA", position: { x: 600, y: 112 } }
    ] as AppFlowNode[];
    const expectedSnapshot = {
      version: "desktop-layout/v1",
      projectId: graph.projectId,
      nodes: [
        { nodeId: "T-ALPHA", x: 120, y: 96 },
        { nodeId: "T-BETA", x: 600, y: 112 }
      ],
      updatedAt: layout.updatedAt
    };
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        flowInstance: null,
        getLayoutNodes: () => committedNodes,
        graph: { ...graph, graphVersion: "pgv-before" },
        layout,
        loadProject: vi.fn().mockResolvedValue(undefined),
        nodes: renderedNodes,
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout: vi.fn(),
        setNewTaskTargetId: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: graphPaletteSettings,
        t: createTranslator("en")
      })
    );
    const dependencyEdge: Edge = {
      id: "T-ALPHA->T-BETA",
      source: "T-BETA",
      target: "T-ALPHA",
      data: { manifestEdgeType: "depends_on", manifestFrom: "T-ALPHA", manifestTo: "T-BETA" }
    };

    await act(async () => {
      await result.current.handleConnect({
        source: "T-BETA",
        target: "T-ALPHA",
        sourceHandle: null,
        targetHandle: null
      });
      await result.current.handleEdgesDelete([dependencyEdge]);
      await result.current.handleReconnectEdge(dependencyEdge, {
        source: "T-ALPHA",
        target: "T-BETA",
        sourceHandle: null,
        targetHandle: null
      });
    });

    expect(addDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "pgv-before",
      expectedSnapshot
    );
    expect(removeDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "pgv-before",
      expectedSnapshot
    );
    expect(reconnectDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "T-BETA",
      "T-ALPHA",
      "pgv-before",
      expectedSnapshot
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(3);
  });
});

/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
import { initialLayoutSelection, layoutOwnerHarness } from "./helpers/graphLayoutOwnerHarness";
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
      sharedResources: [],
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
      sharedResources: [],
      blocks: [],
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
  it("submits Workspace layout without a selected local project", async () => {
    const bridge = createDesktopBridgeMock();
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const submit = vi
      .fn()
      .mockResolvedValue({ status: "completed", ok: true, error: null, staleConflict: null });
    const setLayout = vi.fn();
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        captureProjectSelection: () => ({ isCurrent: () => true }),
        flowInstance: null,
        graph,
        layout,
        nodes: renderedNodes,
        loadProject: vi.fn(),
        refreshProjectDerivedState: vi.fn(),
        selectedCanvasId: null,
        selectedBlock: null,
        selectedProject: null,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout,
        selectTaskPanel: vi.fn(),
        settings: graphPaletteSettings,
        t: createTranslator("en"),
        workspaceCanvas: {
          enabled: true,
          offline: false,
          projection: null,
          projectionStatus: null,
          initialRuntimeAvailability: null,
          submit,
          reconnect: vi.fn(),
          snapshot: {
            session: null,
            connectionPhase: "connected",
            lastError: null,
            lastStaleConflict: null,
            busy: false
          }
        }
      })
    );
    await act(async () => {
      await result.current.handleNodeDragStop({} as React.MouseEvent, {
        id: "T-ALPHA",
        position: { x: 240, y: 180 },
        data: {}
      });
    });
    expect(submit).toHaveBeenCalledWith({
      isOwnerCurrent: expect.any(Function),
      intent: {
        kind: "update_layout",
        updatedAt: expect.any(String),
        nodes: [
          { nodeId: "T-ALPHA", x: 240, y: 180 },
          { nodeId: "T-BETA", x: 580, y: 80 }
        ]
      }
    });
    expect(setLayout).toHaveBeenCalledWith(expect.objectContaining({ projectId: graph.projectId }));
    expect(bridge.saveDesktopLayout).not.toHaveBeenCalled();
  });

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
        captureProjectSelection: () => ({ isCurrent: () => true }),
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
    const removeDependencyEdge = vi.fn().mockResolvedValue({
      ok: true,
      graphVersion: "pgv-after",
      committed: { graphVersion: "pgv-after" },
      affectedTasks: ["T-ALPHA"],
      diagnostics: []
    });
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
        captureProjectSelection: () => ({ isCurrent: () => true }),
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

const retirementCases = ["canvas", "project", "home", "authority", "return", "unmount"] as const;
const ownershipCases = [false, true].flatMap((shared) =>
  (["save", "reset"] as const).flatMap((operation) =>
    [false, true].flatMap((failure) =>
      retirementCases
        .filter((retirement) => shared || retirement !== "authority")
        .map((retirement) => ({ shared, operation, failure, retirement }))
    )
  )
);

describe("layout request ownership", () => {
  it.each(
    ownershipCases
  )("isolates shared=$shared $operation failure=$failure after $retirement", async ({
    shared,
    operation,
    failure,
    retirement
  }) => {
    const hook = await layoutOwnerHarness(shared);
    let previous!: Promise<void>;
    act(() => {
      previous = hook.invoke(operation);
    });
    expect(hook.writes).toHaveLength(1);
    if (retirement === "unmount") hook.unmount();
    else {
      hook.rerender({
        ...initialLayoutSelection,
        ...(retirement === "project" ? { projectRoot: "/tmp/next-project" } : {}),
        ...(retirement === "home" ? { home: "home-b" } : {}),
        ...(retirement === "authority" ? { authority: "authority-b" } : {}),
        ...(["canvas", "return"].includes(retirement) ? { canvasId: "canvas-b" } : {})
      });
      await hook.ready();
      if (retirement === "return") {
        hook.rerender(initialLayoutSelection);
        await hook.ready();
      }
    }
    hook.setLayout.mockClear();
    hook.setError.mockClear();
    await hook.finish(0, failure);
    await previous;
    expect(hook.setLayout).not.toHaveBeenCalled();
    expect(hook.setError).not.toHaveBeenCalled();
    if (retirement !== "unmount" && shared) {
      expect(hook.result.current.commands.snapshot.lastError).toBeNull();
      expect(hook.result.current.commands.snapshot.busy).toBe(false);
    }
  });

  it.each(
    [false, true].flatMap((shared) =>
      (["save", "reset"] as const).map((operation) => ({ shared, operation }))
    )
  )("preserves current $operation failure and retry shared=$shared", async ({
    shared,
    operation
  }) => {
    const hook = await layoutOwnerHarness(shared);
    let previous!: Promise<void>;
    let current!: Promise<void>;
    act(() => {
      previous = hook.invoke("save");
    });
    hook.rerender({ ...initialLayoutSelection, canvasId: "canvas-b" });
    await hook.ready();
    act(() => {
      current = hook.invoke(operation, 900);
    });
    expect(hook.writes).toHaveLength(2);
    await hook.finish(0, true);
    await previous;
    expect(hook.setError).not.toHaveBeenCalled();
    if (shared) expect(hook.result.current.commands.snapshot.lastError).toBeNull();
    await hook.finish(1, true);
    await current;
    expect(hook.setError).toHaveBeenLastCalledWith("layout failure 1");
    let retry!: Promise<void>;
    act(() => {
      retry = hook.invoke(operation, 950);
    });
    await hook.finish(2);
    await retry;
    expect(hook.setLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes:
          operation === "save"
            ? [{ nodeId: "T-ALPHA", x: 950, y: 180 }]
            : shared
              ? [
                  { nodeId: "T-ALPHA", x: 80, y: 80 },
                  { nodeId: "T-BETA", x: 400, y: 80 }
                ]
              : []
      })
    );
    expect(hook.setError).toHaveBeenLastCalledWith(null);
  });

  it.each([
    false,
    true
  ])("preserves the next session connection pending after old failure=%s", async (failure) => {
    const hook = await layoutOwnerHarness(true);
    let previous!: Promise<void>;
    act(() => {
      previous = hook.invoke("save");
    });
    const opening = hook.holdNextOpen();
    hook.rerender({ ...initialLayoutSelection, canvasId: "canvas-b" });
    await waitFor(() => expect(hook.result.current.commands.snapshot.busy).toBe(true));
    await hook.finish(0, failure);
    await previous;
    expect(hook.result.current.commands.snapshot.busy).toBe(true);
    expect(hook.result.current.commands.snapshot.connectionPhase).toBe("connecting");
    expect(hook.result.current.commands.snapshot.lastError).toBeNull();
    await act(async () => opening.resolve());
    await hook.ready();
  });

  it.each([false, true])("keeps current error after an older success shared=%s", async (shared) => {
    const hook = await layoutOwnerHarness(shared);
    let previous!: Promise<void>;
    let current!: Promise<void>;
    act(() => {
      previous = hook.invoke("save");
    });
    hook.rerender({ ...initialLayoutSelection, canvasId: "canvas-b" });
    await hook.ready();
    act(() => {
      current = hook.invoke("reset");
    });
    await hook.finish(1, true);
    await current;
    hook.setError.mockClear();
    await hook.finish(0);
    await previous;
    expect(hook.setError).not.toHaveBeenCalled();
    expect(hook.setLayout).not.toHaveBeenCalled();
    if (shared) expect(hook.result.current.commands.snapshot.lastError).toBe("layout failure 1");
  });

  it.each([
    false,
    true
  ])("orders same-scope save/reset and retires superseded errors shared=%s", async (shared) => {
    const hook = await layoutOwnerHarness(shared);
    let previous!: Promise<void>;
    let current!: Promise<void>;
    act(() => {
      previous = hook.invoke("save");
      current = hook.invoke("reset");
    });
    expect(hook.writes).toHaveLength(1);
    await hook.finish(0, true);
    await previous;
    expect(hook.writes).toHaveLength(2);
    expect(hook.setError).not.toHaveBeenCalled();
    await hook.finish(1);
    await current;
    expect(hook.setLayout).toHaveBeenCalledTimes(1);
    expect(hook.setError).toHaveBeenLastCalledWith(null);
  });
  it.each([false, true])("publishes final same-canvas drag shared=%s", async (shared) => {
    const hook = await layoutOwnerHarness(shared);
    let first!: Promise<void>;
    let last!: Promise<void>;
    act(() => {
      first = hook.invoke("save", 120);
      last = hook.invoke("save", 900);
    });
    expect(hook.writes).toHaveLength(1);
    await hook.finish(0);
    await first;
    expect(hook.setLayout).not.toHaveBeenCalled();
    expect(hook.writes).toHaveLength(2);
    await hook.finish(1);
    await last;
    expect(hook.setLayout).toHaveBeenCalledTimes(1);
    expect(hook.setLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodes: [{ nodeId: "T-ALPHA", x: 900, y: 180 }] })
    );
  });
});

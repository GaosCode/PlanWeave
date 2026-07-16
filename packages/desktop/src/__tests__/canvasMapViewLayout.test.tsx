/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopCanvasGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CanvasMapView } from "../renderer/views/CanvasMapView";

const useCanvasMapMock = vi.hoisted(() => vi.fn());
const bridgeMock = vi.hoisted(() => ({
  updateCanvasExecutionPolicy: vi.fn()
}));
const reactFlowRenderNodes = vi.hoisted(() => [] as Array<unknown[] | undefined>);

vi.mock("../renderer/hooks/useCanvasMap", () => ({
  useCanvasMap: useCanvasMapMock
}));

vi.mock("../renderer/bridge", () => ({
  bridge: bridgeMock
}));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Background: () => <div data-testid="react-flow-background" />,
    Controls: () => <div data-testid="react-flow-controls" />,
    MiniMap: () => <div data-testid="react-flow-minimap" />,
    ReactFlow: (props: { children?: React.ReactNode; nodes?: unknown[] }) => {
      reactFlowRenderNodes.push(props.nodes);
      return <div data-testid="react-flow">{props.children}</div>;
    },
    useEdgesState: <T,>(initial: T[]) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges, vi.fn()] as const;
    },
    useNodesState: <T,>(initial: T[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()] as const;
    }
  };
});

const longProjectRoot =
  "/workspace/.planweave/projects/ecco-the-dolphin-opencode-with-a-very-long-unbroken-folder-name";
const longSourceRoot =
  "/workspace/source/ecco-the-dolphin-opencode-with-a-very-long-unbroken-folder-name";

const project: DesktopProjectSummary = {
  activeCanvasId: "default",
  kind: "managed",
  name: "Ecco the Dolphin opencode",
  projectId: "ecco-the-dolphin-opencode",
  rootPath: longProjectRoot,
  sourceRoot: longSourceRoot,
  taskCanvases: [],
  workspaceRoot: longProjectRoot
};

const canvasGraph: DesktopCanvasGraphViewModel = {
  canvases: [
    {
      canvasId: "default",
      diagnostics: [],
      executionPolicy: { parallelEnabled: false, maxConcurrent: 1 },
      packageDir: "canvases/default/package",
      title: "Ecco the Dolphin opencode"
    }
  ],
  crossTaskEdges: [],
  diagnostics: [],
  edges: [],
  health: {
    blockedBlocks: [],
    canvases: [{ blockerCount: 0, canvasId: "default", diagnosticCount: 0, severity: "ok" }],
    diagnostics: [],
    edges: [],
    severity: "ok"
  },
  projectId: project.projectId,
  projectTitle: project.name
};

function renderCanvasMapView(patch: Partial<Parameters<typeof CanvasMapView>[0]> = {}) {
  render(
    <CanvasMapView
      handleOpenBlockInspector={vi.fn().mockResolvedValue(undefined)}
      handleOpenProject={vi.fn().mockResolvedValue(undefined)}
      handleRevealTaskCanvas={vi.fn().mockResolvedValue(undefined)}
      handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
      loadProject={vi.fn().mockResolvedValue(undefined)}
      onAgentPromptCopied={vi.fn()}
      onTaskPanelSelect={vi.fn()}
      refreshProjectDerivedState={vi.fn().mockResolvedValue(undefined)}
      selectedCanvasId="default"
      selectedProject={project}
      setActiveView={vi.fn()}
      setError={vi.fn()}
      t={createTranslator("en")}
      {...patch}
    />
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined)
    }
  });
  bridgeMock.updateCanvasExecutionPolicy.mockResolvedValue(undefined);
  reactFlowRenderNodes.length = 0;
  useCanvasMapMock.mockReturnValue({
    canvasGraph,
    canvasMapLayout: null,
    layoutDirty: false,
    layoutPending: null,
    loadCanvasMap: vi.fn().mockResolvedValue(undefined),
    persistedCanvasMapLayout: null,
    resetCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
    retrySaveCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
    saveCanvasMapLayoutFromNodes: vi.fn().mockResolvedValue(undefined),
    selectedCanvas: canvasGraph.canvases[0],
    selectedMapCanvasId: "default",
    setSelectedMapCanvasId: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("CanvasMapView agent scope layout", () => {
  it("renders long agent scope paths as line-breakable text", () => {
    renderCanvasMapView();

    for (const element of screen.getAllByText(longProjectRoot)) {
      expect(element).toHaveStyle({ overflowWrap: "anywhere" });
    }
    expect(screen.getByText(longSourceRoot)).toHaveStyle({ overflowWrap: "anywhere" });
    expect(screen.getAllByText("canvases/default/package")[0]).toHaveStyle({
      overflowWrap: "anywhere"
    });
  });

  it("announces when the agent scope prompt is copied", async () => {
    const onAgentPromptCopied = vi.fn();
    renderCanvasMapView({ onAgentPromptCopied });

    fireEvent.click(screen.getByRole("button", { name: "Copy agent prompt" }));

    await waitFor(() => expect(onAgentPromptCopied).toHaveBeenCalledTimes(1));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(`packageDir: ${longProjectRoot}/canvases/default/package`)
    );
  });

  it("wires canvas map node rename and Finder actions to the project handlers", async () => {
    const handleRevealTaskCanvas = vi.fn().mockResolvedValue(undefined);
    const handleRenameTaskCanvas = vi.fn().mockResolvedValue(undefined);
    const loadCanvasMap = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    useCanvasMapMock.mockReturnValue({
      canvasGraph,
      canvasMapLayout: null,
      layoutDirty: false,
      layoutPending: null,
      loadCanvasMap,
      persistedCanvasMapLayout: null,
      resetCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      retrySaveCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      saveCanvasMapLayoutFromNodes: vi.fn().mockResolvedValue(undefined),
      selectedCanvas: canvasGraph.canvases[0],
      selectedMapCanvasId: "default",
      setSelectedMapCanvasId: vi.fn()
    });
    vi.spyOn(window, "prompt").mockReturnValue("Renamed canvas");

    renderCanvasMapView({
      handleRevealTaskCanvas,
      handleRenameTaskCanvas,
      refreshProjectDerivedState
    });

    await waitFor(() => expect(reactFlowRenderNodes.at(-1)?.length).toBe(1));
    const node = reactFlowRenderNodes.at(-1)?.[0] as {
      data: {
        canvas: DesktopCanvasGraphViewModel["canvases"][number];
        onRevealInFinder: (canvasId: string) => void;
        onRename: (canvas: DesktopCanvasGraphViewModel["canvases"][number]) => void;
      };
    };
    node.data.onRevealInFinder("default");
    node.data.onRename(node.data.canvas);

    expect(handleRevealTaskCanvas).toHaveBeenCalledWith(project, "default");
    await waitFor(() =>
      expect(handleRenameTaskCanvas).toHaveBeenCalledWith(project, "default", "Renamed canvas")
    );
    await waitFor(() => expect(loadCanvasMap).toHaveBeenCalledTimes(1));
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("saves execution policy through the bridge and refreshes derived state", async () => {
    const loadCanvasMap = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    useCanvasMapMock.mockReturnValue({
      canvasGraph,
      canvasMapLayout: null,
      layoutDirty: false,
      layoutPending: null,
      loadCanvasMap,
      persistedCanvasMapLayout: null,
      resetCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      retrySaveCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      saveCanvasMapLayoutFromNodes: vi.fn().mockResolvedValue(undefined),
      selectedCanvas: canvasGraph.canvases[0],
      selectedMapCanvasId: "default",
      setSelectedMapCanvasId: vi.fn()
    });

    renderCanvasMapView({ refreshProjectDerivedState });

    fireEvent.click(screen.getByRole("switch", { name: "Parallel execution" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Max concurrent blocks" }), {
      target: { value: "3" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(bridgeMock.updateCanvasExecutionPolicy).toHaveBeenCalledWith(
        { projectRoot: longProjectRoot, canvasId: "default" },
        { parallelEnabled: true, maxConcurrent: 3 }
      )
    );
    await waitFor(() => expect(loadCanvasMap).toHaveBeenCalledTimes(1));
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("reports execution policy save failures without refreshing derived state", async () => {
    const loadCanvasMap = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    bridgeMock.updateCanvasExecutionPolicy.mockRejectedValueOnce(new Error("policy write failed"));
    useCanvasMapMock.mockReturnValue({
      canvasGraph,
      canvasMapLayout: null,
      layoutDirty: false,
      layoutPending: null,
      loadCanvasMap,
      persistedCanvasMapLayout: null,
      resetCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      retrySaveCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      saveCanvasMapLayoutFromNodes: vi.fn().mockResolvedValue(undefined),
      selectedCanvas: canvasGraph.canvases[0],
      selectedMapCanvasId: "default",
      setSelectedMapCanvasId: vi.fn()
    });

    renderCanvasMapView({ refreshProjectDerivedState, setError });

    fireEvent.click(screen.getByRole("switch", { name: "Parallel execution" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("policy write failed"));
    expect(loadCanvasMap).not.toHaveBeenCalled();
    expect(refreshProjectDerivedState).not.toHaveBeenCalled();
  });

  it("does not rebuild ReactFlow nodes when only the translator function identity changes", async () => {
    const firstTranslator = createTranslator("en");
    const { rerender } = render(
      <CanvasMapView
        handleOpenBlockInspector={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleRevealTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        loadProject={vi.fn().mockResolvedValue(undefined)}
        onAgentPromptCopied={vi.fn()}
        onTaskPanelSelect={vi.fn()}
        refreshProjectDerivedState={vi.fn().mockResolvedValue(undefined)}
        selectedCanvasId="default"
        selectedProject={project}
        setActiveView={vi.fn()}
        setError={vi.fn()}
        t={firstTranslator}
      />
    );
    await waitFor(() =>
      expect(reactFlowRenderNodes.some((nodes) => nodes?.length === 1)).toBe(true)
    );

    reactFlowRenderNodes.length = 0;
    const nextTranslator = (key: Parameters<typeof firstTranslator>[0]) => firstTranslator(key);
    rerender(
      <CanvasMapView
        handleOpenBlockInspector={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleRevealTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        loadProject={vi.fn().mockResolvedValue(undefined)}
        onAgentPromptCopied={vi.fn()}
        onTaskPanelSelect={vi.fn()}
        refreshProjectDerivedState={vi.fn().mockResolvedValue(undefined)}
        selectedCanvasId="default"
        selectedProject={project}
        setActiveView={vi.fn()}
        setError={vi.fn()}
        t={nextTranslator}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reactFlowRenderNodes).toHaveLength(1);
    expect(reactFlowRenderNodes[0]?.length).toBe(1);
  });

  it("shows a persistent unsaved layout status with retry after a dirty save failure", async () => {
    const retrySaveCanvasMapLayout = vi.fn().mockResolvedValue(undefined);
    useCanvasMapMock.mockReturnValue({
      canvasGraph,
      canvasMapLayout: null,
      layoutDirty: true,
      layoutPending: null,
      loadCanvasMap: vi.fn().mockResolvedValue(undefined),
      persistedCanvasMapLayout: null,
      resetCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      retrySaveCanvasMapLayout,
      saveCanvasMapLayoutFromNodes: vi.fn().mockResolvedValue(undefined),
      selectedCanvas: canvasGraph.canvases[0],
      selectedMapCanvasId: "default",
      setSelectedMapCanvasId: vi.fn()
    });

    renderCanvasMapView();

    expect(screen.getByTestId("canvas-map-layout-status")).toHaveTextContent("Unsaved layout");
    expect(screen.getByTestId("canvas-map-layout-dirty-badge")).toHaveTextContent("Unsaved layout");
    fireEvent.click(screen.getByTestId("canvas-map-layout-retry-save"));
    await waitFor(() => expect(retrySaveCanvasMapLayout).toHaveBeenCalledTimes(1));
  });

  it("shows saving pending status without a retry action", () => {
    useCanvasMapMock.mockReturnValue({
      canvasGraph,
      canvasMapLayout: null,
      layoutDirty: true,
      layoutPending: "save",
      loadCanvasMap: vi.fn().mockResolvedValue(undefined),
      persistedCanvasMapLayout: null,
      resetCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      retrySaveCanvasMapLayout: vi.fn().mockResolvedValue(undefined),
      saveCanvasMapLayoutFromNodes: vi.fn().mockResolvedValue(undefined),
      selectedCanvas: canvasGraph.canvases[0],
      selectedMapCanvasId: "default",
      setSelectedMapCanvasId: vi.fn()
    });

    renderCanvasMapView();

    expect(screen.getByTestId("canvas-map-layout-status")).toHaveTextContent("Saving layout");
    expect(screen.queryByTestId("canvas-map-layout-retry-save")).toBeNull();
  });
});

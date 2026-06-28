/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView } from "../renderer/views/GraphView";
import { createTranslator } from "../renderer/i18n";
import { taskNodeLabels } from "../renderer/graph/taskNodeLabels";
import type { AppFlowNode } from "../renderer/types";

const reactFlowMock = vi.hoisted(() => ({
  flowInstance: {
    fitView: vi.fn()
  },
  props: [] as Array<Record<string, unknown>>
}));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Background: () => <div data-testid="react-flow-background" />,
    Controls: () => <div data-testid="react-flow-controls" />,
    MiniMap: () => <div data-testid="react-flow-minimap" />,
    ReactFlow: (props: Record<string, unknown>) => {
      React.useEffect(() => {
        (props.onInit as ((instance: typeof reactFlowMock.flowInstance) => void) | undefined)?.(reactFlowMock.flowInstance);
      }, [props.onInit]);
      reactFlowMock.props.push(props);
      return <div data-testid="react-flow">{props.children as React.ReactNode}</div>;
    }
  };
});

const project: DesktopProjectSummary = {
  projectId: "P-001",
  kind: "managed",
  name: "Demo",
  rootPath: "/tmp/demo",
  sourceRoot: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      taskCount: 1,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    },
    {
      canvasId: "canvas-next",
      name: "Next canvas",
      taskCount: 1,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    }
  ]
};

function graph(promptMarkdown = "# Prompt"): DesktopGraphViewModel {
  return {
    projectId: project.projectId,
    projectTitle: project.name,
    graphVersion: "pgv-test",
    packageFingerprint: "pkg-test",
    executorOptions: ["manual"],
    tasks: [
      {
        taskId: "T-001",
        title: "Task",
        status: "ready",
        executor: null,
        executorLabel: "inherit",
        promptMarkdown,
        promptPreview: "Prompt",
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
}

function flowNode(promptDraft = "# Prompt"): AppFlowNode {
  return {
    id: "T-001",
    type: "task",
    position: { x: 80, y: 80 },
    data: {
      task: graph(promptDraft).tasks[0],
      titleDraft: "Task",
      promptDraft,
      saveState: "idle",
      executorOptions: ["manual"],
      labels: taskNodeLabels(createTranslator("en")),
      selectedBlock: null,
      blockRunRecords: [],
      blockReviewAttempts: [],
      blockFeedbackRecords: [],
      onTitleChange: vi.fn(),
      onTitleSave: vi.fn(),
      onExecutorChange: vi.fn(),
      onPromptChange: vi.fn(),
      onPromptSave: vi.fn(),
      onPromptHistoryRedo: vi.fn().mockResolvedValue(undefined),
      onPromptHistoryUndo: vi.fn().mockResolvedValue(undefined),
      onBlockSelect: vi.fn(),
      onOverflowBlockSelect: vi.fn(),
      onTaskOpen: vi.fn(),
      onAgentPromptCopy: vi.fn(),
      onAutoRunScopeStart: vi.fn().mockResolvedValue(undefined),
      onTaskDelete: vi.fn(),
      onBlockDelete: vi.fn(),
      onSelectedBlockChange: vi.fn(),
      onBlockTitleSave: vi.fn(),
      onBlockExecutorChange: vi.fn(),
      onBlockPromptSave: vi.fn(),
      onOpenRunRecord: vi.fn()
    }
  };
}

function defaultProps(patch: Partial<ComponentProps<typeof GraphView>> = {}): ComponentProps<typeof GraphView> {
  return {
    autoRunControlStyle: {},
    autoRunScopeMode: "project",
    autoRunState: null,
    edges: [],
    edgeTypes: {} as ComponentProps<typeof GraphView>["edgeTypes"],
    graph: graph(),
    handleAutoRunClick: vi.fn().mockResolvedValue(undefined),
    handleConnect: vi.fn().mockResolvedValue(undefined),
    handleEdgesDelete: vi.fn().mockResolvedValue(undefined),
    handleReconnectEdge: vi.fn().mockResolvedValue(undefined),
    handleGraphDragOver: vi.fn(),
    handleGraphDrop: vi.fn(),
    handleOpenProject: vi.fn().mockResolvedValue(undefined),
    handleRedoGraph: vi.fn().mockResolvedValue(undefined),
    handleRevealPathInFinder: vi.fn().mockResolvedValue(undefined),
    resetRuntimeStateClick: vi.fn().mockResolvedValue(undefined),
    handleUndoGraph: vi.fn().mockResolvedValue(undefined),
    miniRunPanelOpen: false,
    moveAutoRunControl: vi.fn(),
    nodeTypes: {} as ComponentProps<typeof GraphView>["nodeTypes"],
    nodes: [flowNode()],
    onEdgesChange: vi.fn(),
    onNodeDragStop: vi.fn().mockResolvedValue(undefined),
    onNodesChange: vi.fn(),
    onTaskPanelSelect: vi.fn(),
    projectLoading: false,
    refreshPackageFiles: vi.fn().mockResolvedValue(undefined),
    selectedBlockPresent: false,
    selectedCanvasId: "canvas-main",
    selectedProject: project,
    selectedTaskPanelId: null,
    setActiveView: vi.fn(),
    setAutoRunScopeMode: vi.fn(),
    setFlowInstance: vi.fn(),
    setMiniRunPanelOpen: vi.fn(),
    startAutoRunControlDrag: vi.fn(),
    stopAutoRunClick: vi.fn().mockResolvedValue(undefined),
    stopAutoRunControlDrag: vi.fn(),
    t: createTranslator("en"),
    visibleTaskIds: new Set(["T-001"]),
    visibleTasks: undefined,
    ...patch
  };
}

afterEach(() => {
  cleanup();
  reactFlowMock.flowInstance.fitView.mockClear();
  reactFlowMock.props = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GraphView viewport fitting", () => {
  it("shows a loading placeholder instead of the empty project prompt while project data is loading", () => {
    render(<GraphView {...defaultProps({ graph: null, nodes: [], projectLoading: true })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading project");
    expect(screen.queryByText("Open a project folder to begin")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Project" })).not.toBeInTheDocument();
  });

  it("does not refit the viewport when the current canvas graph refreshes", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { rerender } = render(<GraphView {...defaultProps()} />);

    await waitFor(() => expect(reactFlowMock.flowInstance.fitView).toHaveBeenCalledTimes(1));
    expect(reactFlowMock.flowInstance.fitView).toHaveBeenLastCalledWith({ maxZoom: 1 });
    expect(reactFlowMock.props.at(-1)?.fitView).toBeUndefined();
    expect(reactFlowMock.props.at(-1)?.fitViewOptions).toBeUndefined();

    rerender(<GraphView {...defaultProps({ graph: graph("# Updated prompt"), nodes: [flowNode("# Updated prompt")] })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(1));
    expect(reactFlowMock.flowInstance.fitView).toHaveBeenCalledTimes(1);
  });

  it("uses ReactFlow reconnect end to remove an edge dragged off a handle", async () => {
    const edge = {
      id: "T-002-depends_on-T-001",
      source: "T-001",
      target: "T-002",
      data: { manifestEdgeType: "depends_on", manifestFrom: "T-002", manifestTo: "T-001" }
    };
    const handleEdgesDelete = vi.fn().mockResolvedValue(undefined);
    render(<GraphView {...defaultProps({ edges: [edge], handleEdgesDelete })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    const latestProps = reactFlowMock.props.at(-1) as {
      edges: Array<typeof edge>;
      edgesReconnectable: boolean;
      onReconnectEnd: (
        event: MouseEvent,
        selectedEdge: typeof edge,
        handleType: "source" | "target",
        connectionState: { isValid: boolean | null }
      ) => void;
      onReconnectStart: () => void;
    };
    expect(latestProps.edgesReconnectable).toBe(true);
    expect(latestProps.edges[0]).not.toHaveProperty("interactionWidth");

    act(() => {
      latestProps.onReconnectStart();
      latestProps.onReconnectEnd(new MouseEvent("mouseup"), edge, "target", { isValid: null });
    });

    await waitFor(() => expect(handleEdgesDelete).toHaveBeenCalledWith([edge]));
  });

  it("uses a single reconnect callback when an edge is reconnected", async () => {
    const edge = {
      id: "T-002-depends_on-T-001",
      source: "T-001",
      target: "T-002",
      data: { manifestEdgeType: "depends_on", manifestFrom: "T-002", manifestTo: "T-001" }
    };
    const connection = { source: "T-003", target: "T-002" };
    const handleReconnectEdge = vi.fn().mockResolvedValue(undefined);
    const handleEdgesDelete = vi.fn().mockResolvedValue(undefined);
    const handleConnect = vi.fn().mockResolvedValue(undefined);
    render(<GraphView {...defaultProps({ edges: [edge], handleConnect, handleEdgesDelete, handleReconnectEdge })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    const latestProps = reactFlowMock.props.at(-1) as {
      onReconnect: (selectedEdge: typeof edge, nextConnection: typeof connection) => void;
    };

    act(() => {
      latestProps.onReconnect(edge, connection);
    });

    await waitFor(() => expect(handleReconnectEdge).toHaveBeenCalledWith(edge, connection));
    expect(handleEdgesDelete).not.toHaveBeenCalled();
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it("fits once for a newly selected canvas", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { rerender } = render(<GraphView {...defaultProps()} />);
    await waitFor(() => expect(reactFlowMock.flowInstance.fitView).toHaveBeenCalledTimes(1));

    rerender(<GraphView {...defaultProps({ selectedCanvasId: "canvas-next" })} />);

    await waitFor(() => expect(reactFlowMock.flowInstance.fitView).toHaveBeenCalledTimes(2));
  });

  it("lets task focus own the initial viewport when a task is selected", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { rerender } = render(<GraphView {...defaultProps({ selectedTaskPanelId: "T-001" })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    expect(reactFlowMock.flowInstance.fitView).not.toHaveBeenCalled();

    rerender(<GraphView {...defaultProps({ selectedTaskPanelId: null })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(1));
    expect(reactFlowMock.flowInstance.fitView).not.toHaveBeenCalled();
  });
});

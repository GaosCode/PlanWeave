/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView } from "../renderer/views/GraphView";
import { createTranslator } from "../renderer/i18n";
import { taskNodeLabels } from "../renderer/graph/taskNodeLabels";
import type { AppFlowNode } from "../renderer/types";

const reactFlowMock = vi.hoisted(() => ({
  flowInstance: {
    fitView: vi.fn(),
    screenToFlowPosition: vi.fn((position: { x: number; y: number }) => ({
      x: position.x - 10,
      y: position.y - 20
    }))
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
        (props.onInit as ((instance: typeof reactFlowMock.flowInstance) => void) | undefined)?.(
          reactFlowMock.flowInstance
        );
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
      onTitleChange: vi.fn(),
      onTitleSave: vi.fn(),
      onExecutorChange: vi.fn(),
      onPromptChange: vi.fn(),
      onPromptSave: vi.fn(),
      onPromptHistoryRedo: vi.fn().mockResolvedValue(undefined),
      onPromptHistoryUndo: vi.fn().mockResolvedValue(undefined),
      onBlockSelect: vi.fn(),
      onBlockWorkspaceOpen: vi.fn(),
      onOverflowBlockSelect: vi.fn(),
      onTaskOpen: vi.fn(),
      onTaskWorkspaceOpen: vi.fn(),
      onAgentPromptCopy: vi.fn(),
      onRevealTaskInFinder: vi.fn(),
      onAutoRunScopeStart: vi.fn().mockResolvedValue(undefined),
      onTaskDelete: vi.fn(),
      onBlockDelete: vi.fn(),
      onSelectedBlockChange: vi.fn(),
      onBlockTitleSave: vi.fn(),
      onBlockPromptSave: vi.fn(),
      onOpenRunRecord: vi.fn()
    }
  };
}

function defaultProps(
  patch: Partial<ComponentProps<typeof GraphView>> = {}
): ComponentProps<typeof GraphView> {
  return {
    autoRunControlStyle: {},
    autoRunScopeMode: "project",
    autoRunState: null,
    runtimeAvailability: { kind: "not_applicable" },
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
    projectDiagnostics: [],
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
    sharedCanvasOffline: false,
    sharedCanvasRevision: null,
    t: createTranslator("en"),
    visibleTaskIds: new Set(["T-001"]),
    visibleTasks: undefined,
    ...patch
  };
}

afterEach(() => {
  cleanup();
  reactFlowMock.flowInstance.fitView.mockClear();
  reactFlowMock.flowInstance.screenToFlowPosition.mockClear();
  reactFlowMock.props = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GraphView viewport fitting", () => {
  it.each([
    [{ kind: "server_disconnected" } as const, "Server disconnected"],
    [{ kind: "checking" } as const, "Checking shared state and execution capability"],
    [{ kind: "error", message: "IPC failed" } as const, "Execution capability check failed"],
    [
      { kind: "unavailable", reason: "runtime_not_attached", statusKnown: true } as const,
      "No execution device available"
    ],
    [
      { kind: "unavailable", reason: "host_offline", statusKnown: true } as const,
      "Execution device is offline"
    ],
    [
      { kind: "unavailable", reason: "content_out_of_sync", statusKnown: true } as const,
      "working directory is out of sync"
    ]
  ])("shows the mutually exclusive collaboration availability banner", (availability, message) => {
    render(<GraphView {...defaultProps({ runtimeAvailability: availability })} />);

    expect(screen.getByTestId("collaboration-runtime-availability")).toHaveTextContent(message);
    expect(screen.queryByTestId("shared-canvas-offline-replica")).not.toBeInTheDocument();
  });

  it("does not label a disconnected Server as Runtime not attached", () => {
    render(
      <GraphView
        {...defaultProps({
          runtimeAvailability: { kind: "server_disconnected" },
          sharedCanvasOffline: true
        })}
      />
    );

    const banner = screen.getByTestId("collaboration-runtime-availability");
    expect(banner).toHaveTextContent("Server disconnected");
    expect(banner).not.toHaveTextContent("No execution device available");
  });

  it("offers a controlled one-time local status sync when Server state is uninitialized", async () => {
    const onImportRuntimeState = vi.fn().mockResolvedValue(undefined);
    render(
      <GraphView
        {...defaultProps({
          runtimeAvailability: { kind: "state_uninitialized" },
          onImportRuntimeState
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync local runtime state" }));
    await waitFor(() => expect(onImportRuntimeState).toHaveBeenCalledOnce());
  });

  it("labels the retained shared replica as offline and read-only", () => {
    render(<GraphView {...defaultProps({ sharedCanvasOffline: true, sharedCanvasRevision: 4 })} />);

    expect(screen.getByTestId("shared-canvas-offline-replica")).toHaveTextContent(
      "Offline · read-only · last confirmed revision 4"
    );
  });

  it("enables ReactFlow viewport-only rendering for the task graph", async () => {
    render(<GraphView {...defaultProps()} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    expect(reactFlowMock.props.at(-1)?.onlyRenderVisibleElements).toBe(true);
  });

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

    rerender(
      <GraphView
        {...defaultProps({
          graph: graph("# Updated prompt"),
          nodes: [flowNode("# Updated prompt")]
        })}
      />
    );

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
    render(
      <GraphView
        {...defaultProps({ edges: [edge], handleConnect, handleEdgesDelete, handleReconnectEdge })}
      />
    );

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

  it("keeps single-click selection and opens Task Workspace on a task-node double-click", async () => {
    const node = flowNode();
    const onTaskWorkspaceOpen = vi.fn();
    const onTaskPanelSelect = vi.fn();
    node.data.onTaskWorkspaceOpen = onTaskWorkspaceOpen;
    render(<GraphView {...defaultProps({ nodes: [node], onTaskPanelSelect })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    const latestProps = reactFlowMock.props.at(-1) as {
      onNodeClick: (event: MouseEvent, selectedNode: AppFlowNode) => void;
      onNodeDoubleClick: (event: MouseEvent, selectedNode: AppFlowNode) => void;
    };

    act(() => {
      latestProps.onNodeClick(new MouseEvent("click"), node);
    });
    expect(onTaskPanelSelect).toHaveBeenCalledWith("T-001");
    expect(onTaskWorkspaceOpen).not.toHaveBeenCalled();

    act(() => {
      latestProps.onNodeDoubleClick(new MouseEvent("dblclick"), node);
    });

    expect(onTaskWorkspaceOpen).toHaveBeenCalledWith("T-001");
  });

  it("does not open Task Workspace when an editable node control is double-clicked", async () => {
    const node = flowNode();
    const onTaskWorkspaceOpen = vi.fn();
    node.data.onTaskWorkspaceOpen = onTaskWorkspaceOpen;
    render(<GraphView {...defaultProps({ nodes: [node] })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    const latestProps = reactFlowMock.props.at(-1) as {
      onNodeDoubleClick: (event: MouseEvent, selectedNode: AppFlowNode) => void;
    };
    const titleInput = document.createElement("input");
    const event = new MouseEvent("dblclick");
    Object.defineProperty(event, "target", { value: titleInput });

    act(() => {
      latestProps.onNodeDoubleClick(event, node);
    });

    expect(onTaskWorkspaceOpen).not.toHaveBeenCalled();
  });

  it("does not open Task Workspace when a dependency handle is double-clicked", async () => {
    const node = flowNode();
    const onTaskWorkspaceOpen = vi.fn();
    node.data.onTaskWorkspaceOpen = onTaskWorkspaceOpen;
    render(<GraphView {...defaultProps({ nodes: [node] })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    const latestProps = reactFlowMock.props.at(-1) as {
      onNodeDoubleClick: (event: MouseEvent, selectedNode: AppFlowNode) => void;
    };
    const dependencyHandle = document.createElement("div");
    dependencyHandle.dataset.graphInteraction = "dependency-handle";
    const event = new MouseEvent("dblclick");
    Object.defineProperty(event, "target", { value: dependencyHandle });

    act(() => {
      latestProps.onNodeDoubleClick(event, node);
    });

    expect(onTaskWorkspaceOpen).not.toHaveBeenCalled();
  });
});

describe("GraphView canvas presence wiring", () => {
  it("tracks pointers over the full graph surface (including nodes) and forwards selections", async () => {
    const presence = {
      remoteSessions: [],
      error: null,
      onPointerMove: vi.fn(),
      onPointerLeave: vi.fn(),
      onSelectionChange: vi.fn()
    };
    const node = flowNode();
    render(<GraphView {...defaultProps({ nodes: [node], presence })} />);

    await waitFor(() => expect(reactFlowMock.props.length).toBeGreaterThan(0));
    const surface = document.querySelector("[data-graph-surface]");
    expect(surface).toBeTruthy();
    // Move over the surface (covers empty pane and task nodes — not pane-only).
    fireEvent.mouseMove(surface!, { clientX: 100, clientY: 200 });
    expect(reactFlowMock.flowInstance.screenToFlowPosition).toHaveBeenCalledWith({
      x: 100,
      y: 200
    });
    expect(presence.onPointerMove).toHaveBeenCalledWith({ x: 90, y: 180 });

    const latestProps = reactFlowMock.props.at(-1) as {
      onSelectionChange: (selection: { nodes: AppFlowNode[]; edges: [] }) => void;
    };
    act(() => latestProps.onSelectionChange({ nodes: [node], edges: [] }));
    expect(presence.onSelectionChange).toHaveBeenCalledWith({ nodes: [node], edges: [] });

    // Leave only when exiting the whole graph surface — not when entering a node.
    fireEvent.mouseLeave(surface!);
    expect(presence.onPointerLeave).toHaveBeenCalledTimes(1);
    // Pane handlers must not be the presence leave path (they fire when hovering nodes).
    const paneProps = reactFlowMock.props.at(-1) as {
      onPaneMouseLeave?: () => void;
      onPaneMouseMove?: (event: MouseEvent) => void;
    };
    expect(paneProps.onPaneMouseLeave).toBeUndefined();
    expect(paneProps.onPaneMouseMove).toBeUndefined();
  });
});

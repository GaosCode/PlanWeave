/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CSSProperties, MouseEventHandler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskNodeCard } from "../renderer/graph/TaskNodeCard";
import { taskNodeLabels } from "../renderer/graph/taskNodeLabels";
import { createTranslator } from "../renderer/i18n";
import type { TaskNodeData } from "../renderer/types";

vi.mock("@xyflow/react", () => ({
  Handle: ({
    className,
    "data-graph-interaction": graphInteraction,
    onClick,
    position,
    style,
    type
  }: {
    className?: string;
    "data-graph-interaction"?: string;
    onClick?: MouseEventHandler<HTMLDivElement>;
    position?: string;
    style?: CSSProperties;
    type?: string;
  }) => (
    <button
      type="button"
      className={className}
      data-graph-interaction={graphInteraction}
      data-testid={`handle-${type ?? "unknown"}`}
      data-position={position}
      onClick={onClick}
      style={style}
    />
  ),
  Position: {
    Left: "left",
    Right: "right"
  }
}));

vi.mock("../renderer/team/WorkItemCollaborationPanel", () => ({
  WorkItemCollaborationPanel: ({
    workItem
  }: {
    workItem: { kind: "task"; taskId: string } | { kind: "block"; blockRef: string };
  }) => (
    <div data-testid="mock-comments-panel">
      {workItem.kind === "task" ? workItem.taskId : workItem.blockRef}
    </div>
  )
}));

afterEach(() => {
  cleanup();
});

function stubSelectLayoutApis() {
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false)
  });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
}

function task(promptMarkdown: string): DesktopGraphViewModel["tasks"][number] {
  return {
    taskId: "T-001",
    title: "Task",
    status: "ready",
    executor: null,
    executorLabel: "manual",
    promptMarkdown,
    promptPreview: "Prompt",
    sharedResources: [],
    blocks: [],
    blockPreview: [],
    hiddenBlockRefs: [],
    overflowBlockCount: 0,
    exceptions: []
  };
}

function nodeData(patch: Partial<TaskNodeData> = {}): TaskNodeData {
  return {
    task: task("# Prompt"),
    titleDraft: "Task",
    promptDraft: "# Prompt",
    saveState: "idle",
    agentEndpoints: [
      {
        id: "local:manual",
        source: "local",
        executorName: "manual",
        displayName: "Manual",
        locationName: "",
        capabilities: [],
        available: true,
        unavailableReason: null,
        localExecutorName: "manual"
      }
    ],
    selectedAgentEndpointId: "local:manual",
    agentEndpointFleetCatalogError: null,
    runtimeOperationsAllowed: true,
    runtimeStatusKnown: true,
    labels: taskNodeLabels(createTranslator("en")),
    selectedBlock: null,
    commentUi: null,
    onTitleChange: vi.fn(),
    onTitleSave: vi.fn(),
    onAgentEndpointChange: vi.fn(),
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
    onOpenRunRecord: vi.fn(),
    ...patch
  };
}

function renderTaskNode(data: TaskNodeData) {
  render(<TaskNodeCard {...({ data, selected: false } as Parameters<typeof TaskNodeCard>[0])} />);
}

describe("TaskNodeCard prompt history shortcuts", () => {
  it("routes undo to PlanGraph history when the prompt draft is clean", () => {
    const onPromptHistoryUndo = vi.fn().mockResolvedValue(undefined);
    renderTaskNode(nodeData({ onPromptHistoryUndo }));

    fireEvent.keyDown(screen.getByRole("textbox", { name: "T-001 prompt" }), {
      key: "z",
      metaKey: true
    });

    expect(onPromptHistoryUndo).toHaveBeenCalledTimes(1);
  });

  it("keeps native text undo when the prompt draft is dirty", () => {
    const onPromptHistoryUndo = vi.fn().mockResolvedValue(undefined);
    renderTaskNode(nodeData({ promptDraft: "# Unsaved prompt", onPromptHistoryUndo }));

    fireEvent.keyDown(screen.getByRole("textbox", { name: "T-001 prompt" }), {
      key: "z",
      metaKey: true
    });

    expect(onPromptHistoryUndo).not.toHaveBeenCalled();
  });
});

describe("TaskNodeCard executor options", () => {
  it("allows selecting a compatible remote Task Endpoint", async () => {
    stubSelectLayoutApis();
    const onAgentEndpointChange = vi.fn();
    const data = Object.assign(nodeData(), {
      agentEndpoints: [
        {
          id: "local:codex",
          source: "local" as const,
          executorName: "codex",
          displayName: "Codex",
          locationName: "This device",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null,
          localExecutorName: "codex"
        },
        {
          id: "remote:endpoint-windows",
          source: "remote" as const,
          executorName: "codex",
          displayName: "Codex",
          locationName: "LINANIML",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null,
          remoteEndpointId: "endpoint-windows"
        }
      ],
      selectedAgentEndpointId: "local:codex",
      onAgentEndpointChange
    });
    renderTaskNode(data);

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: "Codex" })).toBeInTheDocument();
    const remoteOption = screen.getByRole("option", { name: "Codex · LINANIML" });
    expect(remoteOption).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(remoteOption);
    expect(onAgentEndpointChange).toHaveBeenCalledWith("T-001", "remote:endpoint-windows");
  });

  it("keeps built-in and remote Endpoints when a Plan Package adds a custom executor", async () => {
    stubSelectLayoutApis();
    renderTaskNode(
      nodeData({
        agentEndpoints: [
          ...nodeData().agentEndpoints,
          {
            id: "local:codex",
            source: "local",
            executorName: "codex",
            displayName: "Codex",
            locationName: "",
            capabilities: ["acp.codex"],
            available: true,
            unavailableReason: null,
            localExecutorName: "codex"
          },
          {
            id: "local:custom-shell",
            source: "local",
            executorName: "custom-shell",
            displayName: "custom-shell",
            locationName: "",
            capabilities: [],
            available: true,
            unavailableReason: null,
            localExecutorName: "custom-shell"
          },
          {
            id: "remote:endpoint-windows",
            source: "remote",
            executorName: "codex",
            displayName: "Codex",
            locationName: "LINANIML",
            capabilities: ["acp.codex"],
            available: true,
            unavailableReason: null,
            remoteEndpointId: "endpoint-windows"
          }
        ]
      })
    );

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: "custom-shell" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Codex · LINANIML/ })).toBeInTheDocument();
  });

  it("disables unavailable Agent Endpoints in the task node dropdown", async () => {
    stubSelectLayoutApis();
    renderTaskNode(
      nodeData({
        agentEndpoints: [
          ...nodeData().agentEndpoints,
          {
            id: "local:pi",
            source: "local",
            executorName: "pi",
            displayName: "Pi",
            locationName: "",
            capabilities: [],
            available: false,
            unavailableReason: "not found",
            localExecutorName: "pi"
          }
        ]
      })
    );

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: /pi/i })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.queryByRole("option", { name: "pi-auto" })).not.toBeInTheDocument();
  });
});

describe("TaskNodeCard context menu", () => {
  it("shows unknown Runtime state and disables Task Run when Runtime is unavailable", async () => {
    const onAutoRunScopeStart = vi.fn().mockResolvedValue(undefined);
    renderTaskNode(
      nodeData({
        runtimeOperationsAllowed: false,
        runtimeStatusKnown: false,
        onAutoRunScopeStart
      })
    );

    expect(screen.getByTestId("task-node-status-marker")).toHaveTextContent(
      "Runtime status unknown"
    );
    fireEvent.contextMenu(screen.getByTestId("task-node-card"));
    const runItem = (await screen.findByText("Run This Task")).closest('[role="menuitem"]');
    if (!runItem) throw new Error("task_run_menu_item_missing");
    expect(runItem).toHaveAttribute("data-disabled");
    await userEvent.click(runItem);
    expect(onAutoRunScopeStart).not.toHaveBeenCalled();
  });

  it("leaves ordinary card clicks to ReactFlow task selection", () => {
    const onParentClick = vi.fn();
    const onTaskWorkspaceOpen = vi.fn();
    const data = nodeData({ onTaskWorkspaceOpen });

    render(
      <form onClick={onParentClick} onKeyDown={onParentClick}>
        <TaskNodeCard {...({ data, selected: false } as Parameters<typeof TaskNodeCard>[0])} />
      </form>
    );

    fireEvent.click(screen.getByTestId("task-node-card"));

    expect(onTaskWorkspaceOpen).not.toHaveBeenCalled();
    expect(onParentClick).toHaveBeenCalledTimes(1);
  });

  it("opens a Block workspace without bubbling into Task or ReactFlow selection", () => {
    const onParentClick = vi.fn();
    const onBlockWorkspaceOpen = vi.fn();
    const onTaskWorkspaceOpen = vi.fn();
    const data = nodeData({
      onBlockWorkspaceOpen,
      onTaskWorkspaceOpen,
      task: {
        ...task("# Prompt"),
        blocks: [
          {
            ref: "T-001#B-001",
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
    });

    render(
      <form onClick={onParentClick} onKeyDown={onParentClick}>
        <TaskNodeCard {...({ data, selected: false } as Parameters<typeof TaskNodeCard>[0])} />
      </form>
    );

    const blockButton = screen.getByTestId("task-node-block");
    expect(blockButton.tagName).toBe("BUTTON");

    fireEvent.click(blockButton);

    expect(onBlockWorkspaceOpen).toHaveBeenCalledWith("T-001#B-001");
    expect(onTaskWorkspaceOpen).not.toHaveBeenCalled();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("reveals the task node directory from the context menu", async () => {
    const onRevealTaskInFinder = vi.fn();
    const data = nodeData({ onRevealTaskInFinder });
    renderTaskNode(data);

    fireEvent.contextMenu(screen.getByRole("textbox", { name: "T-001 title" }));
    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems).toHaveLength(5);
    for (const menuItem of menuItems) {
      expect(menuItem.querySelector("[data-icon='inline-start']")).toBeInTheDocument();
    }
    await userEvent.click(
      screen.getByRole("menuitem", { name: data.labels.openTaskInFileManager })
    );

    expect(onRevealTaskInFinder).toHaveBeenCalledWith("T-001");
  });

  it("keeps the task inspector behind its explicit context-menu action", async () => {
    const onTaskOpen = vi.fn();
    const onTaskWorkspaceOpen = vi.fn();
    renderTaskNode(nodeData({ onTaskOpen, onTaskWorkspaceOpen }));

    fireEvent.contextMenu(screen.getByTestId("task-node-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open task inspector" }));

    expect(onTaskOpen).toHaveBeenCalledWith("T-001");
    expect(onTaskWorkspaceOpen).not.toHaveBeenCalled();
  });

  it("opens Task comments from the annotation badge and context menu", async () => {
    const t = createTranslator("en");
    renderTaskNode(
      nodeData({
        commentUi: {
          canvasId: "default",
          taskCommentCount: 2,
          blockCommentCounts: {},
          t
        }
      })
    );

    const trigger = screen.getByRole("button", { name: "View 2 comments" });
    expect(screen.getByTestId("work-item-comments-count")).toHaveTextContent("2");

    await userEvent.click(trigger);
    expect(await screen.findByTestId("mock-comments-panel")).toHaveTextContent("T-001");

    await userEvent.click(trigger);
    fireEvent.contextMenu(screen.getByTestId("task-node-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "View 2 comments" }));
    expect(await screen.findByTestId("mock-comments-panel")).toHaveTextContent("T-001");
  });

  it("does not bubble a double click from the Task comment UI", async () => {
    const onParentDoubleClick = vi.fn();
    const t = createTranslator("en");

    render(
      <div role="application" onDoubleClick={onParentDoubleClick}>
        <TaskNodeCard
          data={nodeData({
            commentUi: {
              canvasId: "default",
              taskCommentCount: 1,
              blockCommentCounts: {},
              t
            }
          })}
        />
      </div>
    );

    const trigger = screen.getByRole("button", { name: "View 1 comments" });
    fireEvent.doubleClick(trigger);
    expect(onParentDoubleClick).not.toHaveBeenCalled();

    await userEvent.click(trigger);
    fireEvent.doubleClick(await screen.findByTestId("work-item-comments-popover"));
    expect(onParentDoubleClick).not.toHaveBeenCalled();
  });

  it("opens Block comments from the Block context menu", async () => {
    const blockRef = "T-001#B-001";
    const t = createTranslator("en");
    renderTaskNode(
      nodeData({
        task: {
          ...task("# Prompt"),
          blocks: [
            {
              ref: blockRef,
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
        },
        commentUi: {
          canvasId: "default",
          taskCommentCount: 0,
          blockCommentCounts: { [blockRef]: 1 },
          t
        }
      })
    );

    fireEvent.contextMenu(screen.getByTestId("task-node-block"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "View 1 comments" }));

    expect(await screen.findByTestId("mock-comments-panel")).toHaveTextContent(blockRef);
  });

  it("shows an unknown Block badge and disables Block Run when Runtime is unavailable", async () => {
    const blockRef = "T-001#B-001";
    const onAutoRunScopeStart = vi.fn().mockResolvedValue(undefined);
    renderTaskNode(
      nodeData({
        task: {
          ...task("# Prompt"),
          blocks: [
            {
              ref: blockRef,
              blockId: "B-001",
              type: "implementation",
              title: "Implement workspace",
              status: "planned",
              executor: null,
              promptMissing: false,
              exceptionReason: null,
              dispatchable: false
            }
          ]
        },
        runtimeOperationsAllowed: false,
        runtimeStatusKnown: false,
        onAutoRunScopeStart
      })
    );

    expect(screen.getByText("B-001 · Runtime status unknown")).toHaveAttribute(
      "data-runtime-status-known",
      "false"
    );
    fireEvent.contextMenu(screen.getByTestId("task-node-block"));
    const runItem = (await screen.findByText("Run This Block")).closest('[role="menuitem"]');
    if (!runItem) throw new Error("block_run_menu_item_missing");
    expect(runItem).toHaveAttribute("data-disabled");
    await userEvent.click(runItem);
    expect(onAutoRunScopeStart).not.toHaveBeenCalled();
  });
});

describe("TaskNodeCard connection handles", () => {
  it("renders stable dependency handles with offset source and target anchors", () => {
    renderTaskNode(nodeData());
    const targetHandles = screen.getAllByTestId("handle-target");
    const sourceHandles = screen.getAllByTestId("handle-source");

    expect(targetHandles).toHaveLength(1);
    expect(targetHandles[0].style.top).toBe("56%");
    expect(targetHandles[0]).toHaveAttribute("data-position", "left");
    expect(targetHandles[0]).toHaveAttribute("data-graph-interaction", "dependency-handle");
    expect(targetHandles[0]).toHaveClass("size-3");

    expect(sourceHandles).toHaveLength(1);
    expect(sourceHandles[0].style.top).toBe("44%");
    expect(sourceHandles[0]).toHaveAttribute("data-position", "right");
    expect(sourceHandles[0]).toHaveAttribute("data-graph-interaction", "dependency-handle");
    expect(sourceHandles[0]).toHaveClass("size-3");
  });

  it("does not open Task Workspace when either dependency handle is clicked", () => {
    const onTaskWorkspaceOpen = vi.fn();
    renderTaskNode(nodeData({ onTaskWorkspaceOpen }));

    fireEvent.click(screen.getByTestId("handle-target"));
    fireEvent.click(screen.getByTestId("handle-source"));

    expect(onTaskWorkspaceOpen).not.toHaveBeenCalled();
  });
});

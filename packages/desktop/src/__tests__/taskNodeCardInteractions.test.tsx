/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskNodeCard } from "../renderer/graph/TaskNodeCard";
import { taskNodeLabels } from "../renderer/graph/taskNodeLabels";
import { createTranslator } from "../renderer/i18n";
import type { TaskNodeData } from "../renderer/types";

vi.mock("@xyflow/react", () => ({
  Handle: ({
    className,
    position,
    style,
    type
  }: {
    className?: string;
    position?: string;
    style?: CSSProperties;
    type?: string;
  }) => (
    <div
      className={className}
      data-testid={`handle-${type ?? "unknown"}`}
      data-position={position}
      style={style}
    />
  ),
  Position: {
    Left: "left",
    Right: "right"
  }
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
    locks: [],
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
    agentDetections: [],
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
    onRevealTaskInFinder: vi.fn(),
    onAutoRunScopeStart: vi.fn().mockResolvedValue(undefined),
    onTaskDelete: vi.fn(),
    onBlockDelete: vi.fn(),
    onSelectedBlockChange: vi.fn(),
    onBlockTitleSave: vi.fn(),
    onBlockExecutorChange: vi.fn(),
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
  it("shows manifest custom executors in the task node dropdown", async () => {
    stubSelectLayoutApis();
    renderTaskNode(nodeData({ executorOptions: ["manual", "custom-shell"] }));

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: "custom-shell" })).toBeInTheDocument();
  });

  it("disables detected missing agent executors in the task node dropdown", async () => {
    stubSelectLayoutApis();
    renderTaskNode(
      nodeData({
        agentDetections: [
          {
            kind: "pi",
            name: "Pi",
            command: "pi",
            versionArgs: ["--version"],
            execArgs: ["-p"],
            fullAccessArgs: ["-p"],
            installed: false,
            version: null,
            unavailableReason: "not found"
          }
        ],
        executorOptions: ["manual", "pi", "pi-auto"]
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
  it("reveals the task node directory from the context menu", async () => {
    const onRevealTaskInFinder = vi.fn();
    renderTaskNode(nodeData({ onRevealTaskInFinder }));

    fireEvent.contextMenu(screen.getByRole("textbox", { name: "T-001 title" }));
    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems).toHaveLength(4);
    for (const menuItem of menuItems) {
      expect(menuItem.querySelector("[data-icon='inline-start']")).toBeInTheDocument();
    }
    await userEvent.click(within(menuItems[1]).getByText(/Open task in/));

    expect(onRevealTaskInFinder).toHaveBeenCalledWith("T-001");
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
    expect(targetHandles[0]).toHaveClass("size-3");

    expect(sourceHandles).toHaveLength(1);
    expect(sourceHandles[0].style.top).toBe("44%");
    expect(sourceHandles[0]).toHaveAttribute("data-position", "right");
    expect(sourceHandles[0]).toHaveClass("size-3");
  });
});

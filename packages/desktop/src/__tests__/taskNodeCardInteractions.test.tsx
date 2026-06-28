/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    <div className={className} data-testid={`handle-${type ?? "unknown"}`} data-position={position} style={style} />
  ),
  Position: {
    Left: "left",
    Right: "right"
  }
}));

afterEach(() => {
  cleanup();
});

function task(promptMarkdown: string): DesktopGraphViewModel["tasks"][number] {
  return {
    taskId: "T-001",
    title: "Task",
    status: "ready",
    executor: null,
    executorLabel: "manual",
    promptMarkdown,
    promptPreview: "Prompt",
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

    fireEvent.keyDown(screen.getByRole("textbox", { name: "T-001 prompt" }), { key: "z", metaKey: true });

    expect(onPromptHistoryUndo).toHaveBeenCalledTimes(1);
  });

  it("keeps native text undo when the prompt draft is dirty", () => {
    const onPromptHistoryUndo = vi.fn().mockResolvedValue(undefined);
    renderTaskNode(nodeData({ promptDraft: "# Unsaved prompt", onPromptHistoryUndo }));

    fireEvent.keyDown(screen.getByRole("textbox", { name: "T-001 prompt" }), { key: "z", metaKey: true });

    expect(onPromptHistoryUndo).not.toHaveBeenCalled();
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

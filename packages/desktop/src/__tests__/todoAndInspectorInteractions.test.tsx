/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { TaskInspector } from "../renderer/inspector/TaskInspector";
import { TodoGroupCard } from "../renderer/components/TodoGroupCard";
import { createTranslator } from "../renderer/i18n";
import type { DesktopBlockDetail, DesktopGraphViewModel, DesktopTaskDetail, DesktopTodoItem } from "@planweave-ai/runtime";
import { cleanupRendererTestEnvironment, stubSelectLayoutApis } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const missingPiAgent = {
  kind: "pi" as const,
  name: "Pi",
  command: "pi",
  versionArgs: ["--version"],
  execArgs: ["-p"],
  fullAccessArgs: ["-p"],
  installed: false,
  version: null,
  unavailableReason: "not found"
};

describe("desktop renderer component interactions", () => {
  it("renders Todo blockers, parallel safety, and locks and jumps to the selected block", async () => {
    const item: DesktopTodoItem = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      title: "Implement dependency-aware Todo",
      status: "ready",
      dependencyBlockers: ["T-002"],
      parallelSafe: false,
      locks: ["package/manifest.json"],
      reviewGate: {
        isGate: true,
        required: true,
        requiredReason: "Required review gate for task completion.",
        executorRole: "reviewer",
        downstreamTasks: ["T-003"],
        unlocksTasks: ["T-003"],
        needsChangesReturnsTo: ["T-001#B-001"]
      }
    };
    const onSelect = vi.fn();

    render(
      <TodoGroupCard
        items={[item]}
        labels={{
          dependencyBlockers: "Dependency blockers",
          locks: "Locks",
          noBlockers: "No blockers",
          noLocks: "No locks",
          parallelBlocked: "Not safe",
          parallelSafe: "Safe",
          parallelSafety: "Parallel safety",
          reviewExecutor: "Review role",
          reviewGate: "Review gate",
          reviewNeedsChangesReturnsTo: "Needs changes returns to",
          reviewRequired: "Required review",
          reviewUnlocks: "Unlocks"
        }}
        onSelect={onSelect}
        status="ready"
      />
    );

    expect(screen.getByText("Dependency blockers")).toBeInTheDocument();
    expect(screen.getByText("T-002")).toBeInTheDocument();
    expect(screen.getByText("Parallel safety")).toBeInTheDocument();
    expect(screen.getAllByText("Not safe")).toHaveLength(2);
    expect(screen.getByText("package/manifest.json")).toBeInTheDocument();
    expect(screen.getByText("Review gate")).toBeInTheDocument();
    expect(screen.getByText("Required review")).toBeInTheDocument();
    expect(screen.getByText("Needs changes returns to")).toBeInTheDocument();
    expect(screen.getByText("T-001#B-001")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Implement dependency-aware Todo/ }));
    expect(onSelect).toHaveBeenCalledWith(item);
  });

  it("renders review gate metadata in the block inspector", () => {
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-001#R-001",
      taskId: "T-001",
      blockId: "R-001",
      type: "review",
      title: "Review task",
      status: "ready",
      executor: null,
      effectiveExecutor: "codex",
      promptMarkdown: "# Review",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective review",
      promptSources: [],
      dependencies: ["T-001#B-001"],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: {
        isGate: true,
        required: true,
        requiredReason: "Required review gate for task completion.",
        executorRole: "reviewer",
        downstreamTasks: ["T-002"],
        unlocksTasks: ["T-002"],
        needsChangesReturnsTo: ["T-001#B-001"]
      }
    };

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["codex"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Review gate")).toBeInTheDocument();
    expect(screen.getByText("Required review")).toBeInTheDocument();
    expect(screen.getByText("Review role")).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText("Unlocks")).toBeInTheDocument();
    expect(screen.getByText("T-002")).toBeInTheDocument();
    expect(screen.getByText("Needs changes returns to")).toBeInTheDocument();
    expect(screen.getByText("T-001#B-001")).toBeInTheDocument();
  });

  it("shows manifest custom executors in the block inspector dropdown", async () => {
    stubSelectLayoutApis();
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Implement task",
      status: "ready",
      executor: null,
      effectiveExecutor: "manual",
      promptMarkdown: "# Implement",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["manual", "custom-shell"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: "custom-shell" })).toBeInTheDocument();
  });

  it("folds auto executor aliases and disables missing agents in the block inspector dropdown", async () => {
    stubSelectLayoutApis();
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Implement task",
      status: "ready",
      executor: "pi-auto",
      effectiveExecutor: "pi-auto",
      promptMarkdown: "# Implement",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };

    render(
      <BlockInspector
        agentDetections={[missingPiAgent]}
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["manual", "pi", "pi-auto"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("pi");

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: /pi/i })).toHaveAttribute("data-disabled");
    expect(screen.queryByRole("option", { name: "pi-auto" })).not.toBeInTheDocument();
  });

  it("keeps a block custom executor selected when it is absent from graph options", () => {
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Implement task",
      status: "ready",
      executor: "legacy-executor",
      effectiveExecutor: "legacy-executor",
      promptMarkdown: "# Implement",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["manual"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("legacy-executor");
    expect(screen.getByRole("combobox")).not.toHaveTextContent("Inherit");
  });

  it("lets block prompt textareas grow into the inspector page scroll", () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return Math.max(120, this.value.split("\n").length * 24);
      }
    });
    const initialBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Implement task",
      status: "ready",
      executor: "codex",
      effectiveExecutor: "codex",
      promptMarkdown: "# Source\n- one",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective\n- one\n- two\n- three\n- four\n- five",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };

    function BlockInspectorHarness() {
      const [selectedBlock, setSelectedBlock] = useState<DesktopBlockDetail | null>(initialBlock);

      return (
        <BlockInspector
          blockFeedbackRecords={[]}
          blockReviewAttempts={[]}
          blockRunRecords={[]}
          error={null}
          executorOptions={["codex"]}
          graph={null}
          handleOpenRunRecord={vi.fn()}
          onBlockSelect={vi.fn()}
          onClose={vi.fn()}
          saveSelectedBlockExecutor={vi.fn()}
          saveSelectedBlockPrompt={vi.fn()}
          saveSelectedBlockTitle={vi.fn()}
          selectedBlock={selectedBlock}
          selectedRunRecord={null}
          setSelectedBlock={setSelectedBlock}
          setSelectedRunRecord={vi.fn()}
          t={createTranslator("en")}
        />
      );
    }

    try {
      render(<BlockInspectorHarness />);

      const effectivePrompt = screen.getByRole("textbox", { name: "Effective Prompt" }) as HTMLTextAreaElement;
      const sourcePrompt = screen.getByRole("textbox", { name: "Source Prompt" }) as HTMLTextAreaElement;
      const inspectorContent = screen.getByTestId("block-inspector-content");
      expect(inspectorContent).not.toHaveClass("min-h-0");
      expect(inspectorContent).not.toHaveClass("flex-1");
      expect(effectivePrompt).toHaveClass("overflow-hidden");
      expect(sourcePrompt).toHaveClass("overflow-hidden");
      expect(sourcePrompt.style.fieldSizing).toBe("fixed");
      expect(sourcePrompt).not.toHaveClass("flex-1");
      expect(effectivePrompt.style.height).toBe(`${effectivePrompt.scrollHeight}px`);
      expect(sourcePrompt.style.height).toBe(`${sourcePrompt.scrollHeight}px`);

      fireEvent.change(sourcePrompt, { target: { value: `# Source\n${Array.from({ length: 12 }, (_value, index) => `- line ${index + 1}`).join("\n")}` } });

      expect(sourcePrompt.value).toContain("- line 12");
      expect(sourcePrompt.style.height).toBe(`${sourcePrompt.scrollHeight}px`);
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", scrollHeightDescriptor);
      } else {
        Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
      }
    }
  });

  it("keeps a task current executor selected when it is absent from graph options", () => {
    const selectedTask: DesktopTaskDetail = {
      taskId: "T-001",
      graphVersion: "pgv-task",
      title: "Task",
      status: "ready",
      executor: "legacy-executor",
      promptMarkdown: "# Task",
      promptHash: "hash-task",
      promptMissing: false,
      acceptance: [],
      blockOrder: []
    };
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Project",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: ["manual"],
      tasks: [
        {
          taskId: "T-001",
          title: "Task",
          status: "ready",
          executor: "legacy-executor",
          executorLabel: "legacy-executor",
          promptMarkdown: "# Task",
          promptPreview: "Task",
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

    render(
      <TaskInspector
        error={null}
        executorOptions={graph.executorOptions}
        graph={graph}
        onClose={vi.fn()}
        saveSelectedTaskExecutor={vi.fn()}
        saveSelectedTaskPrompt={vi.fn()}
        saveSelectedTaskTitle={vi.fn()}
        selectedTask={selectedTask}
        setSelectedTask={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("legacy-executor");
  });

  it("folds auto executor aliases and disables missing agents in the task inspector dropdown", async () => {
    stubSelectLayoutApis();
    const selectedTask: DesktopTaskDetail = {
      taskId: "T-001",
      graphVersion: "pgv-task",
      title: "Task",
      status: "ready",
      executor: "pi-auto",
      promptMarkdown: "# Task",
      promptHash: "hash-task",
      promptMissing: false,
      acceptance: [],
      blockOrder: []
    };
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Project",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: ["manual", "pi", "pi-auto"],
      tasks: [
        {
          taskId: "T-001",
          title: "Task",
          status: "ready",
          executor: "pi-auto",
          executorLabel: "pi-auto",
          promptMarkdown: "# Task",
          promptPreview: "Task",
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

    render(
      <TaskInspector
        agentDetections={[missingPiAgent]}
        error={null}
        executorOptions={graph.executorOptions}
        graph={graph}
        onClose={vi.fn()}
        saveSelectedTaskExecutor={vi.fn()}
        saveSelectedTaskPrompt={vi.fn()}
        saveSelectedTaskTitle={vi.fn()}
        selectedTask={selectedTask}
        setSelectedTask={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("pi");

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: /pi/i })).toHaveAttribute("data-disabled");
    expect(screen.queryByRole("option", { name: "pi-auto" })).not.toBeInTheDocument();
  });


  it("autosaves block prompt edits without rendering the manual save button", async () => {
    vi.useFakeTimers();
    const saveSelectedBlockPrompt = vi.fn().mockResolvedValue(undefined);
    const initialBlock: DesktopBlockDetail = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      type: "implementation",
      title: "Create README and sample note",
      status: "ready",
      executor: "codex",
      effectiveExecutor: "codex",
      promptMarkdown: "# Existing block prompt\n",
      promptMissing: false,
      promptSurfaceMarkdown: "# Effective block prompt",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Tiny Notes",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: ["codex"],
      tasks: [
        {
          taskId: "T-001",
          title: "Create starter docs",
          status: "ready",
          executor: "codex",
          executorLabel: "codex",
          promptMarkdown: "# Task",
          promptPreview: "Task",
          blocks: [
            {
              ref: "T-001#B-001",
              blockId: "B-001",
              type: "implementation",
              title: "Create README and sample note",
              status: "ready",
              executor: "codex",
              executorLabel: "codex",
              dependencies: []
            }
          ],
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

    function BlockInspectorHarness() {
      const [selectedBlock, setSelectedBlock] = useState<DesktopBlockDetail | null>(initialBlock);

      return (
        <BlockInspector
          blockFeedbackRecords={[]}
          blockReviewAttempts={[]}
          blockRunRecords={[]}
          error={null}
          executorOptions={["codex"]}
          graph={graph}
          handleOpenRunRecord={vi.fn()}
          onBlockSelect={vi.fn()}
          onClose={vi.fn()}
          saveSelectedBlockExecutor={vi.fn()}
          saveSelectedBlockPrompt={saveSelectedBlockPrompt}
          saveSelectedBlockTitle={vi.fn()}
          selectedBlock={selectedBlock}
          selectedRunRecord={null}
          setSelectedBlock={setSelectedBlock}
          setSelectedRunRecord={vi.fn()}
          t={createTranslator("zh-CN")}
        />
      );
    }

    render(<BlockInspectorHarness />);

    try {
      expect(screen.queryByRole("button", { name: "保存 Prompt" })).not.toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox", { name: "源 Prompt" }), { target: { value: "# Updated block prompt\n" } });
      expect(saveSelectedBlockPrompt).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(800);
      });

      expect(saveSelectedBlockPrompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

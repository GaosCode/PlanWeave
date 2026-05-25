/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSwitchRow } from "../renderer/components/SettingsSwitchRow";
import { HistoryNavigationButtons } from "../renderer/components/HistoryNavigationButtons";
import { appViewHistoryChangedEvent } from "../renderer/hooks/useAppViewHistory";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { BlockRunRecordCard } from "../renderer/inspector/BlockRunRecordCard";
import { SearchResultList, searchNavigationTarget } from "../renderer/components/SearchResultList";
import { TodoGroupCard } from "../renderer/components/TodoGroupCard";
import { createTranslator } from "../renderer/i18n";
import { ProjectSidebar } from "../renderer/sidebar/ProjectSidebar";
import { NotificationsView } from "../renderer/views/NotificationsView";
import { orderProjectsByPinnedIds } from "../renderer/settings";
import type { DesktopBlockDetail, DesktopGraphViewModel, DesktopProjectSummary, DesktopRunRecord, DesktopSearchResult, DesktopTodoItem } from "@planweave/runtime";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop renderer component interactions", () => {
  it("keeps sidebar tree labels visible while right-side controls collapse rows", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const project: DesktopProjectSummary = {
      projectId: "P-001",
      name: "frontend-example",
      rootPath: "/tmp/frontend-example",
      workspaceRoot: "/tmp/frontend-example",
      taskCanvases: [
        {
          canvasId: "default",
          name: "frontend-example",
          taskCount: 2,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z"
        }
      ]
    };
    const graph: DesktopGraphViewModel = {
      projectId: project.projectId,
      projectTitle: project.name,
      executorOptions: ["manual"],
      tasks: [
        {
          taskId: "T-TASK",
          title: "新",
          status: "ready",
          executor: null,
          executorLabel: "inherit",
          promptMarkdown: "# 新 Task",
          promptPreview: "新 Task",
          blocks: [],
          blockPreview: [],
          hiddenBlockRefs: [],
          overflowBlockCount: 0,
          exceptions: []
        },
        {
          taskId: "T-002",
          title: "新 Task",
          status: "ready",
          executor: null,
          executorLabel: "inherit",
          promptMarkdown: "# 新 Task",
          promptPreview: "新 Task",
          blocks: [],
          blockPreview: [],
          hiddenBlockRefs: [],
          overflowBlockCount: 0,
          exceptions: []
        }
      ],
      contextNodes: [],
      edges: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={project.projectId}
        graph={graph}
        handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRevealProject={vi.fn().mockResolvedValue(undefined)}
        handleTaskPanelSelect={vi.fn()}
        loadProject={vi.fn().mockResolvedValue(undefined)}
        notificationItems={[]}
        onToggleSidebar={vi.fn()}
        onTogglePinnedProject={vi.fn()}
        pinnedProjectIds={new Set()}
        projects={[project]}
        resetLayout={vi.fn().mockResolvedValue(undefined)}
        selectedProject={project}
        selectedCanvasId={null}
        selectedTaskPanelId={null}
        setActiveView={vi.fn()}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.getByRole("button", { name: "frontend-example" })).toBeVisible();
    expect(screen.getByRole("button", { name: /frontend-example\s*2/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "收起任务画布" })).toBeVisible();
    expect(screen.getByRole("button", { name: /新\s*T-TASK/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /新 Task\s*T-002/ })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "收起项目" }));

    expect(screen.getByRole("button", { name: "frontend-example" })).toBeVisible();
    expect(screen.getByRole("button", { name: "展开项目" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /frontend-example\s*2/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新\s*T-TASK/ })).not.toBeInTheDocument();
  });

  it("orders pinned projects before unpinned projects without changing unpinned order", () => {
    const projects = [
      { projectId: "P-1", name: "first" },
      { projectId: "P-2", name: "second" },
      { projectId: "P-3", name: "third" }
    ];

    expect(orderProjectsByPinnedIds(projects, ["P-3", "P-1"]).map((project) => project.projectId)).toEqual(["P-3", "P-1", "P-2"]);
  });

  it("disables history navigation buttons when no app history is available", () => {
    window.history.replaceState(null, "", "/");

    render(<HistoryNavigationButtons t={(key) => ({ redo: "Forward", undo: "Back" })[key] ?? key} />);

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("enables app history buttons after view navigation state changes", async () => {
    window.history.replaceState({ planweaveAppView: "graph", planweaveHistoryIndex: 0, planweaveHistoryMaxIndex: 0 }, "", "/");
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const forwardSpy = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);

    render(<HistoryNavigationButtons t={(key) => ({ redo: "Forward", undo: "Back" })[key] ?? key} />);

    window.history.pushState({ planweaveAppView: "new-task", planweaveHistoryIndex: 1, planweaveHistoryMaxIndex: 1 }, "");
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backSpy).toHaveBeenCalledTimes(1);

    window.history.replaceState({ planweaveAppView: "graph", planweaveHistoryIndex: 0, planweaveHistoryMaxIndex: 1 }, "", "/");
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));
    await userEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(forwardSpy).toHaveBeenCalledTimes(1);

  });

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
          reviewExecutor: "Review executor",
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
      effectiveExecutor: "codex-reviewer",
      promptMarkdown: "# Review",
      dependencies: ["T-001#C-001"],
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
        needsChangesReturnsTo: ["T-001#B-001", "T-001#C-001"]
      }
    };

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["codex-reviewer"]}
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
    expect(screen.getByText("Review executor")).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText("Unlocks")).toBeInTheDocument();
    expect(screen.getByText("T-002")).toBeInTheDocument();
    expect(screen.getByText("Needs changes returns to")).toBeInTheDocument();
    expect(screen.getByText("T-001#B-001, T-001#C-001")).toBeInTheDocument();
  });

  it("routes every searchable result kind to a canvas node or record target", async () => {
    const results: DesktopSearchResult[] = [
      { kind: "prompt", ref: "T-001", targetRef: "T-001", title: "Task prompt", excerpt: "task prompt" },
      { kind: "prompt", ref: "T-001#B-001", targetRef: "T-001#B-001", title: "Block prompt", excerpt: "block prompt" },
      { kind: "context", ref: "CMP-CLI", targetRef: "CMP-CLI", title: "CLI", excerpt: "context" },
      { kind: "review_attempt", ref: "T-001/reviews/R-001/attempts/REV-001/review-result.json", targetRef: "T-001#R-001", title: "Review", excerpt: "review" },
      { kind: "feedback", ref: "FE-001", targetRef: "T-001#R-001", title: "Feedback", excerpt: "feedback" },
      { kind: "run_record", ref: "T-001/blocks/B-001/runs/RUN-001/report.md", recordId: "T-001#B-001::RUN-001", title: "Run", excerpt: "run" }
    ];
    const onOpenResult = vi.fn();

    expect(results.map(searchNavigationTarget)).toEqual([
      { kind: "task", ref: "T-001" },
      { kind: "block", ref: "T-001#B-001" },
      { kind: "context", ref: "CMP-CLI" },
      { kind: "block", ref: "T-001#R-001" },
      { kind: "block", ref: "T-001#R-001" },
      { kind: "record", recordId: "T-001#B-001::RUN-001" }
    ]);

    render(<SearchResultList results={results} targetMissingLabel="No jump target" onOpenResult={onOpenResult} />);
    await userEvent.click(screen.getByRole("button", { name: /Feedback/ }));

    expect(onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "feedback", targetRef: "T-001#R-001" }));
  });

  it("labels successful agent stderr as terminal output instead of an error", () => {
    const runRecord: DesktopRunRecord = {
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      executor: "opencode",
      adapter: "opencode-exec",
      executionCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      agentSessionId: "ses_123",
      codexSessionId: null,
      tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-abcd1234",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234",
      exitCode: 0,
      startedAt: null,
      finishedAt: "2026-05-23T01:49:38.307Z",
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/project/.planweave/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
      stdoutSummary: "",
      stderrSummary: "> build · mimo-v2.5-pro → Read README.md ← Write CHECKLIST.md Wrote file successfully.",
      promptMarkdown: "",
      reportMarkdown: "## Implementation Report",
      displayMarkdown: "## Implementation Report",
      displayMarkdownSource: "report",
      metadata: {}
    };

    const { rerender } = render(<BlockRunRecordCard selectedRunRecord={runRecord} setSelectedRunRecord={vi.fn()} t={createTranslator("zh-CN")} />);

    expect(screen.getByText(/终端输出:/)).toBeInTheDocument();
    expect(screen.getByText(/只读监控命令:/)).toBeInTheDocument();
    expect(screen.getByText("tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234")).toBeInTheDocument();
    expect(screen.queryByText(/错误输出:/)).not.toBeInTheDocument();

    rerender(
      <BlockRunRecordCard
        selectedRunRecord={{ ...runRecord, recordId: "T-001#B-001::RUN-LEGACY", runId: "RUN-LEGACY", exitCode: undefined as unknown as number | null }}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.getByText(/终端输出:/)).toBeInTheDocument();
    expect(screen.queryByText(/错误输出:/)).not.toBeInTheDocument();
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
      contextNodes: [],
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
      fireEvent.change(screen.getAllByRole("textbox")[1]!, { target: { value: "# Updated block prompt\n" } });
      expect(saveSelectedBlockPrompt).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(800);
      });

      expect(saveSelectedBlockPrompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks individual notifications as read from the message close button", async () => {
    const onMarkNotificationRead = vi.fn();

    render(
      <NotificationsView
        notificationItems={[
          {
            id: "latest-record:/tmp/record.json",
            title: "最新记录",
            detail: "/tmp/record.json",
            tone: "outline",
            read: false
          },
          {
            id: "dirty-T-001",
            title: "Dirty prompt",
            detail: "T-001",
            tone: "secondary",
            read: true
          }
        ]}
        onMarkNotificationRead={onMarkNotificationRead}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.getByText("通知").closest("[data-slot='card']")).toBeNull();
    expect(screen.getByText("未读")).toBeInTheDocument();
    expect(screen.getByText("已读")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "标记为已读: 最新记录" }));

    expect(onMarkNotificationRead).toHaveBeenCalledWith("latest-record:/tmp/record.json");
  });

  it("renders settings rows as switch controls", async () => {
    const onCheckedChange = vi.fn();

    render(
      <SettingsSwitchRow
        checked={false}
        title="Component visibility"
        description="Show this component in the palette."
        onCheckedChange={onCheckedChange}
      />
    );

    await userEvent.click(screen.getByRole("switch", { name: "Component visibility" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

});

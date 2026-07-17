/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskWorkspaceTimeline } from "../renderer/task-workspace/timeline";
import type { TaskWorkspaceTimelineLabels } from "../renderer/task-workspace/timeline";
import {
  taskWorkspacePanelMaxWidth,
  taskWorkspacePanelMinWidth
} from "../renderer/task-workspace/useTaskWorkspaceLayout";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  reviewAnnotationFixture,
  timelineBlockFixture,
  timelineRunFixture,
  timelineWorkspaceFixture
} from "./helpers/taskWorkspaceTimelineFixture";

afterEach(cleanupRendererTestEnvironment);

const labels: TaskWorkspaceTimelineLabels = {
  agent: "Agent",
  activeRuns: (count) => `Active runs: ${count}`,
  annotationKinds: {
    feedback: "Feedback",
    feedback_run: "Feedback run",
    review_attempt: "Review attempt"
  },
  completed: "Completed",
  dependencies: "Dependencies",
  dependencyProgress: (completed, total, percent) => `${completed}/${total} (${percent}%)`,
  elapsed: "Elapsed",
  empty: "No timeline runs",
  failed: "Failed",
  feedbackStatus: {
    dismissed: "Dismissed",
    in_progress: "In progress",
    open: "Open",
    resolved: "Resolved"
  },
  formatDateTime: (value) => value,
  formatDuration: (milliseconds) => `${milliseconds}ms`,
  latestArtifact: "Latest artifact",
  loadMore: "Load older runs",
  loadingMore: "Loading older runs…",
  noActiveRuns: "No active runs",
  noArtifact: "No artifact",
  overview: "Task overview",
  parallelWave: (waveId, index, total) => `${waveId} ${index}/${total}`,
  resizeTimeline: "Resize timeline",
  retry: (retryIndex) => `Retry ${retryIndex}`,
  reviewVerdict: {
    needs_changes: "Needs changes",
    passed: "Passed"
  },
  run: (blockTitle, retryIndex) => `${blockTitle} run ${retryIndex}`,
  runId: "Run ID",
  running: "Running",
  startedAt: "Started",
  timeline: "Timeline",
  unavailable: "Unavailable",
  waiting: "Waiting"
};

function timelineProps() {
  const firstRef = "T-001#B-001";
  const first = timelineRunFixture(firstRef, "RUN-001", { selected: true });
  const second = timelineRunFixture(firstRef, "RUN-002", { retryIndex: 2 });
  const third = timelineRunFixture("T-001#B-002", "RUN-003", {
    active: true,
    finished: false
  });
  const firstBlock = timelineBlockFixture({
    blockId: "B-001",
    runs: [second, first],
    title: "Implementation"
  });
  const secondBlock = timelineBlockFixture({
    blockId: "B-002",
    runs: [third],
    title: "Verification"
  });
  const workspace = timelineWorkspaceFixture([firstBlock, secondBlock], {
    dependencyProgress: {
      blockers: [firstRef],
      completed: 1,
      percent: 50,
      status: "in_progress",
      total: 2
    },
    latestArtifact: {
      blockRef: firstRef,
      legacy: true,
      recordId: first.run.record.recordId,
      reference: null,
      reportPath: "results/implementation.md",
      runId: first.run.record.runId
    }
  });
  return {
    first,
    firstBlock,
    second,
    setTimelineWidth: vi.fn(),
    third,
    workspace
  };
}

describe("TaskWorkspaceTimeline", () => {
  it("renders the overview, exposes run details, and can select the overview", () => {
    const fixture = timelineProps();
    const selectRun = vi.fn();

    render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectRun={selectRun}
        selectedRecordId={fixture.first.run.record.recordId}
        setTimelineWidth={fixture.setTimelineWidth}
        timelineWidth={280}
        workspace={fixture.workspace}
      />
    );

    expect(screen.getByText("Active runs: 1")).toBeInTheDocument();
    expect(screen.getByText("1/2 (50%)")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Dependencies" })).toHaveAttribute(
      "value",
      "50"
    );
    expect(screen.getByText("results/implementation.md")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("data-retry", "true");
    expect(options[2]).toHaveAttribute("data-status", "active");
    expect(options[0]).toHaveTextContent("Agentcodex");
    expect(options[0]).toHaveTextContent("Run IDRUN-001");
    expect(options[0]).toHaveTextContent("Started2026-07-13T00:00:00.000Z");
    expect(options[0]).toHaveTextContent("Elapsed5000ms");
    fireEvent.click(screen.getByTestId("task-workspace-overview-entry"));
    expect(selectRun).toHaveBeenCalledWith(null);
  });

  it("exposes load-more control when hasMoreRuns is true", async () => {
    const fixture = timelineProps();
    const loadMoreRuns = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        hasMoreRuns
        labels={labels}
        loadMoreRuns={loadMoreRuns}
        loadMoreRunsError={null}
        loadingMoreRuns={false}
        onRunScrollTopChange={vi.fn()}
        selectRun={vi.fn()}
        selectedRecordId={fixture.first.run.record.recordId}
        setTimelineWidth={fixture.setTimelineWidth}
        timelineWidth={280}
        workspace={fixture.workspace}
      />
    );

    await user.click(screen.getByTestId("task-workspace-load-more-runs"));
    expect(loadMoreRuns).toHaveBeenCalledOnce();
  });

  it("supports Arrow, Home, End and Enter without selecting during focus movement", async () => {
    const fixture = timelineProps();
    const selectRun = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectRun={selectRun}
        selectedRecordId={fixture.first.run.record.recordId}
        setTimelineWidth={fixture.setTimelineWidth}
        timelineWidth={280}
        workspace={fixture.workspace}
      />
    );

    const options = screen.getAllByRole("option");
    options[0]?.focus();
    await user.keyboard("{ArrowDown}");
    expect(selectRun).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(selectRun).toHaveBeenCalledTimes(1);
    expect(selectRun).toHaveBeenLastCalledWith({
      blockRef: fixture.firstBlock.ref,
      recordId: fixture.second.run.record.recordId
    });

    await user.keyboard("{End}{Enter}");
    expect(selectRun).toHaveBeenLastCalledWith({
      blockRef: "T-001#B-002",
      recordId: fixture.third.run.record.recordId
    });
    await user.keyboard("{Home}{Enter}");
    expect(selectRun).toHaveBeenLastCalledWith({
      blockRef: fixture.firstBlock.ref,
      recordId: fixture.first.run.record.recordId
    });
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(selectRun).toHaveBeenLastCalledWith({
      blockRef: fixture.firstBlock.ref,
      recordId: fixture.first.run.record.recordId
    });
  });

  it("windows more than 200 runs while preserving keyboard selection and load-more", async () => {
    const runs = Array.from({ length: 250 }, (_, index) =>
      timelineRunFixture("T-001#B-001", `RUN-${String(index + 1).padStart(3, "0")}`, {
        retryIndex: index + 1,
        selected: index === 0
      })
    );
    const block = timelineBlockFixture({ blockId: "B-001", runs, title: "Implementation" });
    const workspace = timelineWorkspaceFixture([block]);
    const selectRun = vi.fn();
    const loadMoreRuns = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        hasMoreRuns
        labels={labels}
        loadMoreRuns={loadMoreRuns}
        onRunScrollTopChange={vi.fn()}
        selectRun={selectRun}
        selectedRecordId={runs[0]!.run.record.recordId}
        setTimelineWidth={vi.fn()}
        timelineWidth={280}
        workspace={workspace}
      />
    );

    expect(screen.getAllByRole("option")).toHaveLength(80);
    expect(screen.getByTestId("task-workspace-load-more-runs")).toBeInTheDocument();

    screen.getAllByRole("option")[0]?.focus();
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-run-id", "RUN-250");
    expect(screen.getAllByRole("option")).toHaveLength(80);
    await user.keyboard("{Enter}");
    expect(selectRun).toHaveBeenLastCalledWith({
      blockRef: "T-001#B-001",
      recordId: "T-001#B-001::RUN-250"
    });

    await user.click(screen.getByTestId("task-workspace-load-more-runs"));
    expect(loadMoreRuns).toHaveBeenCalledOnce();
  });

  it("keeps the selected and focused run anchored when 50 newer rows are prepended", async () => {
    const originalRuns = Array.from({ length: 200 }, (_, index) =>
      timelineRunFixture("T-001#B-001", `RUN-${String(index + 1).padStart(3, "0")}`, {
        retryIndex: index + 1,
        selected: index === 199
      })
    );
    const originalBlock = timelineBlockFixture({ blockId: "B-001", runs: originalRuns });
    const selected = originalRuns[199]!;
    const props = {
      getRunScrollTop: () => 0,
      labels,
      onRunScrollTopChange: vi.fn(),
      selectRun: vi.fn(),
      selectedRecordId: selected.run.record.recordId,
      setTimelineWidth: vi.fn(),
      timelineWidth: 280
    };
    const { rerender } = render(
      <TaskWorkspaceTimeline {...props} workspace={timelineWorkspaceFixture([originalBlock])} />
    );
    const selectedOption = screen.getByRole("option", { name: "B-001 run 200" });
    selectedOption.focus();

    const newerRuns = Array.from({ length: 50 }, (_, index) =>
      timelineRunFixture("T-001#B-001", `RUN-${String(index + 201).padStart(3, "0")}`, {
        retryIndex: index + 201
      })
    );
    const expandedBlock = timelineBlockFixture({
      blockId: "B-001",
      runs: [...newerRuns, ...originalRuns]
    });
    rerender(
      <TaskWorkspaceTimeline {...props} workspace={timelineWorkspaceFixture([expandedBlock])} />
    );

    const anchored = await screen.findByRole("option", { name: "B-001 run 200" });
    expect(anchored).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(anchored);
    expect(screen.getAllByRole("option")).toHaveLength(80);
  });

  it("falls back to the selected run when focused history is stale after a workspace switch", async () => {
    const firstRuns = Array.from({ length: 250 }, (_, index) =>
      timelineRunFixture("T-001#B-001", `RUN-${String(index + 1).padStart(3, "0")}`, {
        retryIndex: index + 1
      })
    );
    const firstBlock = timelineBlockFixture({ blockId: "B-001", runs: firstRuns });
    const props = {
      getRunScrollTop: () => 0,
      labels,
      onRunScrollTopChange: vi.fn(),
      selectRun: vi.fn(),
      selectedRecordId: firstRuns[0]!.run.record.recordId,
      setTimelineWidth: vi.fn(),
      timelineWidth: 280
    };
    const { rerender } = render(
      <TaskWorkspaceTimeline {...props} workspace={timelineWorkspaceFixture([firstBlock])} />
    );
    screen.getAllByRole("option")[0]!.focus();

    const secondRuns = Array.from({ length: 250 }, (_, index) =>
      timelineRunFixture("T-001#B-002", `RUN-${String(index + 1).padStart(3, "0")}`, {
        retryIndex: index + 1,
        selected: index === 249
      })
    );
    const secondBlock = timelineBlockFixture({ blockId: "B-002", runs: secondRuns });
    const selected = secondRuns[249]!;
    rerender(
      <TaskWorkspaceTimeline
        {...props}
        selectedRecordId={selected.run.record.recordId}
        workspace={timelineWorkspaceFixture([secondBlock])}
      />
    );

    const selectedOption = await screen.findByRole("option", { name: "B-002 run 250" });
    expect(selectedOption).toHaveAttribute("aria-selected", "true");
    expect(selectedOption).toHaveAttribute("tabindex", "0");
    expect(screen.getAllByRole("option").filter((option) => option.tabIndex === 0)).toHaveLength(1);
  });

  it("resizes through the authoritative layout setter with pointer and keyboard input", () => {
    const fixture = timelineProps();
    render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectRun={vi.fn()}
        selectedRecordId={null}
        setTimelineWidth={fixture.setTimelineWidth}
        timelineWidth={280}
        workspace={fixture.workspace}
      />
    );

    const separator = screen.getByRole("separator", { name: "Resize timeline" });
    expect(separator).toHaveAttribute("aria-valuemin", String(taskWorkspacePanelMinWidth));
    expect(separator).toHaveAttribute("aria-valuemax", String(taskWorkspacePanelMaxWidth));
    expect(separator).toHaveAttribute("aria-valuenow", "280");
    expect(separator).toHaveClass(
      "w-2",
      "cursor-col-resize",
      "after:w-px",
      "after:bg-border/80",
      "hover:after:bg-foreground/30",
      "active:after:bg-foreground/50"
    );
    expect(separator).not.toHaveClass("hover:bg-state-selected/10", "active:bg-state-selected/20");
    fireEvent.pointerDown(separator, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    expect(fixture.setTimelineWidth).toHaveBeenCalledWith(330);

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(fixture.setTimelineWidth).toHaveBeenLastCalledWith(296);
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(fixture.setTimelineWidth).toHaveBeenLastCalledWith(264);
  });

  it("opens persisted feedback runs while keeping native review annotations local", () => {
    const reviewRef = "T-001#R-001";
    const selectAnnotation = vi.fn();
    const selectRun = vi.fn();
    const reviewBlock = timelineBlockFixture({
      annotations: [
        reviewAnnotationFixture(reviewRef),
        reviewAnnotationFixture(reviewRef, "feedback_run")
      ],
      blockId: "R-001",
      type: "review"
    });
    const { rerender } = render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectAnnotation={selectAnnotation}
        selectRun={selectRun}
        selectedAnnotation={null}
        selectedRecordId={null}
        setTimelineWidth={vi.fn()}
        timelineWidth={280}
        workspace={timelineWorkspaceFixture([reviewBlock])}
      />
    );

    const review = screen.getByRole("button", { name: /Review attempt/i });
    const feedbackRun = screen.getByRole("button", { name: /Feedback run/i });
    expect(review).toHaveClass("rounded-xl", "border", "bg-background/65");
    expect(feedbackRun).toHaveClass("rounded-xl", "border", "bg-background/65");
    expect(review).toHaveTextContent("Review attemptA-001");
    expect(review).toHaveTextContent("Started2026-07-13T00:00:00.000Z");
    expect(review).toHaveTextContent("Review passed.");
    expect(screen.getAllByTestId("task-workspace-annotation-preview")[0]).toHaveClass(
      "max-h-10",
      "overflow-hidden",
      "[-webkit-line-clamp:2]"
    );

    fireEvent.click(review);
    expect(selectAnnotation).toHaveBeenCalledWith({
      annotationId: "review-attempt:A-001",
      blockRef: reviewRef
    });
    expect(selectRun).not.toHaveBeenCalled();

    const selectedReview = reviewBlock.annotations[0];
    if (!selectedReview) {
      throw new Error("Expected the timeline fixture to contain a Review annotation.");
    }
    rerender(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectAnnotation={selectAnnotation}
        selectRun={selectRun}
        selectedAnnotation={{ annotation: selectedReview, block: reviewBlock }}
        selectedRecordId={null}
        setTimelineWidth={vi.fn()}
        timelineWidth={280}
        workspace={timelineWorkspaceFixture([reviewBlock])}
      />
    );
    expect(screen.getByRole("button", { name: /Review attempt/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const selectedReviewOption = screen.getByRole("button", { name: /Review attempt/i });
    expect(selectedReviewOption).toHaveTextContent("Review passed.");
    expect(
      selectedReviewOption.querySelector("[data-testid='task-workspace-annotation-preview']")
    ).toHaveClass("max-h-10", "overflow-hidden", "[-webkit-line-clamp:2]");
    expect(screen.getByTestId("task-workspace-overview-entry")).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByRole("button", { name: /Feedback run/i }));
    expect(selectRun).toHaveBeenCalledWith({
      blockRef: reviewRef,
      recordId: "F-001::RUN-F-001"
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    rerender(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectAnnotation={selectAnnotation}
        selectRun={selectRun}
        selectedAnnotation={null}
        selectedRecordId="F-001::RUN-F-001"
        setTimelineWidth={vi.fn()}
        timelineWidth={280}
        workspace={timelineWorkspaceFixture([reviewBlock])}
      />
    );
    expect(screen.getByRole("button", { name: /Feedback run/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByTestId("task-workspace-overview-entry")).not.toHaveAttribute("aria-current");

    rerender(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectAnnotation={vi.fn()}
        selectRun={vi.fn()}
        selectedAnnotation={null}
        selectedRecordId={null}
        setTimelineWidth={vi.fn()}
        timelineWidth={280}
        workspace={timelineWorkspaceFixture([])}
      />
    );
    expect(screen.getByText("No timeline runs")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

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
  formatDateTime: (value) => value,
  formatDuration: (milliseconds) => `${milliseconds}ms`,
  latestArtifact: "Latest artifact",
  noActiveRuns: "No active runs",
  noArtifact: "No artifact",
  overview: "Task overview",
  parallelWave: (waveId, index, total) => `${waveId} ${index}/${total}`,
  resizeTimeline: "Resize timeline",
  retry: (retryIndex) => `Retry ${retryIndex}`,
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
        selectedRun={{ block: fixture.firstBlock, item: fixture.first }}
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
    expect(options[0]).toHaveTextContent("Elapsed5000ms");
    fireEvent.click(screen.getByTestId("task-workspace-overview-entry"));
    expect(selectRun).toHaveBeenCalledWith(null);
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
        selectedRun={{ block: fixture.firstBlock, item: fixture.first }}
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

  it("resizes through the authoritative layout setter with pointer and keyboard input", () => {
    const fixture = timelineProps();
    render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectRun={vi.fn()}
        selectedRun={null}
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

  it("renders Review Block annotations as notes and exposes an empty state", () => {
    const reviewRef = "T-001#R-001";
    const reviewBlock = timelineBlockFixture({
      annotations: [reviewAnnotationFixture(reviewRef, "feedback")],
      blockId: "R-001",
      type: "review"
    });
    const { rerender } = render(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectRun={vi.fn()}
        selectedRun={null}
        setTimelineWidth={vi.fn()}
        timelineWidth={280}
        workspace={timelineWorkspaceFixture([reviewBlock])}
      />
    );

    expect(screen.getByRole("note")).toHaveTextContent("Feedback");
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    rerender(
      <TaskWorkspaceTimeline
        getRunScrollTop={() => 0}
        labels={labels}
        onRunScrollTopChange={vi.fn()}
        selectRun={vi.fn()}
        selectedRun={null}
        setTimelineWidth={vi.fn()}
        timelineWidth={280}
        workspace={timelineWorkspaceFixture([])}
      />
    );
    expect(screen.getByText("No timeline runs")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

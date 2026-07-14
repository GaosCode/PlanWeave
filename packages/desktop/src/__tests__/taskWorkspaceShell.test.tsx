/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskWorkspace } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TaskWorkspaceConversationSlotProps,
  TaskWorkspaceController,
  TaskWorkspaceInspectorSlotProps,
  TaskWorkspaceLabels,
  TaskWorkspaceTimelineSlotProps
} from "../renderer/task-workspace/contracts";
import { TaskWorkspaceRoute } from "../renderer/task-workspace/TaskWorkspaceRoute";
import {
  taskWorkspaceConversationMinWidth,
  taskWorkspacePanelMaxWidth,
  taskWorkspacePanelMinWidth,
  useTaskWorkspaceLayout
} from "../renderer/task-workspace/useTaskWorkspaceLayout";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";

afterEach(cleanupRendererTestEnvironment);

const labels: TaskWorkspaceLabels = {
  acceptanceCriteria: "Acceptance criteria",
  activeRuns: (count) => `Active runs: ${count}`,
  agent: "Agent",
  backToCanvas: "Back to canvas",
  blocks: "Blocks",
  booleanFalse: "False",
  booleanTrue: "True",
  composer: "Composer",
  conversation: "Conversation",
  dependencies: "Dependencies",
  dependencyProgress: (completed, total, percent) => `${completed}/${total} (${percent}%)`,
  elapsed: "Elapsed",
  expandTimeline: "Expand timeline",
  formatDuration: (milliseconds) => `${milliseconds / 1_000}s`,
  inspector: "Inspector",
  latestArtifact: "Latest artifact",
  loading: "Loading",
  liveUnavailable: "Live unavailable",
  noActiveRuns: "No active runs",
  noArtifact: "No artifact",
  noConversation: "No conversation",
  noInspector: "No inspector",
  noRuns: "No runs",
  noTask: "No task",
  overview: "Task overview",
  mode: "Mode",
  model: "Model",
  permission: "Permission",
  reasoning: "Reasoning",
  runStatus: {
    active: "Running",
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    waiting: "Waiting"
  },
  status: "Status",
  taskStatus: {
    implemented: "Implemented",
    in_progress: "In progress",
    planned: "Planned",
    ready: "Ready"
  },
  timeline: "Timeline",
  unavailable: "Unavailable"
};

const savedScrollTop = 42;
const initialTimelineWidth = 280;
const initialInspectorWidth = 320;
const resizedTimelineWidth = 480;
const resizedInspectorWidth = 500;

const workspace: TaskWorkspace = {
  version: "planweave.task-workspace/v1",
  project: { projectId: "project-1", projectRoot: "/projects/demo", canvasId: "canvas-main" },
  task: {
    taskId: "T-001",
    title: "Build Task Workspace",
    status: "planned",
    executor: null,
    acceptance: []
  },
  dependencyProgress: {
    total: 0,
    completed: 0,
    percent: 100,
    status: "not_applicable",
    blockers: []
  },
  blocks: [],
  activeRecordIds: [],
  selectedRecordId: null,
  latestArtifact: null,
  duration: {
    wallClock: {
      available: false,
      startedAt: null,
      endedAt: null,
      calculatedAt: "2026-07-13T00:00:00.000Z",
      totalMs: null,
      unavailableReason: "No runs."
    },
    agentTime: {
      availability: "unavailable",
      totalMs: null,
      includedRunCount: 0,
      missingRunCount: 0,
      reason: "No runs."
    }
  },
  usage: {
    taskTokens: { available: false, totalTokens: null, reason: "Unavailable." },
    taskCost: { available: false, totals: null, reason: "Unavailable." }
  }
};

function controller(patch: Partial<TaskWorkspaceController> = {}): TaskWorkspaceController {
  return {
    error: null,
    getRunScrollTop: () => 0,
    liveStatus: "idle",
    liveUnavailableReason: null,
    navigation: {
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      source: { view: "graph" }
    },
    onRunScrollTopChange: vi.fn(),
    recordError: null,
    refresh: vi.fn(),
    returnToCanvas: vi.fn(),
    runnerModel: null,
    selectRun: vi.fn(),
    selectedRecord: null,
    selectedRun: null,
    status: "ready",
    subscriptionError: null,
    workspace,
    ...patch
  };
}

describe("Task Workspace shell", () => {
  it("renders Task Overview as the main panel without a run composer", () => {
    const conversation = vi.fn((_props: TaskWorkspaceConversationSlotProps) => null);
    const composer = vi.fn(() => null);
    render(
      <TaskWorkspaceRoute
        controller={controller()}
        labels={labels}
        slots={{ composer, conversation }}
      />
    );

    expect(screen.getByTestId("task-workspace-overview-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("task-workspace-composer-slot")).not.toBeInTheDocument();
    expect(conversation).not.toHaveBeenCalled();
    expect(composer).not.toHaveBeenCalled();
  });

  it("keeps the page root fixed while each stable slot owns its scroll area", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    render(
      <TaskWorkspaceRoute
        controller={controller({ selectedRun: fixture.selectedRun, workspace: fixture.workspace })}
        labels={labels}
        slots={{
          timeline: () => <div>Timeline implementation slot</div>,
          conversation: () => <div>Conversation implementation slot</div>,
          inspector: () => <div>Inspector implementation slot</div>,
          composer: () => <div>Composer implementation slot</div>
        }}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(screen.getByTestId("task-workspace-shell")).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("task-workspace-timeline-slot")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("task-workspace-conversation-slot")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("task-workspace-inspector-slot")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("task-workspace-conversation-slot").parentElement).toHaveStyle({
      minWidth: `${taskWorkspaceConversationMinWidth}px`
    });
    expect(screen.getByTestId("task-workspace-timeline-slot")).toHaveStyle({
      maxWidth: `${taskWorkspacePanelMaxWidth}px`,
      minWidth: `${taskWorkspacePanelMinWidth}px`
    });
    expect(screen.getByTestId("task-workspace-inspector-slot")).toHaveStyle({
      maxWidth: `${taskWorkspacePanelMaxWidth}px`,
      minWidth: `${taskWorkspacePanelMinWidth}px`
    });
    expect(screen.getByText("Timeline implementation slot")).toBeInTheDocument();
    expect(screen.getByText("Conversation implementation slot")).toBeInTheDocument();
    expect(screen.getByText("Inspector implementation slot")).toBeInTheDocument();
    expect(screen.getByText("Composer implementation slot")).toBeInTheDocument();
  });

  it("keeps timeline and inspector collapse state inside the Task Workspace session", async () => {
    render(<TaskWorkspaceRoute controller={controller()} labels={labels} />);

    const timeline = screen.getByTestId("task-workspace-timeline-slot");
    const inspectorToggle = screen.getByRole("button", { name: "Inspector" });

    await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(timeline).toHaveStyle({ width: "0px" });
    expect(timeline).toHaveStyle({ minWidth: "0px" });
    expect(timeline).toHaveAttribute("aria-hidden", "true");
    expect(timeline).toHaveAttribute("inert");
    expect(timeline).toHaveClass("pointer-events-none", "opacity-0");
    expect(screen.queryByTestId("task-workspace-timeline-compact")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-workspace-inspector-slot")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-conversation-slot")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(timeline).toHaveStyle({ width: `${initialTimelineWidth}px` });
    expect(timeline).not.toHaveAttribute("inert");

    await userEvent.click(inspectorToggle);
    const inspector = screen.getByTestId("task-workspace-inspector-slot");
    expect(inspector).toHaveStyle({ width: `${initialInspectorWidth}px` });
    expect(inspector).not.toHaveAttribute("inert");

    await userEvent.click(inspectorToggle);
    expect(inspector).toHaveStyle({ width: "0px" });
    expect(inspector).toHaveAttribute("aria-hidden", "true");
    expect(inspector).toHaveAttribute("inert");
  });

  it("retains inspector content after its first open so the close transition can finish", async () => {
    render(
      <TaskWorkspaceRoute
        controller={controller()}
        labels={labels}
        slots={{
          inspector: ({ inspectorCollapsed }) =>
            inspectorCollapsed ? null : <button type="button">Inspector action</button>
        }}
      />
    );

    expect(screen.queryByRole("button", { name: "Inspector action" })).not.toBeInTheDocument();

    const inspectorToggle = screen.getByRole("button", { name: "Inspector" });
    await userEvent.click(inspectorToggle);
    expect(screen.getByRole("button", { name: "Inspector action" })).toBeInTheDocument();

    await userEvent.click(inspectorToggle);
    const inspector = screen.getByTestId("task-workspace-inspector-slot");
    expect(
      within(inspector).getByRole("button", { name: "Inspector action", hidden: true })
    ).toBeInTheDocument();
    expect(inspector).toHaveAttribute("inert");
  });

  it("keeps clamped panel widths session-local for later lane resize controls", () => {
    const { result, rerender } = renderHook(
      ({ sessionKey }) => useTaskWorkspaceLayout(sessionKey),
      { initialProps: { sessionKey: "task-1" } }
    );

    act(() => {
      result.current.setTimelineWidth(100);
      result.current.setInspectorWidth(900);
    });
    expect(result.current.timelineWidth).toBe(220);
    expect(result.current.inspectorWidth).toBe(520);

    rerender({ sessionKey: "task-2" });
    expect(result.current.timelineWidth).toBe(280);
    expect(result.current.inspectorWidth).toBe(320);
  });

  it("passes the authoritative controller and layout controls to each lane slot", () => {
    const fixture = taskWorkspaceInspectorFixture();
    const getRunScrollTop = vi.fn(() => savedScrollTop);
    const onRunScrollTopChange = vi.fn();
    const timeline = vi.fn((_props: TaskWorkspaceTimelineSlotProps) => null);
    const conversation = vi.fn((_props: TaskWorkspaceConversationSlotProps) => null);
    const inspector = vi.fn((_props: TaskWorkspaceInspectorSlotProps) => null);

    render(
      <TaskWorkspaceRoute
        controller={controller({
          getRunScrollTop,
          onRunScrollTopChange,
          selectedRun: fixture.selectedRun,
          workspace: fixture.workspace
        })}
        labels={labels}
        slots={{ conversation, inspector, timeline }}
      />
    );

    const timelineProps = timeline.mock.calls[0]?.[0];
    const conversationProps = conversation.mock.calls[0]?.[0];
    const inspectorProps = inspector.mock.calls[0]?.[0];
    expect(timelineProps).toMatchObject({
      getRunScrollTop,
      onRunScrollTopChange,
      timelineWidth: initialTimelineWidth
    });
    expect(conversationProps).toMatchObject({ getRunScrollTop, onRunScrollTopChange });
    expect(inspectorProps).toMatchObject({
      inspectorCollapsed: true,
      inspectorWidth: initialInspectorWidth
    });

    act(() => {
      timelineProps?.setTimelineWidth(resizedTimelineWidth);
      inspectorProps?.setInspectorWidth(resizedInspectorWidth);
      inspectorProps?.setInspectorCollapsed(false);
    });
    expect(screen.getByTestId("task-workspace-timeline-slot")).toHaveStyle({
      width: `${resizedTimelineWidth}px`
    });
    expect(screen.getByTestId("task-workspace-header")).toHaveStyle({
      gridTemplateColumns: `${resizedTimelineWidth}px minmax(0, 1fr)`
    });
    expect(screen.getByTestId("task-workspace-inspector-slot")).toHaveStyle({
      width: `${resizedInspectorWidth}px`
    });

    act(() => inspector.mock.calls.at(-1)?.[0].setInspectorCollapsed(true));
    expect(screen.getByTestId("task-workspace-inspector-slot")).toHaveStyle({ width: "0px" });
  });

  it("shows a selected record failure in the stable conversation slot", () => {
    const fixture = taskWorkspaceInspectorFixture();
    render(
      <TaskWorkspaceRoute
        controller={controller({
          error: "Selected run record does not match its Task Workspace navigation identity.",
          liveStatus: "error",
          recordError: "Selected run record does not match its Task Workspace navigation identity.",
          selectedRun: fixture.selectedRun,
          workspace: fixture.workspace
        })}
        labels={labels}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Selected run record does not match its Task Workspace navigation identity."
    );
    expect(
      within(screen.getByTestId("task-workspace-conversation-slot")).queryByText("No conversation")
    ).not.toBeInTheDocument();
  });

  it("keeps run configuration out of the compact topbar", () => {
    const fixture = taskWorkspaceInspectorFixture();
    render(
      <TaskWorkspaceRoute
        controller={controller({
          selectedRecord: fixture.selectedRecord,
          selectedRun: fixture.selectedRun,
          workspace: fixture.workspace
        })}
        labels={labels}
        slots={{
          headerAction: () => <button type="button">Repository action</button>
        }}
      />
    );

    expect(screen.getByText("Build the right inspector")).toBeInTheDocument();
    const titleBlock = screen.getByTestId("task-workspace-title-block");
    expect(titleBlock).toHaveTextContent("Build the right inspector");
    expect(titleBlock).not.toHaveTextContent("T-001");
    expect(titleBlock).not.toHaveTextContent("Implemented");
    expect(titleBlock).not.toHaveTextContent("RUN-001");
    expect(screen.queryByTestId("task-workspace-run-summary")).not.toBeInTheDocument();
    const header = screen.getByTestId("task-workspace-header");
    expect(header).not.toHaveClass("gap-2");
    expect(header).not.toHaveClass("border-b");
    expect(header).toHaveStyle({
      gridTemplateColumns: `${initialTimelineWidth}px minmax(0, 1fr)`
    });
    const headerMain = screen.getByTestId("task-workspace-header-main");
    expect(headerMain).toHaveClass("border-b", "border-border/80");
    expect(screen.getByTestId("task-workspace-timeline-slot")).toHaveClass(
      "border-r",
      "border-border/80"
    );
    const timelineToggle = within(header).getByRole("button", { name: "Timeline" });
    const backToCanvas = within(header).getByRole("button", { name: "Back to canvas" });
    expect(backToCanvas.nextElementSibling).toBe(timelineToggle);
    expect(titleBlock).toHaveClass("h-6", "pl-4");
    expect(titleBlock).not.toHaveClass("border-l");
    expect(backToCanvas.parentElement?.nextElementSibling).toBe(headerMain);
    expect(headerMain.firstElementChild).toBe(titleBlock);
    expect(backToCanvas.parentElement).toHaveClass("pl-[124px]", "justify-end");
    const headerAction = within(header).getByRole("button", { name: "Repository action" });
    const inspectorToggle = within(header).getByRole("button", { name: "Inspector" });
    expect(titleBlock.nextElementSibling).toContainElement(headerAction);
    expect(titleBlock.nextElementSibling?.nextElementSibling).toBe(inspectorToggle);
  });

  it("returns through the same history action for Cmd/Ctrl-[", () => {
    const returnToCanvas = vi.fn();
    render(<TaskWorkspaceRoute controller={controller({ returnToCanvas })} labels={labels} />);

    fireEvent.keyDown(globalThis, { key: "[", metaKey: true });
    expect(returnToCanvas).toHaveBeenCalledTimes(1);
  });

  it("preserves return chrome and the return shortcut when the workspace fails to load", async () => {
    const returnToCanvas = vi.fn();
    render(
      <TaskWorkspaceRoute
        controller={controller({
          error: "Workspace failed to load.",
          returnToCanvas,
          status: "error",
          workspace: null
        })}
        labels={labels}
      />
    );

    expect(screen.getByTestId("task-workspace-shell")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace failed to load.");
    await userEvent.click(screen.getByRole("button", { name: "Back to canvas" }));
    fireEvent.keyDown(globalThis, { ctrlKey: true, key: "[" });
    expect(returnToCanvas).toHaveBeenCalledTimes(2);
  });

  it("uses panel motion tokens and disables transitions for reduced motion", () => {
    render(<TaskWorkspaceRoute controller={controller()} labels={labels} />);

    expect(screen.getByTestId("task-workspace-timeline-slot")).toHaveClass(
      "transition-[width,opacity]",
      "duration-[var(--motion-duration-panel)]",
      "motion-reduce:transition-none"
    );
  });
});

/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskWorkspace } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TaskWorkspaceController,
  TaskWorkspaceLabels
} from "../renderer/task-workspace/contracts";
import { TaskWorkspaceRoute } from "../renderer/task-workspace/TaskWorkspaceRoute";
import { useTaskWorkspaceLayout } from "../renderer/task-workspace/useTaskWorkspaceLayout";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const labels: TaskWorkspaceLabels = {
  backToCanvas: "Back to canvas",
  composer: "Composer",
  conversation: "Conversation",
  inspector: "Inspector",
  loading: "Loading",
  liveUnavailable: "Live unavailable",
  noConversation: "No conversation",
  noInspector: "No inspector",
  noRuns: "No runs",
  noTask: "No task",
  timeline: "Timeline"
};

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
  it("keeps the page root fixed while each stable slot owns its scroll area", () => {
    render(
      <TaskWorkspaceRoute
        controller={controller()}
        labels={labels}
        slots={{
          timeline: () => <div>Timeline implementation slot</div>,
          conversation: () => <div>Conversation implementation slot</div>,
          inspector: () => <div>Inspector implementation slot</div>,
          composer: () => <div>Composer implementation slot</div>
        }}
      />
    );

    expect(screen.getByTestId("task-workspace-shell")).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("task-workspace-timeline-slot")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("task-workspace-conversation-slot")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("task-workspace-inspector-slot")).toHaveClass("overflow-y-auto");
    expect(screen.getByText("Timeline implementation slot")).toBeInTheDocument();
    expect(screen.getByText("Conversation implementation slot")).toBeInTheDocument();
    expect(screen.getByText("Inspector implementation slot")).toBeInTheDocument();
    expect(screen.getByText("Composer implementation slot")).toBeInTheDocument();
  });

  it("keeps timeline and inspector collapse state inside the Task Workspace session", async () => {
    render(<TaskWorkspaceRoute controller={controller()} labels={labels} />);

    await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
    await userEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(screen.queryByTestId("task-workspace-timeline-slot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-workspace-inspector-slot")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-conversation-slot")).toBeInTheDocument();
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

  it("shows a selected record failure in the stable conversation slot", () => {
    render(
      <TaskWorkspaceRoute
        controller={controller({
          error: "Selected run record does not match its Task Workspace navigation identity.",
          liveStatus: "error",
          recordError: "Selected run record does not match its Task Workspace navigation identity."
        })}
        labels={labels}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Selected run record does not match its Task Workspace navigation identity."
    );
    expect(
      within(screen.getByTestId("task-workspace-conversation-slot")).queryByText(
        "No conversation"
      )
    ).not.toBeInTheDocument();
  });
});

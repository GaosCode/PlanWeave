/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskWorkspace } from "@planweave-ai/runtime";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElementHeight } from "../renderer/hooks/useElementHeight";
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
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";
import { deferred } from "./helpers/desktopProjectFixtures";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";
import {
  reviewAnnotationFixture,
  timelineBlockFixture,
  timelineWorkspaceFixture
} from "./helpers/taskWorkspaceTimelineFixture";

afterEach(cleanupRendererTestEnvironment);
beforeEach(stubSelectLayoutApis);

const labels: TaskWorkspaceLabels = {
  acceptanceCriteria: "Acceptance criteria",
  activeRuns: (count) => `Active runs: ${count}`,
  agent: "Agent",
  annotationKinds: {
    feedback: "Feedback",
    feedback_run: "Feedback run",
    review_attempt: "Review attempt"
  },
  annotationResult: "Result",
  backToCanvas: "Back to canvas",
  blockExecutor: "Block executor",
  blocks: "Blocks",
  booleanFalse: "False",
  booleanTrue: "True",
  composer: "Composer",
  conversation: "Conversation",
  dependencies: "Dependencies",
  dependencyProgress: (completed, total, percent) => `${completed}/${total} (${percent}%)`,
  elapsed: "Elapsed",
  executorSaved: "Executor saved",
  executorSaving: "Saving executor",
  expandTimeline: "Expand timeline",
  feedbackStatus: {
    dismissed: "Dismissed",
    in_progress: "In progress",
    open: "Open",
    resolved: "Resolved"
  },
  formatDateTime: (value) => value,
  formatDuration: (milliseconds) => `${milliseconds / 1_000}s`,
  inspector: "Inspector",
  inheritTaskExecutor: "Inherit Task",
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
  promptLabels: {
    blockPrompt: "Block prompt",
    disabled: "Disabled",
    effectivePrompt: "Effective prompt",
    empty: "Empty",
    included: "Included",
    missing: "Missing",
    promptSources: "Prompt sources",
    savePrompt: "Save Prompt",
    saved: "Saved",
    saving: "Saving",
    taskPrompt: "Task prompt"
  },
  reasoning: "Reasoning",
  reviewVerdict: {
    needs_changes: "Needs changes",
    passed: "Passed"
  },
  runStatus: {
    active: "Running",
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    waiting: "Waiting"
  },
  status: "Status",
  taskExecutor: "Task executor",
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
    promptMarkdown: "# Build Task Workspace",
    promptMissing: false,
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
    executorOptions: ["manual", "codex", "claude-code", "pi"],
    getRunScrollTop: () => 0,
    hasMoreRuns: false,
    liveStatus: "idle",
    liveUnavailableReason: null,
    loadMoreRuns: vi.fn(async () => undefined),
    loadMoreRunsError: null,
    loadingMoreRuns: false,
    navigation: {
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      source: { view: "graph" }
    },
    onRunScrollTopChange: vi.fn(),
    packageExecutorNames: [],
    recordError: null,
    refresh: vi.fn(),
    returnToCanvas: vi.fn(),
    runnerModel: null,
    saveBlockExecutor: vi.fn(async () => undefined),
    saveBlockPrompt: vi.fn(async () => undefined),
    saveTaskExecutor: vi.fn(async () => undefined),
    saveTaskPrompt: vi.fn(async () => undefined),
    selectAnnotation: vi.fn(),
    selectRun: vi.fn(),
    selectedAnnotation: null,
    selectedRecord: null,
    selectedRecordId: null,
    selectedRun: null,
    status: "ready",
    subscriptionError: null,
    workspace,
    ...patch
  };
}

describe("Task Workspace shell", () => {
  it("measures a composer that mounts after the workspace shell", () => {
    const rect = {
      bottom: 96,
      height: 96,
      left: 0,
      right: 300,
      top: 0,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);

    function DelayedMeasurement({ children }: { children: ReactNode }) {
      const measured = useElementHeight<HTMLDivElement>();
      return (
        <div>
          <output data-testid="measured-height">{measured.height}</output>
          {children ? <div ref={measured.ref}>{children}</div> : null}
        </div>
      );
    }

    const { rerender } = render(<DelayedMeasurement>{null}</DelayedMeasurement>);
    expect(screen.getByTestId("measured-height")).toHaveTextContent("0");

    rerender(<DelayedMeasurement>Late composer</DelayedMeasurement>);

    expect(screen.getByTestId("measured-height")).toHaveTextContent("96");
  });

  it("uses a stable workspace-shaped skeleton while the initial data loads", () => {
    render(
      <TaskWorkspaceRoute
        controller={controller({ status: "loading", workspace: null })}
        labels={labels}
      />
    );

    const loadingState = screen.getByRole("status", { name: "Loading" });
    expect(loadingState).toHaveAttribute("aria-busy", "true");
    expect(loadingState).toHaveClass("motion-reduce:animate-none");
    expect(screen.getByRole("heading", { name: "Loading" })).toHaveClass("sr-only");
    expect(screen.getAllByText("Loading")).toHaveLength(1);
    expect(screen.getByTestId("task-workspace-loading-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-loading-main")).toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-loading-inspector")).toBeInTheDocument();
  });

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
    expect(screen.getByLabelText("Task prompt")).toHaveValue("# Build Task Workspace");
  });

  it("renders a native review result in the main panel without an ACP composer", () => {
    const annotation = {
      ...reviewAnnotationFixture("T-001#R-001"),
      content: [
        "[P1] The mutation coordinator still needs a serialized write path.",
        "",
        "P2 — Add a failure-path regression test for the staging cleanup.",
        "",
        "已运行：runtime typecheck and focused tests passed."
      ].join("\n")
    };
    const block = timelineBlockFixture({
      annotations: [annotation],
      blockId: "R-001",
      title: "Review project canvas mutations",
      type: "review"
    });
    const reviewWorkspace = timelineWorkspaceFixture([block]);
    const composer = vi.fn(() => null);
    const conversation = vi.fn((_props: TaskWorkspaceConversationSlotProps) => null);

    render(
      <TaskWorkspaceRoute
        controller={controller({
          selectedAnnotation: { annotation, block },
          workspace: reviewWorkspace
        })}
        labels={labels}
        slots={{ composer, conversation }}
      />
    );

    expect(screen.getByTestId("task-workspace-annotation-detail")).toHaveTextContent(
      "The mutation coordinator still needs a serialized write path."
    );
    expect(screen.getByTestId("task-workspace-annotation-detail")).toHaveTextContent(
      "runtime typecheck and focused tests passed."
    );
    expect(document.querySelector('[data-review-priority="P1"]')).toBeInTheDocument();
    expect(document.querySelector('[data-review-priority="P2"]')).toBeInTheDocument();
    expect(document.querySelector('[data-review-section="verification"]')).toBeInTheDocument();
    expect(screen.getByText("Review attempt")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.queryByTestId("task-workspace-overview-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-workspace-composer-slot")).not.toBeInTheDocument();
    expect(conversation).not.toHaveBeenCalled();
    expect(composer).not.toHaveBeenCalled();
  });

  it("does not fall back to Task Overview while a routed Feedback run is loading", () => {
    const conversation = vi.fn(() => <div role="status">Loading selected run</div>);
    render(
      <TaskWorkspaceRoute
        controller={controller({
          liveStatus: "loading",
          navigation: {
            projectRoot: "/projects/demo",
            canvasId: "canvas-main",
            taskId: "T-001",
            blockRef: "T-001#R-001",
            recordId: "FE-001::RUN-001",
            source: { view: "graph" }
          }
        })}
        labels={labels}
        slots={{ conversation }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading selected run");
    expect(screen.queryByTestId("task-workspace-overview-panel")).not.toBeInTheDocument();
    expect(conversation).toHaveBeenCalledOnce();
  });

  it("keeps a newly routed Feedback run out of Task Overview before loading state propagates", () => {
    const conversation = vi.fn((props: TaskWorkspaceConversationSlotProps) => (
      <div role="status">Conversation status: {props.liveStatus}</div>
    ));
    render(
      <TaskWorkspaceRoute
        controller={controller({
          liveStatus: "idle",
          navigation: {
            projectRoot: "/projects/demo",
            canvasId: "canvas-main",
            taskId: "T-001",
            blockRef: "T-001#R-001",
            recordId: "FE-001::RUN-001",
            source: { view: "graph" }
          }
        })}
        labels={labels}
        slots={{ conversation }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Conversation status: loading");
    expect(screen.queryByTestId("task-workspace-overview-panel")).not.toBeInTheDocument();
  });

  it("gives the Task Overview its own vertical scroll viewport", () => {
    render(<TaskWorkspaceRoute controller={controller()} labels={labels} />);

    expect(screen.getByTestId("task-workspace-overview-panel")).toHaveClass(
      "h-full",
      "overflow-y-auto",
      "[scrollbar-gutter:stable]"
    );
  });

  it("shows manual for a Task without an explicit executor and does not expose canvas inheritance", () => {
    render(<TaskWorkspaceRoute controller={controller()} labels={labels} />);

    const taskExecutor = screen.getByLabelText("Task executor");
    expect(taskExecutor).toHaveTextContent("manual");
    fireEvent.click(taskExecutor);
    expect(screen.getByRole("option", { name: "manual" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /inherit canvas default/i })
    ).not.toBeInTheDocument();
  });

  it("edits Task and Block executors from the overview while preserving current custom values", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    const saveTaskExecutor = vi.fn(async () => undefined);
    const saveBlockExecutor = vi.fn(async () => undefined);
    const block = { ...fixture.selectedRun.block, runs: [] };
    const executorWorkspace = {
      ...fixture.workspace,
      task: { ...fixture.workspace.task, executor: "legacy-agent" },
      blocks: [block],
      activeRecordIds: [],
      selectedRecordId: null
    };

    render(
      <TaskWorkspaceRoute
        controller={controller({
          executorOptions: ["manual", "codex", "claude-code", "pi"],
          packageExecutorNames: [],
          saveBlockExecutor,
          saveTaskExecutor,
          workspace: executorWorkspace
        })}
        labels={labels}
      />
    );

    fireEvent.click(screen.getByLabelText("Task executor"));
    expect(screen.getByRole("option", { name: "legacy-agent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "claude-code" }));
    expect(saveTaskExecutor).toHaveBeenCalledWith("claude-code");

    const blockExecutor = screen.getByLabelText("Block executor");
    const blockSummary = blockExecutor.closest("summary");
    if (!blockSummary) {
      throw new Error("Block executor must remain inside its Block summary row.");
    }
    expect(blockSummary).toHaveClass("grid", "grid-cols-[1rem_minmax(0,1fr)_12rem_5.5rem]");
    expect(within(blockSummary).getByText(block.status)).toHaveClass(
      "max-w-full",
      "justify-self-center",
      "truncate"
    );

    fireEvent.click(blockExecutor);
    fireEvent.click(screen.getByRole("option", { name: "Inherit Task" }));
    expect(saveBlockExecutor).toHaveBeenCalledWith(block.ref, null);
  });

  it("keeps a newly selected Task executor visible while its save is pending", async () => {
    const pendingSave = deferred<void>();
    const saveTaskExecutor = vi.fn(() => pendingSave.promise);
    render(<TaskWorkspaceRoute controller={controller({ saveTaskExecutor })} labels={labels} />);

    const taskExecutor = screen.getByLabelText("Task executor");
    fireEvent.click(taskExecutor);
    fireEvent.click(screen.getByRole("option", { name: "codex" }));

    expect(taskExecutor).toHaveTextContent("codex");
    expect(taskExecutor).toBeDisabled();

    pendingSave.resolve(undefined);
    await waitFor(() => expect(taskExecutor).not.toBeDisabled());
  });

  it("keeps executor edit failures visible beside the selector", async () => {
    const saveTaskExecutor = vi.fn(async () => {
      throw new Error("Executor profile is unavailable.");
    });
    render(<TaskWorkspaceRoute controller={controller({ saveTaskExecutor })} labels={labels} />);

    fireEvent.click(screen.getByLabelText("Task executor"));
    fireEvent.click(screen.getByRole("option", { name: "codex" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Executor profile is unavailable.")
    );
  });

  it("opens a directly targeted Block prompt while keeping Effective Prompt read-only", () => {
    const fixture = taskWorkspaceInspectorFixture();
    const blockWithoutRuns = {
      ...fixture.selectedRun.block,
      runs: [],
      status: "ready" as const
    };
    const blockWorkspace = {
      ...fixture.workspace,
      blocks: [blockWithoutRuns],
      activeRecordIds: [],
      selectedRecordId: null
    };

    render(
      <TaskWorkspaceRoute
        controller={controller({
          navigation: {
            projectRoot: "/projects/demo",
            canvasId: "canvas-main",
            taskId: "T-001",
            blockRef: blockWithoutRuns.ref,
            source: { view: "graph" }
          },
          workspace: blockWorkspace
        })}
        labels={labels}
      />
    );

    const blockPrompts = screen.getByTestId(`task-workspace-block-prompts:${blockWithoutRuns.ref}`);
    expect(blockPrompts.closest("details")).toHaveAttribute("open");
    const blockPrompt = within(blockPrompts).getByLabelText("Block prompt");
    const effectivePrompt = within(blockPrompts).getByLabelText("Effective prompt");
    expect(blockPrompt).toHaveValue(blockWithoutRuns.promptMarkdown);
    expect(effectivePrompt).toHaveTextContent("Rendered inspector prompt");
    expect(effectivePrompt.tagName).toBe("PRE");
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

    expect(screen.getByTestId("task-workspace-inspector-slot")).toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-shell")).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("task-workspace-timeline-slot")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("task-workspace-main")).toHaveClass("relative");
    expect(screen.getByTestId("task-workspace-conversation-slot")).toHaveClass("overflow-hidden");
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
    expect(screen.getByTestId("task-workspace-composer-slot")).toHaveClass(
      "absolute",
      "pointer-events-none"
    );
    expect(screen.getByTestId("task-workspace-composer-slot")).not.toHaveClass("bg-app-shell");
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
          selectedRecordId: fixture.selectedRun.item.run.record.recordId,
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
      selectedRecordId: fixture.selectedRun.item.run.record.recordId,
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
    const headerTimeline = screen.getByTestId("task-workspace-header-timeline");
    expect(headerTimeline).toHaveClass("h-full", "border-r", "border-b", "border-border/80");
    const headerMain = screen.getByTestId("task-workspace-header-main");
    expect(headerMain).toHaveClass("border-b", "border-border/80");
    expect(headerMain).not.toHaveClass("border-l");
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

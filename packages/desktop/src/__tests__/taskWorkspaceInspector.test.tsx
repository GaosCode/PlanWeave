/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskWorkspaceInspector,
  type TaskWorkspaceInspectorLabels
} from "../renderer/task-workspace/inspector/TaskWorkspaceInspector";
import {
  taskWorkspacePanelMaxWidth,
  taskWorkspacePanelMinWidth
} from "../renderer/task-workspace/useTaskWorkspaceLayout";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  taskWorkspaceInspectorFixture,
  taskWorkspaceUsageLabelsFixture
} from "./helpers/taskWorkspaceInspectorFixture";

afterEach(cleanupRendererTestEnvironment);

const labels: TaskWorkspaceInspectorLabels = {
  actualConfiguration: "Actual configuration",
  artifactKinds: {
    feedback: "Feedback",
    implementation: "Implementation",
    review: "Review"
  },
  artifacts: "Artifacts",
  block: "Block",
  closeInspector: "Close inspector",
  configurationUnavailable: "Actual configuration unavailable",
  currentMode: "Current mode",
  diagnostics: "Diagnostics",
  emptyDiagnostics: "No diagnostics",
  emptyEvents: "No events",
  eventKinds: {
    artifact: "Artifact",
    diagnostic: "Diagnostic",
    interaction: "Interaction",
    interaction_result: "Interaction result",
    lifecycle: "Lifecycle",
    message: "Message",
    output: "Output",
    plan_update: "Plan update",
    session_config_options_update: "Configuration options update",
    session_configuration_snapshot: "Configuration snapshot",
    session_mode_update: "Mode update",
    terminal: "Terminal",
    terminal_output: "Terminal output",
    tool_call: "Tool call",
    tool_update: "Tool update",
    usage_update: "Usage snapshot"
  },
  events: "Events",
  false: "False",
  fileChangesUnavailable: "Modified-file history is unavailable from the runtime record contract.",
  files: "Files",
  formatDateTime: (value) => value,
  historyUnavailable: "Selected record history unavailable",
  latestTaskArtifact: "Latest task artifact",
  metadataFile: "Metadata file",
  mode: "Mode",
  model: "Model",
  noArtifact: "No artifact",
  noSelection: "No selected run",
  observedAt: "Observed at",
  options: "Options",
  overview: "Inspector overview",
  permission: "Permission",
  promptFile: "Prompt file",
  protocolDetails: "Protocol details",
  reasoning: "Reasoning",
  reportFile: "Report file",
  resizeInspector: "Resize inspector",
  run: "Run",
  runArtifact: "Run artifact",
  runStatus: {
    completed: "Completed",
    failed: "Failed",
    recorded: "Recorded",
    running: "Running"
  },
  sequence: (sequence) => `#${sequence}`,
  session: "Session",
  showingLatest: (visible, total) => `Showing latest ${visible} of ${total}`,
  status: "Status",
  task: "Task",
  true: "True",
  unavailable: "Unavailable",
  usage: "Usage",
  usageLabels: taskWorkspaceUsageLabelsFixture,
  workingDirectory: "Working directory"
};

function renderInspector(overrides: Partial<React.ComponentProps<typeof TaskWorkspaceInspector>> = {}) {
  const fixture = taskWorkspaceInspectorFixture();
  const props: React.ComponentProps<typeof TaskWorkspaceInspector> = {
    inspectorCollapsed: false,
    inspectorWidth: 360,
    labels,
    selectedRecord: fixture.selectedRecord,
    selectedRun: fixture.selectedRun,
    setInspectorCollapsed: vi.fn(),
    setInspectorWidth: vi.fn(),
    workspace: fixture.workspace,
    ...overrides
  };
  return { ...render(<TaskWorkspaceInspector {...props} />), fixture, props };
}

describe("TaskWorkspaceInspector", () => {
  it("renders only typed record files, artifacts, and selected-run actual configuration", async () => {
    const user = userEvent.setup();
    renderInspector();

    expect(screen.getByText("Build the right inspector")).toBeInTheDocument();
    expect(screen.getByText("Implement inspector")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("high").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Modified-file history is unavailable from the runtime record contract.")).toBeInTheDocument();
    expect(screen.getByText("/projects/demo/prompts/run.md")).toBeInTheDocument();
    expect(screen.getAllByText("/projects/demo/results/implementation.md")).toHaveLength(2);
    expect(screen.getByText("implementation.md")).toBeInTheDocument();

    const protocolSummary = screen.getByText("Protocol details");
    expect(protocolSummary.closest("details")).not.toHaveAttribute("open");
    await user.click(protocolSummary);
    expect(protocolSummary.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("Model selection")).toBeInTheDocument();
    expect(screen.getByText("Reasoning level")).toBeInTheDocument();
    expect(screen.queryByText(/\{"/)).not.toBeInTheDocument();
  });

  it("mounts typed event and diagnostic history only when each disclosure opens", async () => {
    const user = userEvent.setup();
    renderInspector();

    expect(screen.queryByText("Lifecycle")).not.toBeInTheDocument();
    expect(screen.queryByText("Sequence 2 was missing.")).not.toBeInTheDocument();

    await user.click(screen.getByText("Events"));
    expect(screen.getByText("Lifecycle")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.queryByText("Runner started.")).not.toBeInTheDocument();
    expect(screen.queryByText("Sequence 2 was missing.")).not.toBeInTheDocument();

    await user.click(screen.getByText("Diagnostics"));
    expect(screen.getByText("sequence_gap")).toBeInTheDocument();
    expect(screen.getByText("Sequence 2 was missing.")).toBeInTheDocument();
  });

  it("uses the authoritative layout setters for close, pointer resize, and keyboard resize", async () => {
    const setInspectorCollapsed = vi.fn();
    const setInspectorWidth = vi.fn();
    const user = userEvent.setup();
    renderInspector({ setInspectorCollapsed, setInspectorWidth });

    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    expect(separator).toHaveAttribute("aria-valuemin", String(taskWorkspacePanelMinWidth));
    expect(separator).toHaveAttribute("aria-valuemax", String(taskWorkspacePanelMaxWidth));
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    fireEvent.pointerDown(separator, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 140 });
    expect(setInspectorWidth).toHaveBeenCalledWith(320);

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(setInspectorWidth).toHaveBeenCalledWith(376);
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(setInspectorWidth).toHaveBeenCalledWith(344);

    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(setInspectorCollapsed).toHaveBeenCalledWith(true);
  });

  it("keeps authoritative zero usage and durations visible in the Inspector overview", () => {
    const zero = taskWorkspaceInspectorFixture({ zeroMetrics: true });
    renderInspector({
      selectedRecord: zero.selectedRecord,
      selectedRun: zero.selectedRun,
      workspace: zero.workspace
    });

    expect(screen.getByText("0 / 25,800 tokens")).toBeInTheDocument();
    expect(screen.getByText("USD 0.00")).toBeInTheDocument();
    expect(screen.getByText("0% used")).toBeInTheDocument();
    expect(screen.getAllByText("0s")).toHaveLength(3);
  });

  it("does not use a stale record or render while the shell marks the inspector collapsed", () => {
    const fixture = taskWorkspaceInspectorFixture();
    const staleRecord = { ...fixture.selectedRecord, recordId: "T-001#B-001::RUN-STALE" };
    const { rerender } = render(
      <TaskWorkspaceInspector
        inspectorCollapsed={false}
        inspectorWidth={360}
        labels={labels}
        selectedRecord={staleRecord}
        selectedRun={fixture.selectedRun}
        setInspectorCollapsed={vi.fn()}
        setInspectorWidth={vi.fn()}
        workspace={fixture.workspace}
      />
    );
    expect(screen.getByText("Selected record history unavailable")).toBeInTheDocument();
    expect(screen.queryByText("/projects/demo/prompts/run.md")).not.toBeInTheDocument();

    rerender(
      <TaskWorkspaceInspector
        inspectorCollapsed
        inspectorWidth={360}
        labels={labels}
        selectedRecord={fixture.selectedRecord}
        selectedRun={fixture.selectedRun}
        setInspectorCollapsed={vi.fn()}
        setInspectorWidth={vi.fn()}
        workspace={fixture.workspace}
      />
    );
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

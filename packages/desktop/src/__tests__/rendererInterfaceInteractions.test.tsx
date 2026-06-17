/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopAutoRunState, DesktopCanvasGraphViewModel, DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComponentPalette } from "../renderer/palette/ComponentPalette";
import { FloatingAutoRunControl } from "../renderer/run/FloatingAutoRunControl";
import { ProjectSidebar } from "../renderer/sidebar/ProjectSidebar";
import { createTranslator } from "../renderer/i18n";
import type { DesktopUiSettings } from "../renderer/types";
import { CanvasMapInspector } from "../renderer/views/CanvasMapInspector";

const t = createTranslator("en");

const settings: DesktopUiSettings = {
  runtimePath: "/tmp/project",
  defaultExecutor: "",
  appearance: "system",
  language: "en",
  readNotificationIds: [],
  notifications: {
    autoRunFailure: true,
    graphExceptions: true,
    dirtyPrompts: true,
    fileSyncConflict: true
  },
  palette: {
    visible: {
      task: true,
      implementation: true,
      review: true
    },
    defaultBlockSet: ["implementation", "review"],
    dragHint: true
  },
  review: {
    autoAppendReviewBlock: true,
    feedbackLoop: true,
    pipelineEnabled: true,
    strictReview: true
  },
  execution: {
    tmuxMonitoring: true
  },
  agents: {
    codex: {
      enabled: false,
      fullAccess: false
    },
    "claude-code": {
      enabled: false,
      fullAccess: false
    },
    opencode: {
      enabled: false,
      fullAccess: false
    },
    pi: {
      enabled: false,
      fullAccess: false
    }
  }
};

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      taskCount: 2,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    }
  ]
};

const graph: DesktopGraphViewModel = {
  projectId: project.projectId,
  projectTitle: project.name,
  executorOptions: ["codex"],
  tasks: [
    {
      taskId: "T-001",
      title: "Implement runtime bridge",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Bridge",
      promptPreview: "Bridge",
      blocks: [],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    },
    {
      taskId: "T-002",
      title: "Write interface tests",
      status: "blocked",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Tests",
      promptPreview: "Tests",
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

function createAutoRunState(patch: Partial<Omit<DesktopAutoRunState, "explanation">> & { explanation?: DesktopAutoRunState["explanation"] } = {}): DesktopAutoRunState {
  const state = {
    runId: "RUN-001",
    projectRoot: "/tmp/project",
    canvasId: "canvas-main",
    phase: "running",
    scope: { kind: "project" },
    currentRef: null,
    currentExecutor: null,
    stepCount: 0,
    stepLimit: 20,
    elapsedMs: 0,
    latestRecordId: null,
    latestRecordPath: null,
    latestOutputSummary: null,
    statePath: "/tmp/state.json",
    eventLogPath: "/tmp/events.ndjson",
    options: { tmuxEnabled: true },
    error: null,
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    ...patch
  } satisfies Omit<DesktopAutoRunState, "explanation">;
  return {
    ...state,
    explanation: patch.explanation ?? {
      phase: state.phase,
      currentRef: state.currentRef,
      currentExecutor: state.currentExecutor,
      latestRecordId: state.latestRecordId,
      latestRecordPath: state.latestRecordPath,
      latestOutputSummary: state.latestOutputSummary,
      error: state.error,
      nextAction: {
        kind: "wait",
        message: "Wait for the current Auto Run step to finish.",
        command: null,
        targetPath: null,
        ref: state.currentRef
      }
    }
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop renderer interface interactions", () => {
  it("routes sidebar navigation, canvas selection, and task selection through public callbacks", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const setActiveView = vi.fn();
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const handleTaskPanelSelect = vi.fn();

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
        handleTaskPanelSelect={handleTaskPanelSelect}
        loadProject={loadProject}
        notificationItems={[{ id: "dirty", title: "Dirty", detail: "T-001", tone: "secondary", read: false }]}
        onToggleSidebar={vi.fn()}
        onTogglePinnedProject={vi.fn()}
        pinnedProjectIds={new Set()}
        projects={[project]}
        resetLayout={vi.fn().mockResolvedValue(undefined)}
        selectedProject={project}
        selectedCanvasId="canvas-main"
        selectedTaskPanelId={null}
        setActiveView={setActiveView}
        t={t}
      />
    );

    await userEvent.click(screen.getByTestId("sidebar-todo"));
    await userEvent.click(screen.getByTestId("sidebar-canvas-map"));
    await userEvent.click(screen.getByTestId("sidebar-settings"));
    await userEvent.click(screen.getByRole("button", { name: "Demo" }));
    await userEvent.click(screen.getByRole("button", { name: /Main canvas\s*2/ }));
    await userEvent.click(screen.getByRole("button", { name: /Write interface tests\s*T-002/ }));

    expect(setActiveView).toHaveBeenCalledWith("todo");
    expect(setActiveView).toHaveBeenCalledWith("canvas-map");
    expect(setActiveView).toHaveBeenCalledWith("settings");
    expect(loadProject).toHaveBeenCalledWith(project);
    expect(loadProject).toHaveBeenCalledWith(project, "canvas-main");
    expect(handleTaskPanelSelect).toHaveBeenCalledWith(null);
    expect(handleTaskPanelSelect).toHaveBeenCalledWith("T-002");
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("keeps project collapse control visible and opens project selection in the canvas map view", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const setActiveView = vi.fn();
    const loadProject = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectSidebar
        activeView="canvas-map"
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
        loadProject={loadProject}
        notificationItems={[]}
        onToggleSidebar={vi.fn()}
        onTogglePinnedProject={vi.fn()}
        pinnedProjectIds={new Set()}
        projects={[project]}
        resetLayout={vi.fn().mockResolvedValue(undefined)}
        selectedProject={project}
        selectedCanvasId="canvas-main"
        selectedTaskPanelId={null}
        setActiveView={setActiveView}
        t={t}
      />
    );

    expect(screen.getByRole("button", { name: "Collapse project" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Demo" }));

    expect(loadProject).toHaveBeenCalledWith(project);
    expect(setActiveView).toHaveBeenCalledWith("canvas-map");
    expect(screen.getByRole("button", { name: "Collapse project" })).toBeVisible();
  });

  it("marks diagnostic canvases as errors instead of showing a normal task count", () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const invalidProject: DesktopProjectSummary = {
      ...project,
      taskCanvases: [
        {
          canvasId: "broken-canvas",
          name: "Broken canvas",
          taskCount: 2,
          missingPromptCount: 0,
          diagnostics: [
            {
              code: "project_graph_schema",
              message: "Expected array, received string",
              path: "project-graph.json:canvases"
            }
          ],
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z"
        }
      ]
    };

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={invalidProject.projectId}
        graph={null}
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
        projects={[invalidProject]}
        resetLayout={vi.fn().mockResolvedValue(undefined)}
        selectedProject={invalidProject}
        selectedCanvasId="broken-canvas"
        selectedTaskPanelId={null}
        setActiveView={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByRole("button", { name: /Broken canvas Error: Expected array/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Broken canvas\s*2/ })).not.toBeInTheDocument();
  });

  it("closes the canvas map inspector from the selected canvas detail", async () => {
    const onClose = vi.fn();
    const canvasGraph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Demo",
      canvases: [
        {
          canvasId: "canvas-main",
          title: "Main canvas",
          packageDir: "canvases/main/package",
          diagnostics: []
        }
      ],
      edges: [],
      crossTaskEdges: [],
      diagnostics: []
    };

    render(
      <CanvasMapInspector
        graph={canvasGraph}
        onClose={onClose}
        onCanvasOpen={vi.fn()}
        selectedCanvas={canvasGraph.canvases[0] ?? null}
        selectedCanvasId="canvas-main"
        selectedEdge={null}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("reports component palette click and drag intents through public callbacks", async () => {
    const addPaletteComponent = vi.fn().mockResolvedValue(undefined);
    const handlePaletteDragStart = vi.fn();

    render(<ComponentPalette addPaletteComponent={addPaletteComponent} handlePaletteDragStart={handlePaletteDragStart} settings={settings} t={t} />);

    await userEvent.click(screen.getByRole("button", { name: "Task Node" }));
    fireEvent.dragStart(screen.getByRole("button", { name: "Review Block" }));

    expect(screen.getByText("Nodes")).toBeInTheDocument();
    expect(screen.getByText("Blocks")).toBeInTheDocument();
    expect(addPaletteComponent).toHaveBeenCalledWith("task");
    expect(handlePaletteDragStart).toHaveBeenCalledWith(expect.any(Object), "review");
  });

  it("shows Auto Run runtime state and dispatches scope, sync, run, and record actions", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: vi.fn(() => false) });
    Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const autoRunState = createAutoRunState({
      currentRef: "T-001#B-001",
      currentExecutor: "codex",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/tmp/result.json"
    });
    const handleAutoRunClick = vi.fn().mockResolvedValue(undefined);
    const handleRevealPathInFinder = vi.fn().mockResolvedValue(undefined);
    const refreshPackageFiles = vi.fn().mockResolvedValue(undefined);
    const setAutoRunScopeMode = vi.fn();
    const stopAutoRunClick = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <FloatingAutoRunControl
        autoRunScopeMode="project"
        autoRunState={autoRunState}
        dirtyPromptCount={2}
        handleAutoRunClick={handleAutoRunClick}
        handleRevealPathInFinder={handleRevealPathInFinder}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        refreshPackageFiles={refreshPackageFiles}
        selectedBlockPresent={true}
        selectedProject={project}
        selectedTaskPanelId="T-001"
        setAutoRunScopeMode={setAutoRunScopeMode}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={stopAutoRunClick}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-mini-panel")).toBeVisible();
    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-phase", "running");
    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-run-id", "RUN-001");
    expect(screen.getByText("Current block: T-001#B-001")).toBeInTheDocument();
    expect(screen.getByText("Agent: codex")).toBeInTheDocument();
    expect(screen.getByText("Next action: Wait for the current Auto Run step to finish.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync file changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Auto Run" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Stop" })[0]);
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-record-path", "/tmp/result.json");
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-run-id", "RUN-001");
    await userEvent.click(screen.getByTestId("auto-run-open-record"));

    expect(refreshPackageFiles).toHaveBeenCalledTimes(1);
    expect(handleAutoRunClick).toHaveBeenCalledTimes(1);
    expect(stopAutoRunClick).toHaveBeenCalledTimes(1);
    expect(handleRevealPathInFinder).toHaveBeenCalledWith("/tmp/result.json");

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Selected Task" }));
    expect(setAutoRunScopeMode).toHaveBeenCalledWith("selectedTask");

    rerender(
      <FloatingAutoRunControl
        autoRunScopeMode="project"
        autoRunState={createAutoRunState({
          runId: "RUN-FAILED",
          phase: "failed",
          currentRef: "T-001#B-001",
          currentExecutor: "codex",
          latestRecordId: "T-001#B-001::RUN-FAILED",
          latestRecordPath: "/tmp/failed-result.json",
          latestOutputSummary: "Executor failed",
          explanation: {
            phase: "failed",
            currentRef: "T-001#B-001",
            currentExecutor: "codex",
            latestRecordId: "T-001#B-001::RUN-FAILED",
            latestRecordPath: "/tmp/failed-result.json",
            latestOutputSummary: "Executor failed",
            error: "Executor exited with code 1.",
            nextAction: {
              kind: "inspect_record",
              message: "Open the latest record and fix the failure.",
              command: null,
              targetPath: "/tmp/failed-result.json",
              ref: "T-001#B-001"
            }
          },
          error: "Executor exited with code 1."
        })}
        dirtyPromptCount={0}
        handleAutoRunClick={handleAutoRunClick}
        handleRevealPathInFinder={handleRevealPathInFinder}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        refreshPackageFiles={refreshPackageFiles}
        selectedBlockPresent={true}
        selectedProject={project}
        selectedTaskPanelId="T-001"
        setAutoRunScopeMode={setAutoRunScopeMode}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={stopAutoRunClick}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-phase", "failed");
    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-run-id", "RUN-FAILED");
    expect(screen.getByTestId("auto-run-error")).toHaveTextContent("Executor exited with code 1.");
    expect(screen.getByText("Next action: Open the latest record and fix the failure.")).toBeInTheDocument();
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-record-path", "/tmp/failed-result.json");
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-run-id", "RUN-FAILED");

    await userEvent.click(screen.getByTestId("auto-run-open-record"));

    expect(handleRevealPathInFinder).toHaveBeenCalledWith("/tmp/failed-result.json");
  });

  it("keeps Auto Run visible but disabled when no project is open", () => {
    render(
      <FloatingAutoRunControl
        autoRunScopeMode="project"
        autoRunState={null}
        dirtyPromptCount={0}
        handleAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        miniRunPanelOpen={false}
        moveAutoRunControl={vi.fn()}
        refreshPackageFiles={vi.fn().mockResolvedValue(undefined)}
        selectedBlockPresent={false}
        selectedProject={null}
        selectedTaskPanelId={null}
        setAutoRunScopeMode={vi.fn()}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    expect(screen.getByText("Open a project before running Auto Run.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auto Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sync file changes" })).toBeDisabled();
  });
});

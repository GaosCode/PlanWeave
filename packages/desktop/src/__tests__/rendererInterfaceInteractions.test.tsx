/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DesktopCanvasGraphViewModel,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopTaskDraft
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { AppSuccessToast } from "../renderer/components/AppSuccessToast";
import { buildNotificationItems } from "../renderer/notifications";
import { ComponentPalette } from "../renderer/palette/ComponentPalette";
import { ProjectSidebar } from "../renderer/sidebar/ProjectSidebar";
import { createTranslator } from "../renderer/i18n";
import type { DesktopUiSettings } from "../renderer/types";
import { CanvasMapInspector } from "../renderer/views/CanvasMapInspector";
import { NewTaskView } from "../renderer/views/NewTaskView";

const t = createTranslator("en");

const settings: DesktopUiSettings = {
  runtimePath: "/tmp/project",
  defaultExecutor: "",
  appearance: "system",
  reducedMotion: false,
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
  windowMaterial: {
    enabled: false
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
  kind: "managed",
  rootPath: "/tmp/demo",
  sourceRoot: null,
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      packageDir: "canvases/main/package",
      executionPolicy: { parallelEnabled: false, maxConcurrent: 1 },
      taskCount: 2,
      missingPromptCount: 0,
      createdAt: "2026-05-23T00:00:00.000Z",
      diagnostics: [],
      updatedAt: "2026-05-23T00:00:00.000Z"
    }
  ]
};

const graph: DesktopGraphViewModel = {
  projectId: project.projectId,
  projectTitle: project.name,
  graphVersion: "pgv-test",
  packageFingerprint: "pkg-test",
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
      sharedResources: [],
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
      sharedResources: [],
      blocks: [],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  sharedResourceGroups: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop renderer interface interactions", () => {
  it("builds dirty prompt notifications from graph view model refs", () => {
    const notificationGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) =>
        task.taskId === "T-001"
          ? {
              ...task,
              blocks: [
                {
                  ref: "T-001#B-001",
                  blockId: "B-001",
                  type: "implementation",
                  title: "Implement",
                  status: "ready",
                  executor: null,
                  promptMissing: false,
                  exceptionReason: null,
                  dispatchable: true
                }
              ]
            }
          : task
      ),
      dirtyPromptRefs: ["T-001#B-001"]
    };

    expect(
      buildNotificationItems({
        autoRunState: null,
        fileSyncDiagnostics: [],
        graph: notificationGraph,
        lastFileChange: null,
        navigationContext: { projectRoot: project.rootPath, canvasId: "canvas-main" },
        promptConflicts: [],
        settings,
        t
      }).filter((item) => item.id.startsWith("dirty-"))
    ).toEqual([
      expect.objectContaining({
        id: "dirty-T-001#B-001",
        detail: "T-001#B-001",
        navigationIntent: {
          kind: "task-workspace",
          target: {
            projectRoot: project.rootPath,
            canvasId: "canvas-main",
            taskId: "T-001",
            blockRef: "T-001#B-001"
          }
        }
      })
    ]);
  });

  it("renders a visible success prompt after copy actions", () => {
    render(<AppSuccessToast message="Copied agent prompt" onDismiss={vi.fn()} t={t} />);

    expect(screen.getByRole("status")).toHaveTextContent("Copied agent prompt");
  });

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
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleRevealProject={vi.fn().mockResolvedValue(undefined)}
        handleTaskPanelSelect={handleTaskPanelSelect}
        loadProject={loadProject}
        notificationItems={[
          { id: "dirty", title: "Dirty", detail: "T-001", tone: "secondary", read: false }
        ]}
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

  it("opens an inline editor when renaming a task canvas", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const handleRenameTaskCanvas = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={project.projectId}
        graph={graph}
        handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={handleRenameTaskCanvas}
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
        selectedCanvasId="canvas-main"
        selectedTaskPanelId={null}
        setActiveView={vi.fn()}
        t={t}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Main canvas\s*2/ }));
    await userEvent.click(await screen.findByText("Rename task canvas"));
    const input = screen.getByRole("textbox", { name: "Task canvas name" });

    expect(input).toHaveValue("Main canvas");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed canvas{Enter}");

    expect(handleRenameTaskCanvas).toHaveBeenCalledWith(project, "canvas-main", "Renamed canvas");
  });

  it("copies an agent prompt from the task canvas context menu", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const handleCopyCanvasAgentPrompt = vi.fn();

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={project.projectId}
        graph={graph}
        handleCopyCanvasAgentPrompt={handleCopyCanvasAgentPrompt}
        handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
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
        selectedCanvasId="canvas-main"
        selectedTaskPanelId={null}
        setActiveView={vi.fn()}
        t={t}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Main canvas\s*2/ }));
    await userEvent.click(await screen.findByText("Copy agent prompt"));

    expect(handleCopyCanvasAgentPrompt).toHaveBeenCalledWith(project, project.taskCanvases[0]);
  });

  it("duplicates a task canvas from the context menu", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const handleDuplicateTaskCanvas = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={project.projectId}
        graph={graph}
        handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDuplicateTaskCanvas={handleDuplicateTaskCanvas}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
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
        selectedCanvasId="canvas-main"
        selectedTaskPanelId={null}
        setActiveView={vi.fn()}
        t={t}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Main canvas\s*2/ }));
    await userEvent.click(await screen.findByText("Duplicate task canvas"));

    expect(handleDuplicateTaskCanvas).toHaveBeenCalledWith(project, "canvas-main");
  });

  it("keeps the selected canvas collapse control available while a task is selected", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    render(
      <ProjectSidebar
        activeView="graph"
        collapsed={false}
        expandedProjectId={project.projectId}
        graph={graph}
        handleDeleteProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
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
        selectedCanvasId="canvas-main"
        selectedTaskPanelId="T-001"
        setActiveView={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByRole("button", { name: /Main canvas\s*2/ })).toHaveAttribute(
      "data-variant",
      "secondary"
    );
    expect(screen.getByTestId("canvas-toggle-canvas-main")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByRole("button", { name: /Implement runtime bridge\s*T-001/ })).toBeVisible();

    await userEvent.click(screen.getByTestId("canvas-toggle-canvas-main"));

    expect(screen.getByTestId("canvas-toggle-canvas-main")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(
      screen.queryByRole("button", { name: /Implement runtime bridge\s*T-001/ })
    ).not.toBeInTheDocument();
  });

  it("allows editing generated New Task drafts before confirmation", async () => {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const confirmTaskDraft = vi.fn().mockResolvedValue(undefined);

    function Harness() {
      const [taskDraft, setTaskDraft] = useState<DesktopTaskDraft | null>({
        mode: "document",
        targetTaskId: null,
        tasks: [
          {
            title: "Generated task",
            promptMarkdown: "# Generated prompt",
            acceptance: ["Generated acceptance"],
            blockTypes: ["implementation"]
          }
        ],
        blocks: []
      });
      const [newTaskText, setNewTaskText] = useState("Source document");
      return (
        <NewTaskView
          confirmTaskDraft={confirmTaskDraft}
          generateTaskDraft={vi.fn().mockResolvedValue(undefined)}
          graph={graph}
          handleOpenProject={vi.fn().mockResolvedValue(undefined)}
          newTaskMode="document"
          newTaskTargetId={null}
          newTaskText={newTaskText}
          selectedCanvasId="canvas-main"
          selectedProject={project}
          setActiveView={vi.fn()}
          setNewTaskMode={vi.fn()}
          setNewTaskTargetId={vi.fn()}
          setNewTaskText={setNewTaskText}
          setTaskDraft={setTaskDraft}
          t={t}
          taskDraft={taskDraft}
        />
      );
    }

    render(<Harness />);

    const titleInput = screen.getByDisplayValue("Generated task");
    fireEvent.change(titleInput, { target: { value: "Edited task" } });
    const acceptanceInput = screen.getByDisplayValue("Generated acceptance");
    fireEvent.change(acceptanceInput, { target: { value: "Edited acceptance" } });
    await userEvent.click(screen.getByRole("button", { name: "Review Block" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm write" }));

    expect(screen.getByDisplayValue("Edited task")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Edited acceptance")).toBeInTheDocument();
    expect(confirmTaskDraft).toHaveBeenCalledTimes(1);
  });

  it("writes edited New Task draft payload through the draft hook", async () => {
    const addTaskNode = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const bridge = createDesktopBridgeMock({ addTaskNode });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useTaskDraft } = await import("../renderer/hooks/useTaskDraft");
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const setActiveView = vi.fn();
    const setError = vi.fn();

    const { result } = renderHook(() =>
      useTaskDraft({
        loadProject,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView,
        setError
      })
    );

    act(() => {
      result.current.setTaskDraft({
        mode: "document",
        targetTaskId: null,
        tasks: [
          {
            title: "Edited task",
            promptMarkdown: "# Edited prompt",
            acceptance: ["Edited acceptance"],
            blockTypes: ["implementation", "review"]
          }
        ],
        blocks: []
      });
    });
    await act(async () => {
      await result.current.confirmTaskDraft();
    });

    expect(addTaskNode).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      {
        title: "Edited task",
        promptMarkdown: "# Edited prompt",
        acceptance: ["Edited acceptance"],
        blockTypes: ["implementation", "review"]
      }
    );
    expect(setError).not.toHaveBeenCalled();
    expect(loadProject).toHaveBeenCalledWith(project, "canvas-main");
    expect(setActiveView).toHaveBeenCalledWith("graph");
  });

  it("prevents New Task draft writes when acceptance is empty", async () => {
    const addTaskNode = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const bridge = createDesktopBridgeMock({ addTaskNode });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useTaskDraft } = await import("../renderer/hooks/useTaskDraft");
    const setError = vi.fn();

    const { result } = renderHook(() =>
      useTaskDraft({
        loadProject: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView: vi.fn(),
        setError
      })
    );

    act(() => {
      result.current.setTaskDraft({
        mode: "document",
        targetTaskId: null,
        tasks: [
          {
            title: "Edited task",
            promptMarkdown: "# Edited prompt",
            acceptance: [],
            blockTypes: ["implementation"]
          }
        ],
        blocks: []
      });
    });
    await act(async () => {
      await result.current.confirmTaskDraft();
    });

    expect(addTaskNode).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("Task 1 needs at least one acceptance item.");
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
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
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
              code: "prompt_duplicate_many",
              message: "Prompt text is duplicated across several blocks",
              path: "nodes.0.blocks",
              severity: "warning"
            },
            {
              code: "project_graph_schema",
              message: "Expected array, received string",
              path: "project-graph.json:canvases",
              severity: "error"
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
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
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

    expect(
      screen.getByRole("button", { name: /Broken canvas Error: Expected array/ })
    ).toBeVisible();
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
          executionPolicy: { parallelEnabled: false, maxConcurrent: 1 },
          diagnostics: []
        }
      ],
      edges: [],
      crossTaskEdges: [],
      diagnostics: [],
      health: {
        severity: "ok",
        canvases: [
          { canvasId: "canvas-main", severity: "ok", blockerCount: 0, diagnosticCount: 0 }
        ],
        edges: [],
        blockedBlocks: [],
        diagnostics: []
      }
    };

    render(
      <CanvasMapInspector
        graph={canvasGraph}
        onClose={onClose}
        onBlockOpen={vi.fn()}
        onCanvasOpen={vi.fn()}
        onExecutionPolicySave={vi.fn().mockResolvedValue(undefined)}
        onTaskOpen={vi.fn()}
        selectedCanvas={canvasGraph.canvases[0] ?? null}
        selectedCanvasId="canvas-main"
        selectedEdge={null}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("saves selected canvas execution policy changes", async () => {
    const onExecutionPolicySave = vi.fn().mockResolvedValue(undefined);
    const canvasGraph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Demo",
      canvases: [
        {
          canvasId: "canvas-main",
          title: "Main canvas",
          packageDir: "canvases/main/package",
          executionPolicy: { parallelEnabled: false, maxConcurrent: 1 },
          diagnostics: []
        }
      ],
      edges: [],
      crossTaskEdges: [],
      diagnostics: [],
      health: {
        severity: "ok",
        canvases: [
          { canvasId: "canvas-main", severity: "ok", blockerCount: 0, diagnosticCount: 0 }
        ],
        edges: [],
        blockedBlocks: [],
        diagnostics: []
      }
    };

    render(
      <CanvasMapInspector
        graph={canvasGraph}
        onClose={vi.fn()}
        onBlockOpen={vi.fn()}
        onCanvasOpen={vi.fn()}
        onExecutionPolicySave={onExecutionPolicySave}
        onTaskOpen={vi.fn()}
        selectedCanvas={canvasGraph.canvases[0] ?? null}
        selectedCanvasId="canvas-main"
        selectedEdge={null}
        t={t}
      />
    );

    expect(screen.getByText("Parallel claims are disabled.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await userEvent.click(screen.getByRole("switch", { name: "Parallel execution" }));
    await userEvent.clear(screen.getByRole("spinbutton", { name: "Max concurrent blocks" }));
    await userEvent.type(screen.getByRole("spinbutton", { name: "Max concurrent blocks" }), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(onExecutionPolicySave).toHaveBeenCalledWith("canvas-main", {
        parallelEnabled: true,
        maxConcurrent: 4
      })
    );
  });

  it("blocks invalid selected canvas execution policy input", async () => {
    const onExecutionPolicySave = vi.fn().mockResolvedValue(undefined);
    const canvasGraph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Demo",
      canvases: [
        {
          canvasId: "canvas-main",
          title: "Main canvas",
          packageDir: "canvases/main/package",
          executionPolicy: { parallelEnabled: true, maxConcurrent: 2 },
          diagnostics: []
        }
      ],
      edges: [],
      crossTaskEdges: [],
      diagnostics: [],
      health: {
        severity: "ok",
        canvases: [
          { canvasId: "canvas-main", severity: "ok", blockerCount: 0, diagnosticCount: 0 }
        ],
        edges: [],
        blockedBlocks: [],
        diagnostics: []
      }
    };

    render(
      <CanvasMapInspector
        graph={canvasGraph}
        onClose={vi.fn()}
        onBlockOpen={vi.fn()}
        onCanvasOpen={vi.fn()}
        onExecutionPolicySave={onExecutionPolicySave}
        onTaskOpen={vi.fn()}
        selectedCanvas={canvasGraph.canvases[0] ?? null}
        selectedCanvasId="canvas-main"
        selectedEdge={null}
        t={t}
      />
    );

    await userEvent.clear(screen.getByRole("spinbutton", { name: "Max concurrent blocks" }));
    await userEvent.type(screen.getByRole("spinbutton", { name: "Max concurrent blocks" }), "0");

    expect(screen.getByText("Enter a positive whole number, minimum 1.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(onExecutionPolicySave).not.toHaveBeenCalled();
  });

  it("renders project graph fallback diagnostics as warnings in the canvas map inspector", () => {
    const canvasGraph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Demo",
      canvases: [
        {
          canvasId: "canvas-main",
          title: "Main canvas",
          packageDir: "canvases/main/package",
          executionPolicy: { parallelEnabled: false, maxConcurrent: 1 },
          diagnostics: []
        }
      ],
      edges: [],
      crossTaskEdges: [],
      diagnostics: [],
      health: {
        severity: "warning",
        canvases: [
          { canvasId: "canvas-main", severity: "warning", blockerCount: 0, diagnosticCount: 1 }
        ],
        edges: [],
        blockedBlocks: [],
        diagnostics: [
          {
            code: "project_graph_missing_legacy_registry_used",
            message:
              "Project graph manifest is missing; derived canvas graph from legacy desktop canvas registry.",
            path: "project-graph.json"
          }
        ]
      }
    };

    render(
      <CanvasMapInspector
        graph={canvasGraph}
        onClose={vi.fn()}
        onBlockOpen={vi.fn()}
        onCanvasOpen={vi.fn()}
        onExecutionPolicySave={vi.fn().mockResolvedValue(undefined)}
        onTaskOpen={vi.fn()}
        selectedCanvas={canvasGraph.canvases[0] ?? null}
        selectedCanvasId="canvas-main"
        selectedEdge={null}
        t={t}
      />
    );

    const diagnostic = screen.getByText("project_graph_missing_legacy_registry_used").parentElement;

    expect(diagnostic).toHaveClass("border-state-warning/60");
    expect(diagnostic).toHaveClass("bg-state-warning-surface");
    expect(diagnostic).not.toHaveClass("border-destructive/30");
  });

  it("lists canvas map dependency blockers and dispatches jump actions", async () => {
    const onBlockOpen = vi.fn();
    const onCanvasOpen = vi.fn();
    const onTaskOpen = vi.fn();
    const canvasGraph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Demo",
      canvases: [
        {
          canvasId: "canvas-main",
          title: "Main canvas",
          packageDir: "canvases/main/package",
          executionPolicy: { parallelEnabled: true, maxConcurrent: 3 },
          diagnostics: []
        },
        {
          canvasId: "canvas-upstream",
          title: "Upstream canvas",
          packageDir: "canvases/upstream/package",
          executionPolicy: { parallelEnabled: false, maxConcurrent: 1 },
          diagnostics: []
        }
      ],
      edges: [{ from: "canvas-main", to: "canvas-upstream", type: "depends_on" }],
      crossTaskEdges: [],
      diagnostics: [],
      health: {
        severity: "warning",
        canvases: [
          { canvasId: "canvas-main", severity: "warning", blockerCount: 1, diagnosticCount: 0 },
          { canvasId: "canvas-upstream", severity: "ok", blockerCount: 0, diagnosticCount: 0 }
        ],
        edges: [
          {
            from: "canvas-main",
            to: "canvas-upstream",
            type: "depends_on",
            severity: "warning",
            blockerCount: 1,
            diagnosticCount: 0
          }
        ],
        blockedBlocks: [
          {
            blocked: {
              canvasId: "canvas-main",
              canvasTitle: "Main canvas",
              taskId: "T-002",
              taskTitle: "Downstream task",
              blockRef: "T-002#B-001",
              blockId: "B-001",
              blockTitle: "Implement downstream",
              status: "ready"
            },
            blockers: [
              {
                kind: "task",
                canvasId: "canvas-upstream",
                canvasTitle: "Upstream canvas",
                taskId: "T-001",
                taskTitle: "Upstream task",
                status: "ready"
              }
            ],
            reason: "Project graph blockers are not complete: canvas-upstream:T-001."
          }
        ],
        diagnostics: []
      }
    };

    render(
      <CanvasMapInspector
        graph={canvasGraph}
        onClose={vi.fn()}
        onBlockOpen={onBlockOpen}
        onCanvasOpen={onCanvasOpen}
        onExecutionPolicySave={vi.fn().mockResolvedValue(undefined)}
        onTaskOpen={onTaskOpen}
        selectedCanvas={canvasGraph.canvases[0] ?? null}
        selectedCanvasId="canvas-main"
        selectedEdge={null}
        t={t}
      />
    );

    expect(screen.getByText("Dependency blockers")).toBeVisible();
    expect(screen.getByText("canvas-main:T-002#B-001")).toBeVisible();

    await userEvent.click(screen.getAllByRole("button", { name: "Open task" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Open block" }));

    expect(onTaskOpen).toHaveBeenCalledWith("canvas-upstream", "T-001");
    expect(onBlockOpen).toHaveBeenCalledWith("canvas-main", "T-002#B-001");
    expect(onCanvasOpen).not.toHaveBeenCalled();
  });

  it("reports component palette click and drag intents through public callbacks", async () => {
    const addPaletteComponent = vi.fn().mockResolvedValue(undefined);
    const handlePaletteDragStart = vi.fn();

    render(
      <ComponentPalette
        addPaletteComponent={addPaletteComponent}
        handlePaletteDragStart={handlePaletteDragStart}
        settings={settings}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Task Node" }));
    fireEvent.dragStart(screen.getByRole("button", { name: "Review Block" }));

    expect(screen.getByText("Nodes")).toBeInTheDocument();
    expect(screen.getByText("Blocks")).toBeInTheDocument();
    expect(addPaletteComponent).toHaveBeenCalledWith("task");
    expect(handlePaletteDragStart).toHaveBeenCalledWith(expect.any(Object), "review");
  });
});

/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { DesktopGraphViewModel, DesktopLayout, DesktopProjectSummary, DesktopReviewPipeline } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { useVisibleGraphTasks } from "../renderer/hooks/useVisibleGraphTasks";
import type { DesktopUiSettings } from "../renderer/types";

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
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
      taskId: "T-ALPHA",
      title: "Alpha task",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Alpha",
      promptPreview: "Alpha",
      blocks: [],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    },
    {
      taskId: "T-BETA",
      title: "Beta task",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Beta",
      promptPreview: "Beta",
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

const layout: DesktopLayout = { nodes: [] };

const reviewPipeline: DesktopReviewPipeline = {
  taskId: "T-ALPHA",
  taskTitle: "Alpha task",
  packageDefaults: {
    maxFeedbackCycles: 1,
    completionPolicy: "strict"
  },
  steps: [
    {
      blockRef: "B-001",
      blockId: "B-001",
      title: "Review implementation",
      enabled: true,
      preset: "review",
      triggerCondition: "after_required_work_completed",
      inputContext: "Implementation",
      passCriteria: "Looks correct",
      feedbackFormat: "Notes",
      maxFeedbackCycles: 1,
      hook: null,
      promptMarkdown: "# Review"
    }
  ]
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop renderer hook interfaces", () => {
  it("filters visible graph tasks only by search query", () => {
    const { result, rerender } = renderHook(({ query }) => useVisibleGraphTasks(graph, query), {
      initialProps: { query: "" }
    });

    expect([...result.current.visibleTaskIds]).toEqual(["T-ALPHA", "T-BETA"]);

    rerender({ query: "alpha" });

    expect(result.current.visibleTasks?.map((task) => task.taskId)).toEqual(["T-ALPHA"]);
    expect([...result.current.visibleTaskIds]).toEqual(["T-ALPHA"]);
  });

  it("loads a project through bridge calls scoped by DesktopCanvasReference", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getDesktopLayout: vi.fn().mockResolvedValue(layout),
      getTodoGroups: vi.fn().mockResolvedValue(null),
      getStatistics: vi.fn().mockResolvedValue(null),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const updateSettings = vi.fn();
    renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        setSelectedTaskPanelId: vi.fn(),
        updateSettings
      })
    );

    await waitFor(() => expect(bridge.getGraphViewModel).toHaveBeenCalled());
    expect(bridge.getGraphViewModel).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(bridge.getDesktopLayout).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(bridge.getTodoGroups).toHaveBeenCalledWith(project.rootPath);
    expect(bridge.watchPackageFiles).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(updateSettings).toHaveBeenCalledWith({ runtimePath: project.workspaceRoot });
  });

  it("opens the active task canvas when project summaries include one", async () => {
    const activeProject: DesktopProjectSummary = {
      ...project,
      activeCanvasId: "canvas-active",
      taskCanvases: [
        {
          canvasId: "canvas-stale",
          name: "Stale imported canvas",
          taskCount: 0,
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z"
        },
        {
          canvasId: "canvas-active",
          name: "Active canvas",
          taskCount: 2,
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z"
        }
      ]
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([activeProject]),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getDesktopLayout: vi.fn().mockResolvedValue(layout),
      getTodoGroups: vi.fn().mockResolvedValue(null),
      getStatistics: vi.fn().mockResolvedValue(null),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        setSelectedTaskPanelId: vi.fn(),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(bridge.getGraphViewModel).toHaveBeenCalled());
    expect(bridge.getGraphViewModel).toHaveBeenCalledWith({ projectRoot: activeProject.rootPath, canvasId: "canvas-active" });
    expect(bridge.watchPackageFiles).toHaveBeenCalledWith({ projectRoot: activeProject.rootPath, canvasId: "canvas-active" });
  });

  it("keeps a requested project graph canvas even when it is absent from the project summary", async () => {
    vi.resetModules();
    const { resolveProjectCanvasId } = await import("../renderer/hooks/useDesktopProject");

    expect(resolveProjectCanvasId(project, "manual-canvas")).toBe("manual-canvas");
  });

  it("keeps project prompt state when the active canvas graph fails to load", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getGraphViewModel: vi.fn().mockRejectedValue(new Error("Invalid manifest schema")),
      readProjectPrompt: vi.fn().mockResolvedValue("# Project Prompt\n"),
      readProjectPromptPolicy: vi.fn().mockResolvedValue({ includeGlobalPrompt: true })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        setSelectedTaskPanelId: vi.fn(),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectPromptMarkdown).toBe("# Project Prompt\n"));

    expect(result.current.projectPromptPolicy).toEqual({ includeGlobalPrompt: true });
    expect(result.current.graph).toBeNull();
    expect(setError).toHaveBeenCalledWith("Invalid manifest schema");
  });

  it("keeps the selected canvas graph when layout loading fails", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getDesktopLayout: vi.fn().mockRejectedValue(new Error("layout.nodes.filter is not a function")),
      getTodoGroups: vi.fn().mockResolvedValue(null),
      getProjectExecutionPlan: vi.fn().mockResolvedValue(null),
      getStatistics: vi.fn().mockResolvedValue(null),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        setSelectedTaskPanelId: vi.fn(),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.graph?.tasks.map((task) => task.taskId)).toEqual(["T-ALPHA", "T-BETA"]));

    expect(result.current.layout).toBeNull();
    expect(setError).toHaveBeenCalledWith("layout.nodes.filter is not a function");
  });

  it("coordinates project/canvas switching through Desktop Project Session actions", async () => {
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummary: vi.fn().mockResolvedValue({
        runId: "RUN-001",
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        phase: "paused",
        scope: { kind: "project" },
        currentRef: null,
        currentExecutor: null,
        stepCount: 1,
        stepLimit: 20,
        elapsedMs: 10,
        latestRecordId: null,
        latestRecordPath: null,
        latestOutputSummary: null,
        statePath: "/tmp/project/.planweave/results/auto-runs/RUN-001/state.json",
        eventLogPath: "/tmp/project/.planweave/results/auto-runs/RUN-001/events.ndjson",
        options: { tmuxEnabled: true },
        error: null,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:01.000Z"
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProjectSession } = await import("../renderer/hooks/useDesktopProjectSession");

    const clearSelectedBlockRecords = vi.fn();
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const setAutoRunState = vi.fn();
    const setActiveView = vi.fn();
    const setBlockInspectorOpen = vi.fn();
    const setError = vi.fn();
    const setSelectedTaskPanelId = vi.fn();
    const setSelectedBlock = vi.fn();
    const setSelectedRunRecord = vi.fn();
    const requestTaskFocus = vi.fn();
    const selectBlock = vi.fn().mockResolvedValue(undefined);
    const projectState = {
      expandedProjectId: null,
      graph: null,
      handleOpenProject: vi.fn(),
      layout: null,
      loadProject,
      projects: [project],
      refreshGraph: vi.fn(),
      refreshProjectSummary: vi.fn().mockResolvedValue(project),
      removeProject: vi.fn(),
      selectedCanvasId: "canvas-main",
      selectedProject: project,
      setLayout: vi.fn(),
      statistics: null,
      todoGroups: null
    };

    const { result } = renderHook(() =>
      useDesktopProjectSession({
        clearSelectedBlockRecords,
        language: "zh-CN",
        projectState,
        requestTaskFocus,
        selectBlock,
        setActiveView,
        setAutoRunState,
        setBlockInspectorOpen,
        setError,
        setSelectedBlock,
        setSelectedTaskPanelId,
        setSelectedRunRecord
      })
    );

    await act(async () => {
      await result.current.openProject(project, "canvas-main");
    });

    expect(setSelectedBlock).toHaveBeenCalledWith(null);
    expect(setSelectedRunRecord).toHaveBeenCalledWith(null);
    expect(setBlockInspectorOpen).toHaveBeenCalledWith(false);
    expect(clearSelectedBlockRecords).toHaveBeenCalled();
    expect(loadProject).toHaveBeenCalledWith(project, "canvas-main");
    expect(bridge.getLatestAutoRunSummary).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(setAutoRunState).toHaveBeenCalledWith(expect.objectContaining({ runId: "RUN-001" }));
  });

  it("coordinates task and inspector opening through Desktop Project Session actions", async () => {
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummary: vi.fn().mockResolvedValue(null),
      openBlockInspectorWindow: vi.fn().mockResolvedValue(undefined),
      openTaskInspectorWindow: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProjectSession } = await import("../renderer/hooks/useDesktopProjectSession");

    const setActiveView = vi.fn();
    const setSelectedTaskPanelId = vi.fn();
    const requestTaskFocus = vi.fn();
    const selectBlock = vi.fn().mockResolvedValue(undefined);
    const projectState = {
      expandedProjectId: null,
      graph: null,
      handleOpenProject: vi.fn(),
      layout: null,
      loadProject: vi.fn(),
      projects: [project],
      refreshGraph: vi.fn(),
      refreshProjectSummary: vi.fn(),
      removeProject: vi.fn(),
      selectedCanvasId: "canvas-main",
      selectedProject: project,
      setLayout: vi.fn(),
      statistics: null,
      todoGroups: null
    };

    const { result } = renderHook(() =>
      useDesktopProjectSession({
        clearSelectedBlockRecords: vi.fn(),
        language: "zh-CN",
        projectState,
        requestTaskFocus,
        selectBlock,
        setActiveView,
        setAutoRunState: vi.fn(),
        setBlockInspectorOpen: vi.fn(),
        setError: vi.fn(),
        setSelectedBlock: vi.fn(),
        setSelectedTaskPanelId,
        setSelectedRunRecord: vi.fn()
      })
    );

    act(() => {
      result.current.selectTaskPanel("T-ALPHA");
    });

    expect(setSelectedTaskPanelId).toHaveBeenCalledWith("T-ALPHA");
    expect(setActiveView).toHaveBeenCalledWith("graph");
    expect(requestTaskFocus).toHaveBeenCalledWith("T-ALPHA");

    await act(async () => {
      await result.current.openTaskInspector("T-BETA", "canvas-alt");
    });

    expect(setSelectedTaskPanelId).toHaveBeenCalledWith("T-BETA");
    expect(requestTaskFocus).toHaveBeenCalledWith("T-BETA");
    expect(bridge.openTaskInspectorWindow).toHaveBeenCalledWith({
      taskId: "T-BETA",
      canvas: { projectRoot: project.rootPath, canvasId: "canvas-alt" },
      language: "zh-CN"
    });

    await act(async () => {
      await result.current.openBlockInspector("B-001");
    });

    expect(selectBlock).toHaveBeenCalledWith("B-001", "canvas-main");
    expect(bridge.openBlockInspectorWindow).toHaveBeenCalledWith({
      blockRef: "B-001",
      canvas: { projectRoot: project.rootPath, canvasId: "canvas-main" },
      language: "zh-CN"
    });
  });

  it("refreshes package files through the Desktop Project Session reload action", async () => {
    const bridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        diagnostics: [],
        dirtyPromptRefs: ["tasks/T-ALPHA/prompt.md"]
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const setDirtyPromptRefs = vi.fn();
    const setFileSyncDiagnostics = vi.fn();
    const { result } = renderHook(() =>
      usePackageFileSync({
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setDirtyPromptRefs,
        setError: vi.fn(),
        setFileSyncDiagnostics,
        setLastFileChange: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshPackageFiles();
    });

    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(reloadCurrentCanvas).toHaveBeenCalled();
    expect(setFileSyncDiagnostics).toHaveBeenCalledWith([]);
    expect(setDirtyPromptRefs).toHaveBeenLastCalledWith(["tasks/T-ALPHA/prompt.md"]);
  });

  it("reloads the current Desktop Project Session after saving a review pipeline", async () => {
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummary: vi.fn().mockResolvedValue(null),
      getReviewPipeline: vi.fn().mockResolvedValue(reviewPipeline),
      updateReviewPipeline: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
      import("../renderer/hooks/useReviewPipeline"),
      import("../renderer/i18n")
    ]);

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useReviewPipeline({
        graph,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        t: createTranslator("en")
      })
    );

    await waitFor(() => expect(result.current.reviewPipeline).toEqual(reviewPipeline));

    await act(async () => {
      await result.current.saveReviewPipeline();
    });

    expect(bridge.updateReviewPipeline).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      {
        packageDefaults: {
          maxFeedbackCycles: 1,
          completionPolicy: "strict"
        },
        steps: reviewPipeline.steps
      }
    );
    expect(reloadCurrentCanvas).toHaveBeenCalled();
  });

});

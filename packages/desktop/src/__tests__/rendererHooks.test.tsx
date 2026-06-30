/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSnapshot,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopStatistics,
  DesktopTodoGroups
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";
import { useVisibleGraphTasks } from "../renderer/hooks/useVisibleGraphTasks";
import type { AppFlowNode, DesktopUiSettings } from "../renderer/types";

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
  graphVersion: "pgv-test",
  packageFingerprint: "pkg-test",
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

const layout: DesktopLayout = {
  version: "desktop-layout/v1",
  projectId: project.projectId,
  nodes: [],
  updatedAt: "2026-05-23T00:00:00.000Z"
};

function projectSnapshot(overrides: Partial<DesktopProjectSnapshot> = {}): DesktopProjectSnapshot {
  return {
    projectPromptMarkdown: null,
    projectPromptPolicy: null,
    graph,
    layout,
    todoGroups: null,
    executionPlan: null,
    statistics: null,
    errors: [],
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop renderer hook interfaces", () => {
  it("returns detected agent tools without deriving project executor options", async () => {
    const bridge = createDesktopBridgeMock({
      detectAgentTools: vi.fn().mockResolvedValue([
        {
          kind: "claude-code",
          name: "Claude Code",
          command: "claude",
          versionArgs: ["--version"],
          execArgs: ["-p"],
          fullAccessArgs: ["--dangerously-skip-permissions", "-p"],
          installed: true,
          version: "claude 1.0.0",
          unavailableReason: null
        },
        {
          kind: "opencode",
          name: "OpenCode",
          command: "opencode",
          versionArgs: ["--version"],
          execArgs: ["run", "-"],
          fullAccessArgs: ["run", "--permission", "full-access", "-"],
          installed: true,
          version: "opencode 1.0.0",
          unavailableReason: null
        },
        {
          kind: "pi",
          name: "Pi",
          command: "pi",
          versionArgs: ["--version"],
          execArgs: ["-p"],
          fullAccessArgs: ["-p"],
          installed: false,
          version: null,
          unavailableReason: "not found"
        }
      ])
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDetectedAgents } = await import("../renderer/hooks/useDetectedAgents");

    const { result } = renderHook(() => useDetectedAgents());

    await waitFor(() => expect(result.current.agentDetections.map((agent) => agent.kind)).toEqual(["claude-code", "opencode", "pi"]));
    expect(result.current).not.toHaveProperty("executorOptions");
  });

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
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
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
        t: createTranslator("en"),
        updateSettings
      })
    );

    await waitFor(() => expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalled());
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(bridge.getGraphViewModel).not.toHaveBeenCalled();
    expect(bridge.getDesktopLayout).not.toHaveBeenCalled();
    expect(bridge.getTodoGroups).not.toHaveBeenCalled();
    expect(bridge.watchPackageFiles).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(updateSettings).toHaveBeenCalledWith({ runtimePath: project.workspaceRoot });
  });

  it("refreshes graph and layout together for same-canvas history updates", async () => {
    const nextGraph: DesktopGraphViewModel = {
      ...graph,
      graphVersion: "pgv-refreshed"
    };
    const nextLayout: DesktopLayout = {
      ...layout,
      nodes: [{ nodeId: "T-ALPHA", x: 320, y: 160 }]
    };
    const nextTodoGroups: DesktopTodoGroups = {
      planned: [],
      ready: [
        {
          blockId: "B-001",
          canvasId: "canvas-main",
          canvasName: "Main canvas",
          dependencyBlockers: [],
          locks: [],
          parallelSafe: true,
          ref: "T-ALPHA#B-001",
          reviewGate: null,
          status: "ready",
          taskId: "T-ALPHA",
          title: "Implement alpha"
        }
      ],
      in_progress: [],
      completed: [],
      needs_changes: [],
      blocked: [],
      diverged: [],
      implemented: []
    };
    const nextExecutionPlan: DesktopProjectExecutionPlan = {
      notes: ["Ready queue changed"],
      phases: [
        {
          blockedCount: 0,
          canvasId: "canvas-main",
          canvasName: "Main canvas",
          completedCount: 0,
          inProgressCount: 0,
          parallelReadyQueue: nextTodoGroups.ready,
          phaseIndex: 0,
          readyQueue: nextTodoGroups.ready,
          sequentialReadyQueue: [],
          taskCount: 1
        }
      ],
      readyQueue: nextTodoGroups.ready
    };
    const nextStatistics: DesktopStatistics = {
      averageImplementationTimeMs: null,
      blockTotal: 1,
      completedBlockCount: 0,
      estimatedRemainingBlocks: 1,
      feedbackEnvelopeCount: 0,
      implementedRatio: 0,
      implementedTaskCount: 0,
      reviewPassedCount: 0,
      reviewPassedRatio: 0,
      reworkCount: 0,
      taskThroughput: 0,
      taskTotal: 1
    };
    const getDesktopProjectSnapshot = vi.fn().mockResolvedValue(projectSnapshot());
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot,
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getTodoGroups: vi.fn().mockResolvedValue(null),
      getProjectExecutionPlan: vi.fn().mockResolvedValue(null),
      getStatistics: vi.fn().mockResolvedValue(null),
      getDesktopLayout: vi.fn().mockResolvedValue(nextLayout)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project, "canvas-main");
    });
    await waitFor(() => expect(result.current.graph?.tasks.map((task) => task.taskId)).toEqual(["T-ALPHA", "T-BETA"]));
    await waitFor(() => expect(result.current.layout?.nodes).toEqual([]));
    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    getDesktopProjectSnapshot.mockClear();
    getDesktopProjectSnapshot.mockResolvedValue(
      projectSnapshot({
        executionPlan: nextExecutionPlan,
        graph: nextGraph,
        layout: nextLayout,
        statistics: nextStatistics,
        todoGroups: nextTodoGroups
      })
    );

    await act(async () => {
      await result.current.refreshGraphAndLayout();
    });

    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(1);
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenLastCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(bridge.getGraphViewModel).not.toHaveBeenCalled();
    expect(bridge.getTodoGroups).not.toHaveBeenCalled();
    expect(bridge.getProjectExecutionPlan).not.toHaveBeenCalled();
    expect(bridge.getStatistics).not.toHaveBeenCalled();
    expect(bridge.getDesktopLayout).not.toHaveBeenCalled();
    expect(result.current.graph).toBe(nextGraph);
    expect(result.current.layout).toBe(nextLayout);
    expect(result.current.todoGroups).toBe(nextTodoGroups);
    expect(result.current.executionPlan).toBe(nextExecutionPlan);
    expect(result.current.statistics).toBe(nextStatistics);
  });

  it("refreshes derived project state without replacing layout or project prompt by default", async () => {
    const nextGraph: DesktopGraphViewModel = {
      ...graph,
      graphVersion: "pgv-derived-refresh"
    };
    const nextLayout: DesktopLayout = {
      ...layout,
      nodes: [{ nodeId: "T-BETA", x: 640, y: 220 }]
    };
    const getDesktopProjectSnapshot = vi.fn().mockResolvedValue(
      projectSnapshot({
        projectPromptMarkdown: "Initial prompt"
      })
    );
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot,
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getDesktopLayout: vi.fn().mockResolvedValue(nextLayout)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project, "canvas-main");
    });
    expect(result.current.layout).toBe(layout);
    expect(result.current.projectPromptMarkdown).toBe("Initial prompt");

    getDesktopProjectSnapshot.mockClear();
    getDesktopProjectSnapshot.mockResolvedValue(
      projectSnapshot({
        graph: nextGraph,
        layout: nextLayout,
        projectPromptMarkdown: "Changed prompt"
      })
    );

    await act(async () => {
      await result.current.refreshProjectDerivedState();
    });

    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(1);
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenLastCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(bridge.getGraphViewModel).not.toHaveBeenCalled();
    expect(bridge.getDesktopLayout).not.toHaveBeenCalled();
    expect(result.current.graph).toBe(nextGraph);
    expect(result.current.layout).toBe(layout);
    expect(result.current.projectPromptMarkdown).toBe("Initial prompt");
  });

  it("keeps startup in a loading state until the default project snapshot is ready", async () => {
    const pendingProjects = deferred<DesktopProjectSummary[]>();
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockReturnValue(pendingProjects.promise),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const updateSettings = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        t: createTranslator("en"),
        updateSettings
      })
    );

    expect(result.current.projectLoading).toBe(true);
    expect(result.current.graph).toBeNull();

    await act(async () => {
      pendingProjects.resolve([project]);
      await pendingProjects.promise;
    });

    await waitFor(() => expect(result.current.graph?.tasks.map((task) => task.taskId)).toEqual(["T-ALPHA", "T-BETA"]));
    expect(result.current.projectLoading).toBe(false);
  });

  it("keeps the current canvas graph visible while reloading the same canvas", async () => {
    const pendingReload = deferred<DesktopProjectSnapshot>();
    const nextGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => (task.taskId === "T-ALPHA" ? { ...task, promptPreview: "Updated alpha" } : task))
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValueOnce(projectSnapshot()).mockReturnValueOnce(pendingReload.promise),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const updateSettings = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        t: createTranslator("en"),
        updateSettings
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project, "canvas-main");
    });

    expect(result.current.graph).toBe(graph);

    let reloadPromise: Promise<void>;
    await act(async () => {
      reloadPromise = result.current.loadProject(project, "canvas-main");
      await Promise.resolve();
    });

    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.graph).toBe(graph);

    await act(async () => {
      pendingReload.resolve(projectSnapshot({ graph: nextGraph }));
      await reloadPromise;
    });

    expect(result.current.projectLoading).toBe(false);
    expect(result.current.graph).toBe(nextGraph);
  });

  it("reports a visible error when project folder selection is unavailable", async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await act(async () => {
      await result.current.handleOpenProject();
    });

    expect(setError).toHaveBeenCalledWith("Project folder selection is only available in the desktop app. Please open PlanWeave Desktop and choose a project root.");
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
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalled());
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({ projectRoot: activeProject.rootPath, canvasId: "canvas-active" });
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
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot({
        projectPromptMarkdown: "# Project Prompt\n",
        projectPromptPolicy: { includeGlobalPrompt: true },
        graph: null,
        layout: null,
        errors: ["graph: Invalid manifest schema"]
      }))
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectPromptMarkdown).toBe("# Project Prompt\n"));

    expect(result.current.projectPromptPolicy).toEqual({ includeGlobalPrompt: true });
    expect(result.current.graph).toBeNull();
    expect(setError).toHaveBeenCalledWith("graph: Invalid manifest schema");
  });

  it("keeps the selected canvas graph when layout loading fails", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot({
        layout: null,
        errors: ["layout: layout.nodes.filter is not a function"]
      })),
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
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.graph?.tasks.map((task) => task.taskId)).toEqual(["T-ALPHA", "T-BETA"]));

    expect(result.current.layout).toBeNull();
    expect(setError).toHaveBeenCalledWith("layout: layout.nodes.filter is not a function");
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
        explanation: {
          phase: "paused",
          currentRef: null,
          currentExecutor: null,
          latestRecordId: null,
          latestRecordPath: null,
          latestOutputSummary: null,
          error: null,
          nextAction: {
            kind: "resume",
            message: "Resume Auto Run or inspect the latest record before continuing.",
            command: null,
            targetPath: null,
            ref: null
          }
        },
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
    const setActiveView = vi.fn();
    const setBlockInspectorOpen = vi.fn();
    const setError = vi.fn();
    const setSelectedBlock = vi.fn();
    const setSelectedRunRecord = vi.fn();
    const selectBlock = vi.fn().mockResolvedValue(undefined);
    const projectState = {
      expandedProjectId: null,
      graph: null,
      handleOpenProject: vi.fn(),
      layout: null,
      loadProject,
      projectLoading: false,
      projects: [project],
      refreshGraph: vi.fn(),
      refreshGraphAndLayout: vi.fn(),
      refreshProjectDerivedState: vi.fn(),
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
        selectBlock,
        setActiveView,
        setBlockInspectorOpen,
        setError,
        setSelectedBlock,
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
    expect(result.current.autoRunState).toEqual(expect.objectContaining({ runId: "RUN-001" }));
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
    const selectBlock = vi.fn().mockResolvedValue({ taskId: "T-ALPHA" });
    const clearSelectedBlockRecords = vi.fn();
    const setBlockInspectorOpen = vi.fn();
    const setError = vi.fn();
    const setSelectedBlock = vi.fn();
    const setSelectedRunRecord = vi.fn();
    const projectState = {
      expandedProjectId: null,
      graph: null,
      handleOpenProject: vi.fn(),
      layout: null,
      loadProject: vi.fn(),
      projectLoading: false,
      projects: [project],
      refreshGraph: vi.fn(),
      refreshGraphAndLayout: vi.fn(),
      refreshProjectDerivedState: vi.fn(),
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
        clearSelectedBlockRecords,
        language: "zh-CN",
        projectState,
        selectBlock,
        setActiveView,
        setBlockInspectorOpen,
        setError,
        setSelectedBlock,
        setSelectedRunRecord
      })
    );

    act(() => {
      result.current.selectTaskPanel("T-ALPHA");
    });

    await waitFor(() => expect(result.current.selectedTaskPanelId).toBe("T-ALPHA"));
    expect(result.current.taskFocusRequest).toEqual({ taskId: "T-ALPHA", version: 1 });
    expect(setActiveView).toHaveBeenCalledWith("graph");

    await act(async () => {
      await result.current.openTaskInspector("T-BETA", "canvas-alt");
    });

    expect(result.current.selectedTaskPanelId).toBe("T-BETA");
    expect(result.current.taskFocusRequest).toEqual({ taskId: "T-BETA", version: 2 });
    expect(bridge.openTaskInspectorWindow).toHaveBeenCalledWith({
      taskId: "T-BETA",
      canvas: { projectRoot: project.rootPath, canvasId: "canvas-alt" },
      language: "zh-CN"
    });

    await act(async () => {
      await result.current.openBlockInspector("B-001");
    });

    expect(selectBlock).toHaveBeenCalledWith("B-001", "canvas-main");
    expect(result.current.selectedTaskPanelId).toBe("T-ALPHA");
    expect(bridge.openBlockInspectorWindow).toHaveBeenCalledWith({
      blockRef: "B-001",
      canvas: { projectRoot: project.rootPath, canvasId: "canvas-main" },
      language: "zh-CN"
    });
  });

  it("refreshes graph data without reloading the canvas for prompt-only package changes", async () => {
    const bridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: false,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [],
        dirtyPromptRefs: ["tasks/T-ALPHA/prompt.md"]
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setFileSyncDiagnostics = vi.fn();
    const { result } = renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics,
        setLastFileChange: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshPackageFiles();
    });

    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(reloadCurrentCanvas).not.toHaveBeenCalled();
    expect(setFileSyncDiagnostics).toHaveBeenCalledWith([]);
  });

  it("refreshes graph data when package sync reports dirty refs with an index failure", async () => {
    const bridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: false,
        fullRefresh: false,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [{ code: "plangraph_index_refresh_failed", message: "SQLite index refresh failed.", path: "cache/plangraph.sqlite" }],
        dirtyPromptRefs: ["T-ALPHA#B-001"]
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    const setFileSyncDiagnostics = vi.fn();
    const { result } = renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError,
        setFileSyncDiagnostics,
        setLastFileChange: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshPackageFiles();
    });

    expect(setFileSyncDiagnostics).toHaveBeenCalledWith(["SQLite index refresh failed."]);
    expect(setError).toHaveBeenCalledWith("SQLite index refresh failed.");
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(reloadCurrentCanvas).not.toHaveBeenCalled();
  });

  it("passes watcher changed paths to package file refresh", async () => {
    let packageFileChanged: ((event: { projectRoot: string; canvasId?: string | null; paths: string[]; triggeredAt: string }) => void) | null = null;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-23T00:00:02.500Z"));
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: false,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [],
        dirtyPromptRefs: ["T-ALPHA#B-001"],
        refreshedPromptCount: 1,
        refreshConcurrency: 4,
        refreshStats: {
          requested: 1,
          refreshed: 1,
          concurrency: 4,
          elapsedMs: 8,
          changedPathCount: 1,
          refreshedRefs: 1,
          mode: "incremental"
        }
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setFileSyncResult = vi.fn();
    const setLastFileChange = vi.fn();
    renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setFileSyncResult,
        setLastFileChange
      })
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    const event = {
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      paths: ["package/nodes/T-ALPHA/blocks/B-001.prompt.md"],
      changedPathCount: 1,
      backendKind: "native",
      triggeredAt: "2026-06-23T00:00:00.000Z"
    };
    act(() => {
      packageFileChanged?.(event);
    });

    await waitFor(() =>
      expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith(
        { projectRoot: project.rootPath, canvasId: "canvas-main" },
        { changedPaths: event.paths }
      )
    );
    expect(setLastFileChange).toHaveBeenCalledWith(event);
    await waitFor(() =>
      expect(setFileSyncResult).toHaveBeenCalledWith(
        expect.objectContaining({
          watcherBackendKind: "native",
          watcherChangedPathCount: 1,
          watcherRefreshElapsedMs: 2500,
          refreshStats: expect.objectContaining({
            changedPathCount: 1,
            refreshedRefs: 1,
            mode: "incremental"
          })
        })
      )
    );
    await waitFor(() => expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1));
  });

  it("reloads the current canvas for project prompt watcher changes", async () => {
    let packageFileChanged: ((event: { projectRoot: string; canvasId?: string | null; paths: string[]; triggeredAt: string }) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: false,
        primed: false,
        affectedTasks: [],
        diagnostics: [{ code: "package_change_non_package_prompt", message: "Project prompt changed.", path: "policy/project-prompt.md" }],
        dirtyPromptRefs: []
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setLastFileChange: vi.fn()
      })
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    const event = {
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      paths: ["policy/project-prompt.md"],
      triggeredAt: "2026-06-23T00:00:00.000Z"
    };
    act(() => {
      packageFileChanged?.(event);
    });

    await waitFor(() => expect(reloadCurrentCanvas).toHaveBeenCalledTimes(1));
    expect(refreshProjectDerivedState).not.toHaveBeenCalled();
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { changedPaths: event.paths }
    );
  });

  it("uses the latest graphVersion when deleting dependency edges after a graph refresh", async () => {
    const bridge = createDesktopBridgeMock({
      removeDependencyEdge: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const visibleNodes = [
      { id: "T-ALPHA", position: { x: 120, y: 80 } },
      { id: "T-BETA", position: { x: 580, y: 80 } }
    ] as AppFlowNode[];
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const baseArgs = {
      flowInstance: null,
      layout: null,
      loadProject: vi.fn().mockResolvedValue(undefined),
      nodes: visibleNodes,
      refreshProjectDerivedState,
      selectedCanvasId: "canvas-main",
      selectedBlock: null,
      selectedProject: project,
      selectedTaskPanelId: null,
      setError: vi.fn(),
      setLayout: vi.fn(),
      setNewTaskTargetId: vi.fn(),
      selectTaskPanel: vi.fn(),
      settings: {
        defaultExecutor: "",
        palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
      } as unknown as DesktopUiSettings,
      t: createTranslator("en")
    };
    const { result, rerender } = renderHook(({ currentGraph }) => useGraphPaletteActions({ ...baseArgs, graph: currentGraph }), {
      initialProps: { currentGraph: { ...graph, graphVersion: "pgv-before" } }
    });

    rerender({ currentGraph: { ...graph, graphVersion: "pgv-after" } });
    await act(async () => {
      await result.current.handleEdgesDelete([
        {
          id: "T-ALPHA->T-BETA",
          source: "T-BETA",
          target: "T-ALPHA",
          data: { manifestEdgeType: "depends_on", manifestFrom: "T-ALPHA", manifestTo: "T-BETA" }
        } as never
      ]);
    });

    expect(bridge.removeDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "pgv-after",
      {
        version: "desktop-layout/v1",
        projectId: graph.projectId,
        nodes: [
          { nodeId: "T-ALPHA", x: 120, y: 80 },
          { nodeId: "T-BETA", x: 580, y: 80 }
        ],
        updatedAt: new Date(0).toISOString()
      }
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("refreshes derived project state after adding dependency edges", async () => {
    const bridge = createDesktopBridgeMock({
      addDependencyEdge: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        flowInstance: null,
        graph: { ...graph, graphVersion: "pgv-before" },
        layout: null,
        loadProject: vi.fn().mockResolvedValue(undefined),
        nodes: [],
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout: vi.fn(),
        setNewTaskTargetId: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: {
          defaultExecutor: "",
          palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
        } as unknown as DesktopUiSettings,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await result.current.handleConnect({ source: "T-BETA", target: "T-ALPHA", sourceHandle: null, targetHandle: null });
    });

    expect(bridge.addDependencyEdge).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, "T-ALPHA", "T-BETA", "pgv-before", undefined);
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("refreshes derived project state after reconnecting dependency edges", async () => {
    const bridge = createDesktopBridgeMock({
      reconnectDependencyEdge: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        flowInstance: null,
        graph: { ...graph, graphVersion: "pgv-before" },
        layout: null,
        loadProject: vi.fn().mockResolvedValue(undefined),
        nodes: [],
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout: vi.fn(),
        setNewTaskTargetId: vi.fn(),
        selectTaskPanel: vi.fn(),
        settings: {
          defaultExecutor: "",
          palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
        } as unknown as DesktopUiSettings,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await result.current.handleReconnectEdge(
        {
          id: "T-ALPHA->T-BETA",
          source: "T-BETA",
          target: "T-ALPHA",
          data: { manifestEdgeType: "depends_on", manifestFrom: "T-ALPHA", manifestTo: "T-BETA" }
        } as never,
        { source: "T-ALPHA", target: "T-BETA", sourceHandle: null, targetHandle: null }
      );
    });

    expect(bridge.reconnectDependencyEdge).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      "T-BETA",
      "T-BETA",
      "T-ALPHA",
      "pgv-before",
      undefined
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("adds dropped tasks with their initial layout in a single graph edit", async () => {
    const addTaskNode = vi.fn().mockResolvedValue({ ok: true, affectedTasks: ["T-NEW"], diagnostics: [] });
    const bridge = createDesktopBridgeMock({
      addTaskNode,
      getDesktopLayout: vi.fn().mockResolvedValue(layout),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      saveDesktopLayout: vi.fn().mockResolvedValue(layout)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const selectTaskPanel = vi.fn();
    const setNewTaskTargetId = vi.fn();
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        flowInstance: null,
        graph,
        layout,
        loadProject,
        nodes: [],
        refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout: vi.fn(),
        setNewTaskTargetId,
        selectTaskPanel,
        settings: {
          defaultExecutor: "",
          palette: { defaultBlockSet: ["implementation"], dragHint: true, visible: { task: true, implementation: true, review: true } }
        } as unknown as DesktopUiSettings,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      await result.current.addPaletteComponent("task", { x: 42, y: 64 });
    });

    expect(addTaskNode).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      expect.objectContaining({ layoutPosition: { x: 42, y: 64 } })
    );
    expect(bridge.saveDesktopLayout).not.toHaveBeenCalled();
    expect(loadProject).toHaveBeenCalledWith(project, "canvas-main");
    expect(selectTaskPanel).toHaveBeenCalledWith("T-NEW");
    expect(setNewTaskTargetId).toHaveBeenCalledWith("T-NEW");
  });

  it("stops prompt autosave when a dirty draft conflicts with an external prompt change", async () => {
    vi.useFakeTimers();
    const bridge = createDesktopBridgeMock({
      updateTaskPrompt: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const baseGraph = {
      ...graph,
      graphVersion: "pgv-before",
      tasks: graph.tasks.map((task) => task.taskId === "T-ALPHA" ? { ...task, promptHash: "hash-before" } : task)
    };
    const changedGraph = {
      ...baseGraph,
      graphVersion: "pgv-after",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA" ? { ...task, promptMarkdown: "# Remote alpha", promptHash: "hash-after" } : task
      )
    };
    const { result, rerender } = renderHook(({ currentGraph }) =>
      usePromptDrafts({
        graph: currentGraph,
        refreshGraph: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn()
      }), {
        initialProps: { currentGraph: baseGraph }
      }
    );

    act(() => {
      result.current.handlePromptChange("T-ALPHA", "# Local alpha");
    });
    await act(async () => {
      rerender({ currentGraph: changedGraph });
      await Promise.resolve();
    });
    expect(result.current.promptConflicts.map((conflict) => conflict.taskId)).toEqual(["T-ALPHA"]);
    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(bridge.updateTaskPrompt).not.toHaveBeenCalled();
  });

  it("does not report a prompt conflict after a local prompt save succeeds", async () => {
    const bridge = createDesktopBridgeMock({
      updateTaskPrompt: vi.fn().mockResolvedValue({ ok: true, graphVersion: "pgv-saved", diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const baseGraph = {
      ...graph,
      graphVersion: "pgv-before",
      tasks: graph.tasks.map((task) => task.taskId === "T-ALPHA" ? { ...task, promptHash: "hash-before" } : task)
    };
    const savedGraph = {
      ...baseGraph,
      graphVersion: "pgv-saved",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA" ? { ...task, promptMarkdown: "# Local alpha", promptHash: "hash-saved" } : task
      )
    };
    const { result, rerender } = renderHook(({ currentGraph }) =>
      usePromptDrafts({
        graph: currentGraph,
        refreshGraph: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn()
      }), {
        initialProps: { currentGraph: baseGraph }
      }
    );

    act(() => {
      result.current.handlePromptChange("T-ALPHA", "# Local alpha");
    });
    await act(async () => {
      await result.current.handlePromptSave("T-ALPHA");
    });
    await act(async () => {
      rerender({ currentGraph: savedGraph });
      await Promise.resolve();
    });

    expect(result.current.promptConflicts).toEqual([]);
  });

  it("syncs clean task prompt and title drafts after graph history undo", async () => {
    const bridge = createDesktopBridgeMock({
      updateTaskPrompt: vi.fn().mockResolvedValue({ ok: true, graphVersion: "pgv-saved", diagnostics: [] }),
      updateTaskTitle: vi.fn().mockResolvedValue({ ok: true, graphVersion: "pgv-title-saved", diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const baseGraph = {
      ...graph,
      graphVersion: "pgv-before",
      tasks: graph.tasks.map((task) => task.taskId === "T-ALPHA" ? { ...task, promptHash: "hash-before" } : task)
    };
    const savedGraph = {
      ...baseGraph,
      graphVersion: "pgv-saved",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA"
          ? { ...task, title: "Saved title", promptMarkdown: "# Local alpha", promptHash: "hash-saved" }
          : task
      )
    };
    const undoneGraph = {
      ...baseGraph,
      graphVersion: "pgv-undone",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA"
          ? { ...task, title: "Alpha task", promptMarkdown: "# Alpha", promptHash: "hash-before" }
          : task
      )
    };
    const { result, rerender } = renderHook(({ currentGraph }) =>
      usePromptDrafts({
        graph: currentGraph,
        refreshGraph: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn()
      }), {
        initialProps: { currentGraph: baseGraph }
      }
    );

    act(() => {
      result.current.handlePromptChange("T-ALPHA", "# Local alpha");
      result.current.handleTitleChange("T-ALPHA", "Saved title");
    });
    await act(async () => {
      await result.current.handlePromptSave("T-ALPHA");
      await result.current.handleTitleSave("T-ALPHA");
    });
    await act(async () => {
      rerender({ currentGraph: savedGraph });
      await Promise.resolve();
    });
    expect(result.current.promptDrafts["T-ALPHA"]).toBe("# Local alpha");
    expect(result.current.titleDrafts["T-ALPHA"]).toBe("Saved title");

    await act(async () => {
      rerender({ currentGraph: undoneGraph });
      await Promise.resolve();
    });

    expect(result.current.promptDrafts["T-ALPHA"]).toBe("# Alpha");
    expect(result.current.titleDrafts["T-ALPHA"]).toBe("Alpha task");
    expect(result.current.promptConflicts).toEqual([]);
  });

  it("refreshes the selected block prompt base after saving a block prompt", async () => {
    const blockBefore: DesktopBlockDetail = {
      ref: "T-ALPHA#B-001",
      graphVersion: "pgv-before",
      taskId: "T-ALPHA",
      blockId: "B-001",
      type: "implementation",
      title: "Block",
      status: "ready",
      executor: null,
      effectiveExecutor: null,
      promptMarkdown: "# Local block",
      promptHash: "hash-before",
      promptMissing: false,
      promptSurfaceMarkdown: "# Local block",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };
    const blockAfter: DesktopBlockDetail = {
      ...blockBefore,
      graphVersion: "pgv-after",
      promptHash: "hash-after"
    };
    const bridge = createDesktopBridgeMock({
      updateBlockPrompt: vi.fn().mockResolvedValue({ ok: true, graphVersion: "pgv-after", diagnostics: [] }),
      getBlockDetail: vi.fn().mockResolvedValue(blockAfter)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const refreshGraph = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useSelectedBlock({
        refreshGraph,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView: vi.fn(),
        setError: vi.fn()
      })
    );

    act(() => {
      result.current.setSelectedBlock(blockBefore);
    });
    await act(async () => {
      await result.current.saveSelectedBlockPrompt();
    });

    expect(bridge.updateBlockPrompt).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA#B-001",
      "# Local block",
      { baseGraphVersion: "pgv-before", basePromptHash: "hash-before" }
    );
    expect(bridge.getBlockDetail).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, "T-ALPHA#B-001");
    expect(result.current.selectedBlock?.graphVersion).toBe("pgv-after");
    expect(result.current.selectedBlock?.promptHash).toBe("hash-after");
    expect(refreshGraph).toHaveBeenCalledTimes(1);
  });

  it("refreshes derived project state after deleting a block", async () => {
    const selectedBlock: DesktopBlockDetail = {
      ref: "T-ALPHA#B-001",
      graphVersion: "pgv-before",
      taskId: "T-ALPHA",
      blockId: "B-001",
      type: "implementation",
      title: "Block",
      status: "ready",
      executor: null,
      effectiveExecutor: null,
      promptMarkdown: "# Block",
      promptHash: "hash-before",
      promptMissing: false,
      promptSurfaceMarkdown: "# Block",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };
    const bridge = createDesktopBridgeMock({
      removeBlock: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { useGraphDeleteActions } = await import("../renderer/hooks/useGraphDeleteActions");
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const clearSelectedBlockRecords = vi.fn();
    const setBlockInspectorOpen = vi.fn();
    const setSelectedBlock = vi.fn();
    const setSelectedRunRecord = vi.fn();
    const { result } = renderHook(() =>
      useGraphDeleteActions({
        clearTaskPanelSelection: vi.fn(),
        clearSelectedBlockRecords,
        deleteBlockConfirm: "Delete block?",
        deleteTaskConfirm: "Delete task?",
        loadProject: vi.fn().mockResolvedValue(undefined),
        refreshProjectDerivedState,
        selectedCanvasId: "canvas-main",
        selectedBlock,
        selectedProject: project,
        selectedTaskPanelId: null,
        setBlockInspectorOpen,
        setError: vi.fn(),
        setSelectedBlock,
        setSelectedRunRecord
      })
    );

    await act(async () => {
      await result.current.handleDeleteBlock(selectedBlock.ref);
    });

    expect(bridge.removeBlock).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, selectedBlock.ref);
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(setSelectedBlock).toHaveBeenCalledWith(null);
    expect(setSelectedRunRecord).toHaveBeenCalledWith(null);
    expect(setBlockInspectorOpen).toHaveBeenCalledWith(false);
    expect(clearSelectedBlockRecords).toHaveBeenCalledTimes(1);
  });

  it("reloads the current canvas for package changes that require a full refresh", async () => {
    const bridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: true,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [],
        dirtyPromptRefs: []
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setLastFileChange: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshPackageFiles();
    });

    expect(reloadCurrentCanvas).toHaveBeenCalledTimes(1);
    expect(refreshProjectDerivedState).not.toHaveBeenCalled();
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

  it("normalizes review pipeline draft values before saving", async () => {
    const reviewHook = {
      id: "review-hook",
      type: "executable" as const,
      command: "node",
      args: ["--message", "hello world", ""],
      executionPolicy: "trusted-local" as const
    };
    const pipelineWithHook: DesktopReviewPipeline = {
      ...reviewPipeline,
      packageDefaults: {
        maxFeedbackCycles: 2,
        completionPolicy: "strict"
      },
      steps: [
        {
          ...reviewPipeline.steps[0],
          maxFeedbackCycles: 2,
          hook: reviewHook
        }
      ]
    };
    const updateReviewPipeline = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummary: vi.fn().mockResolvedValue(null),
      getReviewPipeline: vi.fn().mockResolvedValue(pipelineWithHook),
      updateReviewPipeline
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
      import("../renderer/hooks/useReviewPipeline"),
      import("../renderer/i18n")
    ]);

    const { result } = renderHook(() =>
      useReviewPipeline({
        graph,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        t: createTranslator("en")
      })
    );

    await waitFor(() => expect(result.current.reviewPipeline).toEqual(pipelineWithHook));

    act(() => {
      result.current.setReviewDefaultCyclesDraft(Number.NaN);
      result.current.updateReviewStep(0, {
        maxFeedbackCycles: -3,
        hook: reviewHook
      });
    });

    await act(async () => {
      await result.current.saveReviewPipeline();
    });

    expect(updateReviewPipeline).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      {
        packageDefaults: {
          maxFeedbackCycles: 0,
          completionPolicy: "strict"
        },
        steps: [
          {
            ...pipelineWithHook.steps[0],
            maxFeedbackCycles: 0,
            hook: {
              ...reviewHook,
              args: ["--message", "hello world"]
            }
          }
        ]
      }
    );
  });

  it("normalizes non-finite review pipeline numbers to non-negative integers", async () => {
    const { normalizeNonNegativeInteger } = await import("../renderer/hooks/reviewPipelineDraft");

    expect(normalizeNonNegativeInteger(Number.NaN)).toBe(0);
    expect(normalizeNonNegativeInteger(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeNonNegativeInteger(-1)).toBe(0);
    expect(normalizeNonNegativeInteger(3.9)).toBe(3);
  });

  it("resets the review pipeline task when the graph changes to a canvas without the previous task", async () => {
    const getReviewPipeline = vi.fn((_canvas, taskId: string) =>
      Promise.resolve({
        ...reviewPipeline,
        taskId,
        taskTitle: `${taskId} title`
      })
    );
    const bridge = createDesktopBridgeMock({
      getReviewPipeline
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
      import("../renderer/hooks/useReviewPipeline"),
      import("../renderer/i18n")
    ]);
    const nextGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: [
        {
          ...graph.tasks[0],
          taskId: "T-GAMMA",
          title: "Gamma task"
        }
      ]
    };

    const { result, rerender } = renderHook(
      ({ graphValue, canvasId }: { graphValue: DesktopGraphViewModel; canvasId: string }) =>
        useReviewPipeline({
          graph: graphValue,
          reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
          selectedCanvasId: canvasId,
          selectedProject: project,
          setError: vi.fn(),
          t: createTranslator("en")
        }),
      {
        initialProps: {
          graphValue: graph,
          canvasId: "canvas-main"
        }
      }
    );

    await waitFor(() =>
      expect(getReviewPipeline).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, "T-ALPHA")
    );

    rerender({
      graphValue: nextGraph,
      canvasId: "canvas-alt"
    });

    await waitFor(() => expect(result.current.reviewTaskId).toBe("T-GAMMA"));
    await waitFor(() =>
      expect(getReviewPipeline).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-alt" }, "T-GAMMA")
    );
    expect(getReviewPipeline).not.toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-alt" }, "T-ALPHA");
  });

});

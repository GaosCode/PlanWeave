/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSnapshot,
  DesktopProjectSummary,
  DesktopStatistics,
  DesktopTodoGroups
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";
import { useVisibleGraphTasks } from "../renderer/hooks/useVisibleGraphTasks";
import { deferred, layout, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

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

  it("keeps performance diagnostics out of the project error banner", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot({
        diagnostics: [
          {
            code: "desktop_projection_slow_part",
            message: "Desktop projection project aggregation took 42 ms.",
            path: project.rootPath
          },
          {
            code: "desktop_canvas_execution_snapshot_failed",
            message: "Canvas snapshot failed.",
            path: "canvas-main"
          }
        ],
        errors: [
          "Desktop projection project aggregation took 42 ms.",
          "Canvas snapshot failed."
        ]
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

    await waitFor(() => expect(result.current.projectDiagnostics).toHaveLength(2));

    expect(result.current.projectDiagnostics[0]?.code).toBe("desktop_projection_slow_part");
    expect(setError).toHaveBeenCalledWith("Canvas snapshot failed.");
    expect(setError).not.toHaveBeenCalledWith("Desktop projection project aggregation took 42 ms.");
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
});

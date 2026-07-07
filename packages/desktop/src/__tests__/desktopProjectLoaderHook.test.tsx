/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSummary,
  DesktopStatistics,
  DesktopTodoGroups,
  ValidationIssue
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, layout, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

describe("desktop project loader hook", () => {
  it("loads a project through bridge calls scoped by DesktopCanvasReference", async () => {
    const graphQualityDiagnostic = {
      code: "task_orphaned",
      message: "Some tasks are not connected.",
      source: "graph_quality",
      severity: "warning",
      suggestedTool: "add_task_dependency"
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      getDesktopGraphDiagnostics: vi.fn().mockResolvedValue({
        graphQuality: { ok: true, diagnostics: [] },
        executionReadiness: { ok: true, diagnostics: [] },
        diagnostics: [graphQualityDiagnostic]
      }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const updateSettings = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings
      })
    );

    await waitFor(() => expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalled());
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(bridge.getDesktopGraphDiagnostics).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    await waitFor(() => expect(result.current.graphDiagnostics).toEqual([graphQualityDiagnostic]));
    expect(bridge.getGraphViewModel).not.toHaveBeenCalled();
    expect(bridge.getDesktopLayout).not.toHaveBeenCalled();
    expect(bridge.getTodoGroups).not.toHaveBeenCalled();
    expect(bridge.watchPackageFiles).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(updateSettings).toHaveBeenCalledWith({ runtimePath: project.workspaceRoot });
  });

  it("refreshes project summaries without replacing the current project selection", async () => {
    const refreshedProject: DesktopProjectSummary = {
      ...project,
      name: "Demo project updated",
      taskCanvases: [
        ...project.taskCanvases,
        {
          canvasId: "canvas-secondary",
          name: "Secondary canvas",
          taskCount: 0,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z"
        }
      ]
    };
    const newProject: DesktopProjectSummary = {
      ...project,
      projectId: "P-002",
      name: "Imported project",
      rootPath: "/tmp/imported",
      workspaceRoot: "/tmp/imported"
    };
    const listProjects = vi.fn().mockResolvedValue([project]);
    const bridge = createDesktopBridgeMock({
      listProjects,
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
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

    await waitFor(() => expect(result.current.selectedProject?.projectId).toBe(project.projectId));
    listProjects.mockClear();
    listProjects.mockResolvedValue([refreshedProject, newProject]);
    await act(async () => {
      await result.current.refreshProjects();
    });

    expect(listProjects).toHaveBeenCalled();
    expect(result.current.projects.map((item) => item.projectId)).toEqual(["P-001", "P-002"]);
    expect(result.current.selectedProject?.name).toBe("Demo project updated");
    expect(result.current.selectedCanvasId).toBe("canvas-main");
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

    const { result } = renderHook(() =>
      useDesktopProject({
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
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
    const pendingReload = deferred<ReturnType<typeof projectSnapshot>>();
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

  it("ignores stale load side effects after switching projects during diagnostics refresh", async () => {
    const staleDiagnostics = deferred<{
      graphQuality: { ok: boolean; diagnostics: ValidationIssue[] };
      executionReadiness: { ok: boolean; diagnostics: ValidationIssue[] };
      diagnostics: ValidationIssue[];
    }>();
    const activeDiagnostic: ValidationIssue = {
      code: "task_orphaned",
      message: "Active project diagnostic.",
      source: "graph_quality",
      severity: "warning",
      suggestedTool: "add_task_dependency"
    };
    const staleDiagnostic: ValidationIssue = {
      code: "task_orphaned",
      message: "Stale project diagnostic.",
      source: "graph_quality",
      severity: "warning",
      suggestedTool: "add_task_dependency"
    };
    const otherProject: DesktopProjectSummary = {
      ...project,
      projectId: "P-002",
      name: "Other project",
      rootPath: "/tmp/other-demo",
      workspaceRoot: "/tmp/other-demo"
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi.fn()
        .mockResolvedValueOnce(projectSnapshot())
        .mockResolvedValueOnce(projectSnapshot()),
      getDesktopGraphDiagnostics: vi.fn()
        .mockReturnValueOnce(staleDiagnostics.promise)
        .mockResolvedValueOnce({
          graphQuality: { ok: true, diagnostics: [] },
          executionReadiness: { ok: true, diagnostics: [] },
          diagnostics: [activeDiagnostic]
        }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const updateSettings = vi.fn();
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        setError,
        t: createTranslator("en"),
        updateSettings
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    let staleLoadPromise: Promise<void> | null = null;
    await act(async () => {
      staleLoadPromise = result.current.loadProject(project, "canvas-main");
      await waitFor(() => expect(bridge.getDesktopGraphDiagnostics).toHaveBeenCalledTimes(1));
    });

    await act(async () => {
      await result.current.loadProject(otherProject, "canvas-main");
    });

    expect(result.current.selectedProject?.projectId).toBe(otherProject.projectId);
    expect(result.current.graphDiagnostics).toEqual([activeDiagnostic]);
    expect(updateSettings).toHaveBeenCalledWith({ runtimePath: otherProject.workspaceRoot });
    updateSettings.mockClear();

    await act(async () => {
      staleDiagnostics.resolve({
        graphQuality: { ok: true, diagnostics: [] },
        executionReadiness: { ok: true, diagnostics: [] },
        diagnostics: [staleDiagnostic]
      });
      if (!staleLoadPromise) {
        throw new Error("Stale load promise was not started.");
      }
      await staleLoadPromise;
    });

    expect(result.current.selectedProject?.projectId).toBe(otherProject.projectId);
    expect(result.current.graphDiagnostics).toEqual([activeDiagnostic]);
    expect(updateSettings).not.toHaveBeenCalledWith({ runtimePath: project.workspaceRoot });
    expect(result.current.projectLoading).toBe(false);
    expect(setError).not.toHaveBeenCalledWith("Stale project diagnostic.");
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
});

/* @vitest-environment jsdom */

import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopGraphDiagnostics,
  DesktopGraphDiagnosticIssue,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSummary,
  DesktopStatistics,
  DesktopTodoGroups
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import {
  deferred,
  layout,
  project,
  projectSnapshot,
  projectDiagnostics
} from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

describe("desktop project loader hook", () => {
  it("keeps diagnostics and errors in the current request generation under StrictMode", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      getGraphViewModel: vi.fn().mockResolvedValue(graph)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const setError = vi.fn();
    const t = createTranslator("en");
    const updateSettings = vi.fn();
    const { result, unmount } = renderHook(
      () => useDesktopProject({ planweaveHome: "", setError, t, updateSettings }),
      { wrapper: StrictMode }
    );
    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project);
    });
    const staleDiagnostics =
      deferred<Awaited<ReturnType<typeof bridge.getDesktopGraphDiagnostics>>>();
    vi.mocked(bridge.getDesktopGraphDiagnostics).mockReturnValueOnce(staleDiagnostics.promise);
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.refreshGraph();
    });
    const activeDiagnostic: DesktopGraphDiagnosticIssue = {
      code: "active",
      message: "Current diagnostic",
      source: "graph_quality",
      severity: "warning"
    };
    vi.mocked(bridge.getDesktopGraphDiagnostics).mockResolvedValue(
      projectDiagnostics([activeDiagnostic])
    );
    await act(async () => {
      await result.current.refreshGraph();
    });
    await act(async () => {
      staleDiagnostics.resolve(
        projectDiagnostics([
          { code: "old", message: "Obsolete", source: "graph_quality", severity: "warning" }
        ])
      );
      await first;
    });
    expect(result.current.graphDiagnostics).toEqual([activeDiagnostic]);
    const failed = deferred<DesktopGraphViewModel>();
    vi.mocked(bridge.getGraphViewModel).mockReturnValueOnce(failed.promise);
    act(() => {
      first = result.current.refreshGraph();
    });
    await act(async () => {
      await result.current.loadProject(project, "other");
    });
    setError.mockClear();
    await act(async () => {
      failed.reject(new Error("obsolete failure"));
      await first;
    });
    expect(setError).not.toHaveBeenCalled();
    vi.mocked(bridge.getGraphViewModel).mockRejectedValueOnce(new Error("current failure"));
    await expect(result.current.refreshGraph()).rejects.toThrow("current failure");
    await act(async () => {
      await result.current.refreshGraph();
    });
    expect(result.current.graph).toBe(graph);
    const unmounted = deferred<DesktopGraphViewModel>();
    vi.mocked(bridge.getGraphViewModel).mockReturnValueOnce(unmounted.promise);
    act(() => {
      first = result.current.refreshGraph();
    });
    unmount();
    unmounted.reject(new Error("unmounted failure"));
    await expect(first).resolves.toBeUndefined();
  });

  it.each([
    "graph",
    "derived",
    "layout"
  ])("keeps each load data category owned by the latest %s writer", async (writer) => {
    const snapshot = deferred<ReturnType<typeof projectSnapshot>>();
    const loadedSnapshot = projectSnapshot({
      projectPromptMarkdown: "Loaded prompt",
      projectPromptPolicy: { includeGlobalPrompt: true },
      todoGroups: {
        planned: [],
        ready: [],
        in_progress: [],
        completed: [],
        needs_changes: [],
        blocked: [],
        diverged: [],
        implemented: []
      },
      executionPlan: { notes: ["Loaded plan"], phases: [], readyQueue: [] },
      statistics: {
        averageImplementationTimeMs: null,
        totalImplementationTimeMs: null,
        timedImplementationRunCount: 0,
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
      }
    });
    const activeGraph = { ...graph, graphVersion: "active-refresh" };
    const refreshedSnapshot = projectSnapshot({
      ...loadedSnapshot,
      graph: activeGraph,
      layout: { ...layout, nodes: [{ nodeId: "T-ALPHA", x: 20, y: 40 }] },
      todoGroups: { ...loadedSnapshot.todoGroups!, planned: [] },
      executionPlan: { notes: ["Newer plan"], phases: [], readyQueue: [] },
      statistics: { ...loadedSnapshot.statistics!, taskTotal: 2 },
      projectPromptMarkdown: "Not requested by refresh"
    });
    const activeDiagnostics = [{ code: "current", message: "Current graph diagnostic" }];
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi
        .fn()
        .mockReturnValueOnce(snapshot.promise)
        .mockResolvedValue(refreshedSnapshot),
      getDesktopGraphDiagnostics: vi.fn().mockResolvedValue({
        diagnostics: activeDiagnostics,
        graphQuality: { ok: true, diagnostics: [] },
        executionReadiness: { ok: true, diagnostics: [] }
      }),
      getGraphViewModel: vi.fn().mockResolvedValue(activeGraph)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const setError = vi.fn();
    const t = createTranslator("en");
    const updateSettings = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({ planweaveHome: "", setError, t, updateSettings })
    );
    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadProject(project);
    });
    await act(async () => {
      if (writer === "graph") await result.current.refreshGraph();
      else await result.current.refreshProjectDerivedState({ includeLayout: writer === "layout" });
    });
    await act(async () => {
      snapshot.resolve(loadedSnapshot);
      await loading;
    });
    expect(result.current.graph).toBe(activeGraph);
    expect(result.current.projectLoading).toBe(false);
    expect(result.current.layout).toBe(writer === "layout" ? refreshedSnapshot.layout : layout);
    expect(result.current.graphDiagnostics).toEqual(activeDiagnostics);
    expect(result.current.projectPromptMarkdown).toBe("Loaded prompt");
    expect(result.current.projectPromptPolicy).toEqual({ includeGlobalPrompt: true });
    const expectedDerived = writer === "graph" ? loadedSnapshot : refreshedSnapshot;
    expect(result.current.todoGroups).toBe(expectedDerived.todoGroups);
    expect(result.current.executionPlan).toBe(expectedDerived.executionPlan);
    expect(result.current.statistics).toBe(expectedDerived.statistics);
  });

  it.each([
    "switch",
    "return",
    "refresh",
    "snapshot",
    "clear",
    "unmount"
  ])("ignores a delayed graph response after %s", async (transition) => {
    const pending = deferred<DesktopGraphViewModel>();
    const activeGraph = { ...graph, graphVersion: "active" };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      getGraphViewModel: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(activeGraph)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const setError = vi.fn();
    const updateSettings = vi.fn();
    const t = createTranslator("en");
    const { result, unmount } = renderHook(() =>
      useDesktopProject({ planweaveHome: "", setError, updateSettings, t })
    );
    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project);
    });
    let request!: Promise<void>;
    act(() => {
      request = result.current.refreshGraph();
    });
    await act(async () => {
      if (transition === "switch" || transition === "return") {
        await result.current.loadProject(project, "other");
        if (transition === "return") await result.current.loadProject(project, "canvas-main");
      } else if (transition === "refresh") {
        await result.current.refreshGraph();
      } else if (transition === "snapshot") {
        await result.current.refreshProjectDerivedState();
      } else if (transition === "clear") {
        await result.current.refreshProjects();
      } else {
        unmount();
      }
    });
    const expected = result.current.graph;
    const diagnosticsCalls = vi.mocked(bridge.getDesktopGraphDiagnostics).mock.calls.length;
    await act(async () => {
      pending.resolve({ ...graph, graphVersion: "obsolete" });
      await request;
    });
    expect(result.current.graph).toBe(expected);
    expect(bridge.getDesktopGraphDiagnostics).toHaveBeenCalledTimes(diagnosticsCalls);
  });

  it("waits for settings hydration and restores the persisted project path", async () => {
    const restoredProject: DesktopProjectSummary = {
      ...project,
      projectId: "P-RESTORED",
      name: "Restored project",
      rootPath: "/tmp/restored",
      workspaceRoot: "/tmp/restored"
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project, restoredProject]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const updateSettings = vi.fn();
    const setError = vi.fn();
    const t = createTranslator("en");
    const { rerender, result } = renderHook(
      ({ settingsHydrated, initialProjectPath }) =>
        useDesktopProject({
          planweaveHome: "",
          setError,
          t,
          updateSettings,
          settingsHydrated,
          initialProjectPath
        }),
      { initialProps: { settingsHydrated: false, initialProjectPath: "" } }
    );

    expect(bridge.listProjects).not.toHaveBeenCalled();
    rerender({
      settingsHydrated: true,
      initialProjectPath: restoredProject.workspaceRoot
    });

    await waitFor(() =>
      expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({
        projectRoot: restoredProject.rootPath,
        canvasId: "canvas-main"
      })
    );
    expect(result.current.selectedProject?.projectId).toBe(restoredProject.projectId);
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({ runtimePath: restoredProject.workspaceRoot });
    expect(updateSettings).not.toHaveBeenCalledWith({ runtimePath: project.workspaceRoot });
  });

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
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const updateSettings = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings
      })
    );

    await waitFor(() => expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalled());
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(bridge.getDesktopGraphDiagnostics).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    await waitFor(() => expect(result.current.graphDiagnostics).toEqual([graphQualityDiagnostic]));
    expect(bridge.getGraphViewModel).not.toHaveBeenCalled();
    expect(bridge.getDesktopLayout).not.toHaveBeenCalled();
    expect(bridge.getTodoGroups).not.toHaveBeenCalled();
    expect(bridge.watchPackageFiles).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(updateSettings).toHaveBeenCalledWith({ runtimePath: project.workspaceRoot });
  });

  it("refreshes project summaries without replacing the current project selection", async () => {
    const refreshedProject: DesktopProjectSummary = {
      ...project,
      name: "Demo project updated",
      taskCanvases: [
        ...project.taskCanvases,
        {
          ...project.taskCanvases[0],
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
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const setError = vi.fn();
    const updateSettings = vi.fn();

    const { result } = renderHook(() =>
      useDesktopProject({ planweaveHome: "", setError, t: createTranslator("en"), updateSettings })
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

    await act(async () => {
      await result.current.refreshProjects({
        selectProjectId: refreshedProject.projectId,
        selectCanvasId: "canvas-secondary"
      });
    });
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({
      projectRoot: refreshedProject.rootPath,
      canvasId: "canvas-secondary"
    });
    await waitFor(() => expect(result.current.selectedCanvasId).toBe("canvas-secondary"));
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
          dispatchable: true,
          sharedResources: [],
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
      totalImplementationTimeMs: null,
      timedImplementationRunCount: 0,
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
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
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
        planweaveHome: "",
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    await act(async () => {
      await result.current.loadProject(project, "canvas-main");
    });
    await waitFor(() =>
      expect(result.current.graph?.tasks.map((task) => task.taskId)).toEqual(["T-ALPHA", "T-BETA"])
    );
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
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenLastCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
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
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined),
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getDesktopLayout: vi.fn().mockResolvedValue(nextLayout)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
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
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenLastCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
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
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
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

    await waitFor(() =>
      expect(result.current.graph?.tasks.map((task) => task.taskId)).toEqual(["T-ALPHA", "T-BETA"])
    );
    expect(result.current.projectLoading).toBe(false);
  });

  it("keeps the current canvas graph visible while reloading the same canvas", async () => {
    const pendingReload = deferred<ReturnType<typeof projectSnapshot>>();
    const nextGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) =>
        task.taskId === "T-ALPHA" ? { ...task, promptPreview: "Updated alpha" } : task
      )
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi
        .fn()
        .mockResolvedValueOnce(projectSnapshot())
        .mockReturnValueOnce(pendingReload.promise),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
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
    const staleDiagnostics = deferred<DesktopGraphDiagnostics>();
    const activeDiagnostic: DesktopGraphDiagnosticIssue = {
      code: "task_orphaned",
      message: "Active project diagnostic.",
      source: "graph_quality",
      severity: "warning",
      suggestedTool: "add_task_dependency"
    };
    const staleDiagnostic: DesktopGraphDiagnosticIssue = {
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
      getDesktopProjectSnapshot: vi
        .fn()
        .mockResolvedValueOnce(projectSnapshot())
        .mockResolvedValueOnce(projectSnapshot()),
      getDesktopGraphDiagnostics: vi
        .fn()
        .mockReturnValueOnce(staleDiagnostics.promise)
        .mockResolvedValueOnce(projectDiagnostics([activeDiagnostic])),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const updateSettings = vi.fn();
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({ planweaveHome: "", setError, t: createTranslator("en"), updateSettings })
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
      staleDiagnostics.resolve(projectDiagnostics([staleDiagnostic]));
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
        planweaveHome: "",
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await act(async () => {
      await result.current.handleOpenProject();
    });

    expect(setError).toHaveBeenCalledWith(
      "Project folder selection is only available in the desktop app. Please open PlanWeave Desktop and choose a project root."
    );
  });

  it("opens the active task canvas when project summaries include one", async () => {
    const activeProject: DesktopProjectSummary = {
      ...project,
      activeCanvasId: "canvas-active",
      taskCanvases: [
        {
          ...project.taskCanvases[0],
          canvasId: "canvas-stale",
          name: "Stale imported canvas",
          taskCount: 0,
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z"
        },
        {
          ...project.taskCanvases[0],
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
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalled());
    expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalledWith({
      projectRoot: activeProject.rootPath,
      canvasId: "canvas-active"
    });
    expect(bridge.watchPackageFiles).toHaveBeenCalledWith({
      projectRoot: activeProject.rootPath,
      canvasId: "canvas-active"
    });
  });

  it("keeps a requested project graph canvas even when it is absent from the project summary", async () => {
    vi.resetModules();
    const { resolveProjectCanvasId } = await import("../renderer/hooks/useDesktopProject");

    expect(resolveProjectCanvasId(project, "manual-canvas")).toBe("manual-canvas");
  });

  it("keeps project prompt state when the active canvas graph fails to load", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(
        projectSnapshot({
          projectPromptMarkdown: "# Project Prompt\n",
          projectPromptPolicy: { includeGlobalPrompt: true },
          graph: null,
          layout: null,
          diagnostics: [
            {
              code: "desktop_snapshot_part_failed",
              path: "graph",
              message: "Invalid manifest schema"
            }
          ],
          errors: ["graph: Invalid manifest schema"]
        })
      )
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
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
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(
        projectSnapshot({
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
          errors: ["Desktop projection project aggregation took 42 ms.", "Canvas snapshot failed."]
        })
      )
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
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
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(
        projectSnapshot({
          layout: null,
          diagnostics: [
            {
              code: "desktop_snapshot_part_failed",
              path: "layout",
              message: "layout.nodes.filter is not a function"
            }
          ],
          errors: ["layout: layout.nodes.filter is not a function"]
        })
      ),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() =>
      expect(result.current.graph?.tasks.map((task) => task.taskId)).toEqual(["T-ALPHA", "T-BETA"])
    );

    expect(result.current.layout).toBeNull();
    expect(setError).toHaveBeenCalledWith("layout: layout.nodes.filter is not a function");
  });

  it("rejects strict derived refreshes when the snapshot contains errors", async () => {
    const getDesktopProjectSnapshot = vi.fn().mockResolvedValue(projectSnapshot());
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot,
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
        setError,
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(result.current.projectLoading).toBe(false));
    getDesktopProjectSnapshot.mockResolvedValue(
      projectSnapshot({
        diagnostics: [
          {
            code: "desktop_snapshot_part_failed",
            path: "graph",
            message: "authoritative package could not be loaded"
          }
        ],
        errors: ["graph: authoritative package could not be loaded"]
      })
    );

    await expect(
      act(async () => {
        await result.current.refreshProjectDerivedState({ throwOnErrors: true });
      })
    ).rejects.toThrow("graph: authoritative package could not be loaded");
    expect(setError).toHaveBeenCalledWith("graph: authoritative package could not be loaded");
  });
});

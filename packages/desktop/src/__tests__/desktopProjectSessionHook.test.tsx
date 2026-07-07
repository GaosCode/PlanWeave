/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopAutoRunState, DesktopBlockDetail, ValidationIssue } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { useDesktopProject } from "../renderer/hooks/useDesktopProject";

afterEach(cleanupRendererTestEnvironment);

type DesktopProjectState = ReturnType<typeof useDesktopProject>;

function latestAutoRunState(patch: Partial<DesktopAutoRunState> = {}): DesktopAutoRunState {
  const base: DesktopAutoRunState = {
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
  };
  return { ...base, ...patch };
}

function projectStateFixture(overrides: Partial<DesktopProjectState> = {}): DesktopProjectState {
  return {
    expandedProjectId: null,
    executionPlan: null,
    graph: null,
    graphDiagnostics: [],
    handleOpenProject: vi.fn().mockResolvedValue(undefined),
    layout: null,
    loadProject: vi.fn().mockResolvedValue(undefined),
    pendingImportRecoveries: [],
    projectLoading: false,
    projects: [project],
    projectDiagnostics: [],
    projectPromptMarkdown: null,
    projectPromptPolicy: null,
    projectRefreshing: false,
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    refreshProjectSummary: vi.fn().mockResolvedValue(project),
    refreshGraph: vi.fn().mockResolvedValue(undefined),
    refreshGraphAndLayout: vi.fn().mockResolvedValue(undefined),
    refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
    refreshRuntimeState: vi.fn().mockResolvedValue(undefined),
    rollbackPendingImportRecovery: vi.fn().mockResolvedValue(undefined),
    runtimeDiagnostics: [],
    runtimeRefreshSnapshot: null,
    removeProject: vi.fn().mockResolvedValue(undefined),
    selectedCanvasId: "canvas-main",
    selectedProject: project,
    setLayout: vi.fn(),
    statistics: null,
    todoGroups: null,
    updateProjectPrompt: vi.fn().mockResolvedValue(undefined),
    updateProjectPromptPolicy: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("desktop project session hook", () => {
  it("coordinates project/canvas switching through Desktop Project Session actions", async () => {
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummaryWithDiagnostics: vi.fn().mockResolvedValue({
        diagnostics: [],
        state: latestAutoRunState()
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProjectSession } = await import("../renderer/hooks/useDesktopProjectSession");

    const clearSelectedBlockRecords = vi.fn();
    const loadProject = vi.fn().mockResolvedValue(undefined);
    const setActiveView = vi.fn();
    const setBlockInspectorOpen = vi.fn();
    const setSelectedBlock = vi.fn();
    const setSelectedRunRecord = vi.fn();
    const projectState = projectStateFixture({ loadProject });

    const { result } = renderHook(() =>
      useDesktopProjectSession({
        clearSelectedBlockRecords,
        language: "zh-CN",
        projectState,
        selectBlock: vi.fn().mockResolvedValue(undefined),
        setActiveView,
        setBlockInspectorOpen,
        setError: vi.fn(),
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
    expect(bridge.getLatestAutoRunSummaryWithDiagnostics).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(result.current.autoRunState).toEqual(expect.objectContaining({ runId: "RUN-001" }));
  });

  it("duplicates a canvas and opens the duplicated canvas in the desktop session", async () => {
    const duplicatedCanvas = {
      canvasId: "canvas-copy",
      name: "Main canvas copy",
      taskCount: 2,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    };
    const refreshedProject = {
      ...project,
      activeCanvasId: duplicatedCanvas.canvasId,
      taskCanvases: [...project.taskCanvases, duplicatedCanvas]
    };
    const bridge = createDesktopBridgeMock({
      duplicateTaskCanvas: vi.fn().mockResolvedValue(duplicatedCanvas),
      getLatestAutoRunSummaryWithDiagnostics: vi.fn().mockResolvedValue({ state: null, diagnostics: [] }),
      selectTaskCanvas: vi.fn().mockResolvedValue(duplicatedCanvas.canvasId)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProjectSession } = await import("../renderer/hooks/useDesktopProjectSession");

    const loadProject = vi.fn().mockResolvedValue(undefined);
    const refreshProjectSummary = vi.fn().mockResolvedValue(refreshedProject);
    const projectState = projectStateFixture({ loadProject, refreshProjectSummary });

    const { result } = renderHook(() =>
      useDesktopProjectSession({
        clearSelectedBlockRecords: vi.fn(),
        language: "zh-CN",
        projectState,
        selectBlock: vi.fn().mockResolvedValue(undefined),
        setActiveView: vi.fn(),
        setBlockInspectorOpen: vi.fn(),
        setError: vi.fn(),
        setSelectedBlock: vi.fn(),
        setSelectedRunRecord: vi.fn()
      })
    );

    await act(async () => {
      await result.current.duplicateTaskCanvas(project, "canvas-main");
    });

    expect(bridge.duplicateTaskCanvas).toHaveBeenCalledWith(project.rootPath, "canvas-main");
    expect(refreshProjectSummary).toHaveBeenCalledWith(project.rootPath, "canvas-copy");
    expect(bridge.selectTaskCanvas).toHaveBeenCalledWith(project.rootPath, "canvas-copy");
    expect(loadProject).toHaveBeenCalledWith(refreshedProject, "canvas-copy");
    expect(bridge.getLatestAutoRunSummaryWithDiagnostics).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-copy" });
  });

  it("keeps latest Auto Run summary diagnostics for the desktop diagnostics popover", async () => {
    const autoRunDiagnostics: ValidationIssue[] = [
      {
        code: "auto_run_state_invalid_json",
        message: "Auto Run state could not be parsed.",
        path: "/tmp/demo/.planweave/results/auto-runs/DESKTOP-RUN-0002/state.json"
      }
    ];
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummaryWithDiagnostics: vi.fn().mockResolvedValue({
        state: null,
        diagnostics: autoRunDiagnostics
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProjectSession } = await import("../renderer/hooks/useDesktopProjectSession");

    const { result } = renderHook(() =>
      useDesktopProjectSession({
        clearSelectedBlockRecords: vi.fn(),
        language: "zh-CN",
        projectState: projectStateFixture(),
        selectBlock: vi.fn().mockResolvedValue(undefined),
        setActiveView: vi.fn(),
        setBlockInspectorOpen: vi.fn(),
        setError: vi.fn(),
        setSelectedBlock: vi.fn(),
        setSelectedRunRecord: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshLatestAutoRunSummary(project.rootPath, "canvas-main");
    });

    expect(bridge.getLatestAutoRunSummaryWithDiagnostics).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(result.current.autoRunState).toBeNull();
    expect(result.current.autoRunDiagnostics).toEqual(autoRunDiagnostics);
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
    const selectBlock = vi.fn().mockResolvedValue({ taskId: "T-ALPHA" } as DesktopBlockDetail);
    const clearSelectedBlockRecords = vi.fn();
    const setBlockInspectorOpen = vi.fn();
    const setError = vi.fn();
    const setSelectedBlock = vi.fn();
    const setSelectedRunRecord = vi.fn();
    const projectState = projectStateFixture();

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
      await result.current.openBlockInspector("T-ALPHA#B-001", "canvas-main");
    });

    expect(bridge.openTaskInspectorWindow).toHaveBeenCalledWith({
      taskId: "T-BETA",
      canvas: { projectRoot: project.rootPath, canvasId: "canvas-alt" },
      language: "zh-CN"
    });
    expect(selectBlock).toHaveBeenCalledWith("T-ALPHA#B-001", "canvas-main");
    expect(bridge.openBlockInspectorWindow).toHaveBeenCalledWith({
      blockRef: "T-ALPHA#B-001",
      canvas: { projectRoot: project.rootPath, canvasId: "canvas-main" },
      language: "zh-CN"
    });
    expect(result.current.selectedTaskPanelId).toBe("T-ALPHA");
    expect(setError).not.toHaveBeenCalled();
  });
});

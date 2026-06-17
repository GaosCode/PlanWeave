/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { AutoRunExplanation, DesktopAutoRunEvent, DesktopAutoRunState, DesktopBlockDetail, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: null,
  taskCanvases: []
};

const selectedBlock: DesktopBlockDetail = {
  ref: "T-ALPHA#B-001",
  taskId: "T-ALPHA",
  blockId: "B-001",
  type: "implementation",
  title: "Implement alpha",
  status: "ready",
  executor: null,
  effectiveExecutor: "codex",
  promptMarkdown: "# Implement alpha",
  promptMissing: false,
  promptSurfaceMarkdown: "# Effective implement alpha",
  promptSources: [],
  dependencies: [],
  latestRunId: null,
  latestReviewAttemptId: null,
  activeFeedbackId: null,
  exceptionReason: null,
  reviewGate: null
};

function explanationFor(state: Omit<DesktopAutoRunState, "explanation">): AutoRunExplanation {
  return {
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
  };
}

function autoRunState(patch: Partial<DesktopAutoRunState> = {}): DesktopAutoRunState {
  const state = {
    runId: "DESKTOP-RUN-0001",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "project" },
    phase: "running",
    stepCount: 0,
    stepLimit: 20,
    currentRef: null,
    currentExecutor: null,
    elapsedMs: 0,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    statePath: "/tmp/project/.planweave/results/auto-runs/DESKTOP-RUN-0001/state.json",
    eventLogPath: "/tmp/project/.planweave/results/auto-runs/DESKTOP-RUN-0001/events.ndjson",
    options: { tmuxEnabled: true },
    error: null,
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    ...patch
  };
  return { ...state, explanation: patch.explanation ?? explanationFor(state) };
}

function autoRunEvent(state: DesktopAutoRunState, patch: Partial<DesktopAutoRunEvent> = {}): DesktopAutoRunEvent {
  return {
    projectRoot: state.projectRoot,
    canvasId: state.canvasId,
    runId: state.runId,
    phase: state.phase,
    state,
    currentRef: state.currentRef,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    eventType: "step_started",
    triggeredAt: state.updatedAt,
    ...patch
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auto run control hook", () => {
  it("keeps selected block auto-run scope narrow", async () => {
    const runningState = autoRunState({ scope: { kind: "block", blockRef: selectedBlock.ref } });
    const bridge = createDesktopBridgeMock({
      startAutoRun: vi.fn().mockResolvedValue(runningState)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: null,
        selectedCanvasId: "canvas-main",
        selectedBlock,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: true
      })
    );

    await act(async () => {
      result.current.setAutoRunScopeMode("selectedBlock");
    });
    await act(async () => {
      await result.current.handleAutoRunClick();
    });

    expect(bridge.startAutoRun).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "block", blockRef: selectedBlock.ref },
      20,
      { tmuxEnabled: true }
    );
  });

  it("unblocks the current blocked block before retrying auto-run", async () => {
    const blockedState = autoRunState({
      phase: "blocked",
      stepCount: 1,
      currentRef: selectedBlock.ref,
      latestOutputSummary: "Executor failed",
      error: "Executor failed",
      updatedAt: "2026-05-23T00:00:01.000Z"
    });
    const runningState = autoRunState({
      runId: "DESKTOP-RUN-0002",
      startedAt: "2026-05-23T00:00:02.000Z",
      updatedAt: "2026-05-23T00:00:02.000Z"
    });
    const calls: string[] = [];
    const bridge = createDesktopBridgeMock({
      unblockBlock: vi.fn().mockImplementation(async () => {
        calls.push("unblock");
      }),
      startAutoRun: vi.fn().mockImplementation(async () => {
        calls.push("start");
        return runningState;
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      result.current.setAutoRunState(blockedState);
    });
    await act(async () => {
      await result.current.handleAutoRunClick();
    });

    expect(bridge.unblockBlock).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, selectedBlock.ref, "Retry requested from Auto Run.");
    expect(bridge.startAutoRun).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "project" },
      20,
      { tmuxEnabled: false }
    );
    expect(calls).toEqual(["unblock", "start"]);
    expect(result.current.autoRunState).toEqual(runningState);
  });

  it("updates auto-run state from matching subscription events without polling", async () => {
    const runningState = autoRunState();
    const eventState = autoRunState({
      phase: "pausing",
      stepCount: 1,
      currentRef: selectedBlock.ref,
      updatedAt: "2026-05-23T00:00:01.000Z"
    });
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      startAutoRun: vi.fn().mockResolvedValue(runningState),
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    const onAutoRunStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        onAutoRunStateRefresh,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: true
      });
    });

    await act(async () => {
      await result.current.handleAutoRunClick();
    });
    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(eventState));
    });

    expect(bridge.getAutoRunState).not.toHaveBeenCalled();
    expect(result.current.autoRunState).toEqual(eventState);
    expect(onAutoRunStateRefresh).not.toHaveBeenCalled();
  });

  it("adopts an external auto-run event when no local auto-run state exists", async () => {
    const externalRunState = autoRunState({
      runId: "DESKTOP-RUN-EXTERNAL",
      phase: "running",
      updatedAt: "2026-05-23T00:00:03.000Z"
    });
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: true
      });
    });

    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(externalRunState, { eventType: "run_started" }));
    });

    expect(bridge.onAutoRunChanged).toHaveBeenCalled();
    expect(bridge.getAutoRunState).not.toHaveBeenCalled();
    expect(result.current.autoRunState).toEqual(externalRunState);
  });

  it("adopts an external run_started event over an old settled local run", async () => {
    const oldCompletedState = autoRunState({
      runId: "DESKTOP-RUN-OLD",
      phase: "completed",
      updatedAt: "2026-05-23T00:00:02.000Z"
    });
    const externalRunState = autoRunState({
      runId: "DESKTOP-RUN-EXTERNAL",
      phase: "running",
      updatedAt: "2026-05-23T00:00:03.000Z"
    });
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(oldCompletedState);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: true
      });
    });

    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(externalRunState, { eventType: "run_started" }));
    });

    expect(bridge.getAutoRunState).not.toHaveBeenCalled();
    expect(result.current.autoRunState).toEqual(externalRunState);
  });

  it("adopts an external run_started event after the current run settles", async () => {
    const runningState = autoRunState({
      runId: "DESKTOP-RUN-CURRENT",
      phase: "running",
      updatedAt: "2026-05-23T00:00:01.000Z"
    });
    const pausedState = autoRunState({
      ...runningState,
      phase: "paused",
      updatedAt: "2026-05-23T00:00:02.000Z"
    });
    const externalRunState = autoRunState({
      runId: "DESKTOP-RUN-EXTERNAL",
      phase: "running",
      updatedAt: "2026-05-23T00:00:03.000Z"
    });
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      getAutoRunState: vi.fn(),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(runningState);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: true
      });
    });

    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(pausedState, { eventType: "phase_change" }));
    });
    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(externalRunState, { eventType: "run_started" }));
    });

    expect(bridge.getAutoRunState).not.toHaveBeenCalled();
    expect(result.current.autoRunState).toEqual(externalRunState);
  });

  it("refreshes graph data once after an auto-run event reaches a settled phase", async () => {
    const runningState = autoRunState();
    const pausedState = autoRunState({
      phase: "paused",
      stepCount: 1,
      currentRef: selectedBlock.ref,
      currentExecutor: "codex",
      elapsedMs: 1000,
      latestOutputSummary: "paused after block",
      latestRecordId: "T-ALPHA#B-001::RUN-001",
      latestRecordPath: "/tmp/metadata.json",
      updatedAt: "2026-05-23T00:00:01.000Z"
    });
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    vi.stubGlobal("planweave", createDesktopBridgeMock({
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    }));
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    const onAutoRunStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        onAutoRunStateRefresh,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: true
      });
    });

    await act(async () => {
      result.current.setAutoRunState(runningState);
    });
    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(pausedState, { eventType: "phase_change" }));
    });

    expect(onAutoRunStateRefresh).toHaveBeenCalledWith(pausedState);
  });
});

/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
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
  it("uses an initial floating control position when provided", async () => {
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: null,
        handleOpenRunRecord: vi.fn(),
        initialPosition: { left: 44, top: 55 },
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: null,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: false
      })
    );

    expect(result.current.autoRunControlStyle).toMatchObject({
      left: "clamp(12px, 44px, calc(100% - 12px))",
      top: "clamp(12px, 55px, calc(100% - 12px))"
    });
  });

  it("updates floating control position from controlled settings changes", async () => {
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result, rerender } = renderHook(
      ({ position }) =>
        useAutoRunControl({
          autoRunState: null,
          handleOpenRunRecord: vi.fn(),
          position,
          selectedCanvasId: "canvas-main",
          selectedBlock: null,
          selectedProject: null,
          selectedTaskPanelId: null,
          setAutoRunState: vi.fn(),
          setError: vi.fn(),
          t: createTranslator("zh-CN"),
          tmuxMonitoringEnabled: false
        }),
      {
        initialProps: {
          position: null as { left: number; top: number } | null
        }
      }
    );

    expect(result.current.autoRunControlStyle).toMatchObject({ right: 20, bottom: 20 });

    rerender({ position: { left: 72, top: 88 } });

    expect(result.current.autoRunControlStyle).toMatchObject({
      left: "clamp(12px, 72px, calc(100% - 12px))",
      top: "clamp(12px, 88px, calc(100% - 12px))"
    });
  });

  it("keeps a persisted floating control position reachable when the graph surface shrinks", async () => {
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    let surfaceWidth = 1000;
    let surfaceHeight = 700;
    const surface = document.createElement("div");
    const control = document.createElement("div");
    surface.setAttribute("data-graph-surface", "");
    surface.append(control);
    document.body.append(surface);
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: surfaceWidth, height: surfaceHeight, right: surfaceWidth, bottom: surfaceHeight, x: 0, y: 0, toJSON: vi.fn() })
    });
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 860, top: 600, width: 140, height: 64, right: 1000, bottom: 664, x: 860, y: 600, toJSON: vi.fn() })
    });

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: null,
        handleOpenRunRecord: vi.fn(),
        initialPosition: { left: 860, top: 600 },
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: null,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: false
      })
    );

    await act(async () => {
      result.current.autoRunControlRef(control);
    });

    await waitFor(() => {
      expect(result.current.autoRunControlStyle).toMatchObject({ left: "848px", top: "600px" });
    });

    surfaceWidth = 420;
    surfaceHeight = 240;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(result.current.autoRunControlStyle).toMatchObject({ left: "268px", top: "164px" });
    });
  });

  it("clamps floating control drag position and commits it when dragging stops", async () => {
    const onPositionCommit = vi.fn();
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const surface = document.createElement("div");
    const control = document.createElement("div");
    const button = document.createElement("button");
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 500, height: 300, right: 500, bottom: 300, x: 0, y: 0, toJSON: vi.fn() })
    });
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 900, top: 900, width: 100, height: 50, right: 1000, bottom: 950, x: 900, y: 900, toJSON: vi.fn() })
    });
    Object.defineProperty(button, "closest", {
      configurable: true,
      value: (selector: string) => {
        if (selector === "[data-auto-run-control]") {
          return control;
        }
        if (selector === "[data-graph-surface]") {
          return surface;
        }
        return null;
      }
    });
    Object.defineProperty(button, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(button, "hasPointerCapture", { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(button, "releasePointerCapture", { configurable: true, value: vi.fn() });

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: null,
        handleOpenRunRecord: vi.fn(),
        initialPosition: { left: 900, top: 900 },
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: null,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: false,
        onPositionCommit
      })
    );

    const startEvent = {
      clientX: 910,
      clientY: 910,
      currentTarget: button,
      pointerId: 7
    } as React.PointerEvent<HTMLButtonElement>;
    const moveEvent = {
      clientX: 800,
      clientY: 600,
      currentTarget: button,
      pointerId: 7
    } as React.PointerEvent<HTMLButtonElement>;

    await act(async () => {
      result.current.startAutoRunControlDrag(startEvent);
    });
    await act(async () => {
      result.current.moveAutoRunControl(moveEvent);
    });

    expect(result.current.autoRunControlStyle).toMatchObject({
      left: "clamp(12px, 388px, calc(100% - 12px))",
      top: "clamp(12px, 238px, calc(100% - 12px))"
    });
    expect(onPositionCommit).not.toHaveBeenCalled();

    await act(async () => {
      result.current.stopAutoRunControlDrag(moveEvent);
    });

    expect(onPositionCommit).toHaveBeenCalledWith({ left: 388, top: 238 });
    expect(button.releasePointerCapture).toHaveBeenCalledWith(7);
  });

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
        handleOpenRunRecord: vi.fn(),
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
        handleOpenRunRecord: vi.fn(),
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

  it("keeps manual Auto Run state waiting for manual submission instead of starting a new run", async () => {
    const manualState = autoRunState({
      phase: "manual",
      currentRef: selectedBlock.ref,
      currentExecutor: "manual",
      error: "Manual result required.",
      explanation: {
        phase: "manual",
        currentRef: selectedBlock.ref,
        currentExecutor: "manual",
        latestRecordId: null,
        latestRecordPath: null,
        latestOutputSummary: "planweave submit-result T-ALPHA#B-001 --report <report.md>",
        error: "Manual result required.",
        nextAction: {
          kind: "submit_manual_result",
          message: "Complete the manual step, then submit the result.",
          command: "planweave submit-result T-ALPHA#B-001 --report <report.md>",
          targetPath: null,
          ref: selectedBlock.ref
        }
      }
    });
    const bridge = createDesktopBridgeMock({
      startAutoRun: vi.fn()
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: manualState,
        handleOpenRunRecord: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedBlock,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: createTranslator("zh-CN"),
        tmuxMonitoringEnabled: false
      })
    );

    await act(async () => {
      await result.current.handleAutoRunClick();
    });

    expect(bridge.startAutoRun).not.toHaveBeenCalled();
    expect(result.current.autoRunState).toEqual(manualState);
  });

  it("copies manual submit commands from the next action without submitting", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard });
    const manualState = autoRunState({
      phase: "manual",
      currentRef: selectedBlock.ref,
      currentExecutor: "manual",
      latestOutputSummary: "planweave submit-result T-ALPHA#B-001 --report report.md",
      explanation: {
        phase: "manual",
        currentRef: selectedBlock.ref,
        currentExecutor: "manual",
        latestRecordId: null,
        latestRecordPath: null,
        latestOutputSummary: "planweave submit-result T-ALPHA#B-001 --report report.md",
        error: "Manual result required.",
        nextAction: {
          kind: "submit_manual_result",
          message: "Complete the manual step, then submit the result.",
          command: "planweave submit-result T-ALPHA#B-001 --report report.md",
          targetPath: null,
          ref: selectedBlock.ref
        }
      }
    });
    const bridge = createDesktopBridgeMock({
      startAutoRun: vi.fn()
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: manualState,
        handleOpenRunRecord: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedBlock,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      })
    );

    expect(result.current.autoRunNextAction).toMatchObject({
      command: "copy_manual_command",
      enabled: true,
      manualCommand: "planweave submit-result T-ALPHA#B-001 --report report.md"
    });
    await act(async () => {
      await result.current.handleAutoRunNextAction(result.current.autoRunNextAction!);
    });

    expect(clipboard.writeText).toHaveBeenCalledWith("planweave submit-result T-ALPHA#B-001 --report report.md");
    expect(bridge.startAutoRun).not.toHaveBeenCalled();
  });

  it("resumes paused auto-run from the next action descriptor", async () => {
    const pausedState = autoRunState({
      phase: "paused",
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
      }
    });
    const runningState = autoRunState({ phase: "running" });
    const bridge = createDesktopBridgeMock({
      resumeAutoRun: vi.fn().mockResolvedValue(runningState)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(pausedState);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        handleOpenRunRecord: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      await result.current.handleAutoRunNextAction(result.current.autoRunNextAction!);
    });

    expect(bridge.resumeAutoRun).toHaveBeenCalledWith(pausedState.runId);
    expect(result.current.autoRunState).toEqual(runningState);
  });

  it("resets runtime state through the desktop bridge after confirmation", async () => {
    const pausedState = autoRunState({ phase: "manual", currentRef: selectedBlock.ref, currentExecutor: "manual" });
    const resetRuntimeState = vi.fn().mockResolvedValue({
      session: { sessionId: "SESSION-0001" },
      stoppedAutoRunIds: [pausedState.runId]
    });
    const bridge = createDesktopBridgeMock({ resetRuntimeState });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    const onAutoRunDerivedStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(pausedState);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        handleOpenRunRecord: vi.fn(),
        onAutoRunDerivedStateRefresh,
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      await result.current.resetRuntimeStateClick();
    });

    expect(confirm).toHaveBeenCalledWith("Reset runtime state for this canvas? This clears current claims, feedback, and review progress. Existing records stay on disk.");
    expect(resetRuntimeState).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { force: true, reason: "Desktop reset requested." }
    );
    expect(result.current.autoRunState).toBeNull();
    expect(onAutoRunDerivedStateRefresh).toHaveBeenCalledTimes(1);
  });

  it("blocks runtime reset while an Auto Run step is active", async () => {
    const runningState = autoRunState({ phase: "running" });
    const resetRuntimeState = vi.fn();
    const bridge = createDesktopBridgeMock({ resetRuntimeState });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const setError = vi.fn();
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: runningState,
        handleOpenRunRecord: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError,
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      })
    );

    await act(async () => {
      await result.current.resetRuntimeStateClick();
    });

    expect(setError).toHaveBeenCalledWith("Stop Auto Run and wait for the current step to settle before resetting runtime state.");
    expect(confirm).not.toHaveBeenCalled();
    expect(resetRuntimeState).not.toHaveBeenCalled();
  });

  it("loads retrospective only for non-active auto-run states", async () => {
    const runningState = autoRunState({ phase: "running", runId: "DESKTOP-RUN-ACTIVE" });
    const blockedState = autoRunState({
      phase: "blocked",
      runId: "DESKTOP-RUN-BLOCKED",
      currentRef: selectedBlock.ref
    });
    const getAutoRunRetrospective = vi.fn().mockResolvedValue({
      runId: blockedState.runId,
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      phase: "blocked",
      scope: { kind: "project" },
      startedAt: blockedState.startedAt,
      updatedAt: blockedState.updatedAt,
      elapsedMs: 0,
      stepCount: 1,
      completedBlockRefs: [],
      blockedRef: selectedBlock.ref,
      failedReason: "blocked",
      reviewVerdicts: [],
      latestRecordId: null,
      latestRecordPath: null,
      latestReportPath: null,
      nextAction: blockedState.explanation.nextAction,
      diagnostics: []
    });
    const bridge = createDesktopBridgeMock({
      getAutoRunRetrospective,
      getLatestAutoRunRetrospective: vi.fn()
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { rerender, result } = renderHook(
      ({ state }) =>
        useAutoRunControl({
          autoRunState: state,
          handleOpenRunRecord: vi.fn(),
          selectedCanvasId: "canvas-main",
          selectedBlock: null,
          selectedProject: project,
          selectedTaskPanelId: null,
          setAutoRunState: vi.fn(),
          setError: vi.fn(),
          t: createTranslator("en"),
          tmuxMonitoringEnabled: false
        }),
      { initialProps: { state: runningState } }
    );

    expect(getAutoRunRetrospective).not.toHaveBeenCalled();
    expect(result.current.autoRunRetrospective).toBeNull();

    rerender({ state: blockedState });

    await waitFor(() => {
      expect(getAutoRunRetrospective).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, blockedState.runId);
      expect(result.current.autoRunRetrospective?.runId).toBe(blockedState.runId);
    });
  });

  it("opens an internal run record before falling back to revealing the record path", async () => {
    const failedState = autoRunState({
      phase: "failed",
      latestRecordId: "T-ALPHA#B-001::RUN-FAILED",
      latestRecordPath: "/tmp/record.json",
      explanation: {
        phase: "failed",
        currentRef: selectedBlock.ref,
        currentExecutor: "codex",
        latestRecordId: "T-ALPHA#B-001::RUN-FAILED",
        latestRecordPath: "/tmp/record.json",
        latestOutputSummary: "failed",
        error: "failed",
        nextAction: {
          kind: "inspect_record",
          message: "Inspect the latest run record.",
          command: null,
          targetPath: "/tmp/record.json",
          ref: selectedBlock.ref
        }
      }
    });
    const handleOpenRunRecord = vi.fn().mockResolvedValue(undefined);
    const bridge = createDesktopBridgeMock({
      revealPathInFinder: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");

    const { result, rerender } = renderHook(
      ({ state }) =>
        useAutoRunControl({
          autoRunState: state,
          handleOpenRunRecord,
          selectedCanvasId: "canvas-main",
          selectedBlock: null,
          selectedProject: project,
          selectedTaskPanelId: null,
          setAutoRunState: vi.fn(),
          setError: vi.fn(),
          t: createTranslator("en"),
          tmuxMonitoringEnabled: false
        }),
      { initialProps: { state: failedState } }
    );

    await act(async () => {
      await result.current.handleAutoRunNextAction(result.current.autoRunNextAction!);
    });
    expect(handleOpenRunRecord).toHaveBeenCalledWith("T-ALPHA#B-001::RUN-FAILED", "canvas-main");
    expect(bridge.revealPathInFinder).not.toHaveBeenCalled();

    const pathOnlyState = autoRunState({
      phase: "failed",
      latestRecordId: null,
      latestRecordPath: "/tmp/record.json",
      explanation: {
        phase: "failed",
        currentRef: selectedBlock.ref,
        currentExecutor: "codex",
        latestRecordId: null,
        latestRecordPath: "/tmp/record.json",
        latestOutputSummary: "failed",
        error: "failed",
        nextAction: {
          kind: "inspect_record",
          message: "Inspect the latest run record.",
          command: null,
          targetPath: "/tmp/record.json",
          ref: selectedBlock.ref
        }
      }
    });
    rerender({ state: pathOnlyState });

    await act(async () => {
      await result.current.handleAutoRunNextAction(result.current.autoRunNextAction!);
    });
    expect(bridge.revealPathInFinder).toHaveBeenCalledWith("/tmp/record.json");
  });

  it("retries a blocked ref from resolve_error by unblocking and starting that block", async () => {
    const blockedState = autoRunState({
      phase: "blocked",
      currentRef: selectedBlock.ref,
      explanation: {
        phase: "blocked",
        currentRef: selectedBlock.ref,
        currentExecutor: "codex",
        latestRecordId: null,
        latestRecordPath: null,
        latestOutputSummary: null,
        error: "blocked",
        nextAction: {
          kind: "resolve_error",
          message: "Resolve the reported Auto Run error before retrying.",
          command: null,
          targetPath: null,
          ref: selectedBlock.ref
        }
      }
    });
    const runningState = autoRunState({ phase: "running", scope: { kind: "block", blockRef: selectedBlock.ref } });
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
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(blockedState);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        handleOpenRunRecord: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError: vi.fn(),
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      await result.current.handleAutoRunNextAction(result.current.autoRunNextAction!);
    });

    expect(bridge.unblockBlock).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, selectedBlock.ref, "Retry requested from Auto Run.");
    expect(bridge.startAutoRun).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "block", blockRef: selectedBlock.ref },
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
    const onAutoRunDerivedStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        handleOpenRunRecord: vi.fn(),
        onAutoRunDerivedStateRefresh,
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
    expect(onAutoRunDerivedStateRefresh).not.toHaveBeenCalled();
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
        handleOpenRunRecord: vi.fn(),
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
        handleOpenRunRecord: vi.fn(),
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
        handleOpenRunRecord: vi.fn(),
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
    const onAutoRunDerivedStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        handleOpenRunRecord: vi.fn(),
        onAutoRunDerivedStateRefresh,
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

    expect(onAutoRunDerivedStateRefresh).toHaveBeenCalledTimes(1);
  });
});

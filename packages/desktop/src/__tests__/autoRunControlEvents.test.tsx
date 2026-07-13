/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { DesktopAutoRunState } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRunEvent,
  autoRunState,
  cleanupAutoRunControlTestEnvironment,
  createAutoRunChangedBridge,
  createTranslator,
  loadAutoRunControl,
  project,
  selectedBlock,
  stubAutoRunControlBridge
} from "./helpers/autoRunControlHarness";

afterEach(() => {
  cleanupAutoRunControlTestEnvironment();
});

describe("auto run control hook events", () => {
  it("updates auto-run state from matching subscription events without polling", async () => {
    const runningState = autoRunState();
    const eventState = autoRunState({
      phase: "pausing",
      stepCount: 1,
      currentRef: selectedBlock.ref,
      updatedAt: "2026-05-23T00:00:01.000Z"
    });
    const { bridge, emitAutoRunEvent } = createAutoRunChangedBridge({
      startAutoRun: vi.fn().mockResolvedValue(runningState),
      getAutoRunState: vi.fn()
    });
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();
    const onAutoRunDerivedStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        openRunWorkspace: vi.fn(),
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
      emitAutoRunEvent(autoRunEvent(eventState));
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
    const { bridge, emitAutoRunEvent } = createAutoRunChangedBridge({
      getAutoRunState: vi.fn()
    });
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        openRunWorkspace: vi.fn(),
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
      emitAutoRunEvent(autoRunEvent(externalRunState, { eventType: "run_started" }));
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
    const { bridge, emitAutoRunEvent } = createAutoRunChangedBridge({
      getAutoRunState: vi.fn()
    });
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(
        oldCompletedState
      );
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        openRunWorkspace: vi.fn(),
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
      emitAutoRunEvent(autoRunEvent(externalRunState, { eventType: "run_started" }));
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
    const { bridge, emitAutoRunEvent } = createAutoRunChangedBridge({
      getAutoRunState: vi.fn()
    });
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(
        runningState
      );
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        openRunWorkspace: vi.fn(),
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
      emitAutoRunEvent(autoRunEvent(pausedState, { eventType: "phase_change" }));
    });
    await act(async () => {
      emitAutoRunEvent(autoRunEvent(externalRunState, { eventType: "run_started" }));
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
    const { bridge, emitAutoRunEvent } = createAutoRunChangedBridge();
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();
    const onAutoRunDerivedStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
      return useAutoRunControl({
        autoRunState: autoRunStateValue,
        openRunWorkspace: vi.fn(),
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
      emitAutoRunEvent(autoRunEvent(pausedState, { eventType: "phase_change" }));
    });

    expect(onAutoRunDerivedStateRefresh).toHaveBeenCalledTimes(1);
  });
});

/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import type { DesktopAutoRunState } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRunState,
  cleanupAutoRunControlTestEnvironment,
  createDesktopBridgeMock,
  createTranslator,
  loadAutoRunControl,
  project,
  selectedBlock,
  stubAutoRunControlBridge
} from "./helpers/autoRunControlHarness";

afterEach(() => {
  cleanupAutoRunControlTestEnvironment();
});

describe("auto run control hook actions", () => {
  it("keeps selected block auto-run scope narrow", async () => {
    const runningState = autoRunState({ scope: { kind: "block", blockRef: selectedBlock.ref } });
    const bridge = createDesktopBridgeMock({
      startAutoRun: vi.fn().mockResolvedValue(runningState)
    });
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: null,
        openRunWorkspace: vi.fn(),
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
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      result.current.setAutoRunState(blockedState);
    });
    await act(async () => {
      await result.current.handleAutoRunClick();
    });

    expect(bridge.unblockBlock).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      selectedBlock.ref,
      "Retry requested from Auto Run."
    );
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
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: manualState,
        openRunWorkspace: vi.fn(),
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
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: manualState,
        openRunWorkspace: vi.fn(),
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

    expect(clipboard.writeText).toHaveBeenCalledWith(
      "planweave submit-result T-ALPHA#B-001 --report report.md"
    );
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
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(
        pausedState
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
    const pausedState = autoRunState({
      phase: "manual",
      currentRef: selectedBlock.ref,
      currentExecutor: "manual"
    });
    const resetRuntimeState = vi.fn().mockResolvedValue({
      session: { sessionId: "SESSION-0001" },
      stoppedAutoRunIds: [pausedState.runId]
    });
    const bridge = createDesktopBridgeMock({ resetRuntimeState });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();
    const onAutoRunDerivedStateRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(
        pausedState
      );
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
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      await result.current.resetRuntimeStateClick();
    });

    expect(confirm).toHaveBeenCalledWith(
      "Reset runtime state for this canvas? This clears current claims, feedback, and review progress. Existing records stay on disk."
    );
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
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: runningState,
        openRunWorkspace: vi.fn(),
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

    expect(setError).toHaveBeenCalledWith(
      "Stop Auto Run and wait for the current step to settle before resetting runtime state."
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(resetRuntimeState).not.toHaveBeenCalled();
  });

  it("opens an internal run record before falling back to revealing the record path", async () => {
    const failedState = autoRunState({
      projectRoot: "/tmp/authority-project",
      canvasId: "canvas-authority",
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
    const openRunWorkspace = vi.fn().mockResolvedValue(undefined);
    const bridge = createDesktopBridgeMock({
      revealPathInFinder: vi.fn().mockResolvedValue(undefined)
    });
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result, rerender } = renderHook(
      ({ state }) =>
        useAutoRunControl({
          autoRunState: state,
          openRunWorkspace,
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
    expect(openRunWorkspace).toHaveBeenCalledWith({
      projectRoot: "/tmp/authority-project",
      canvasId: "canvas-authority",
      recordId: "T-ALPHA#B-001::RUN-FAILED"
    });
    expect(bridge.revealPathInFinder).not.toHaveBeenCalled();

    const rootCanvasState = autoRunState({
      canvasId: null,
      phase: "failed",
      latestRecordId: "T-ALPHA#B-001::RUN-ROOT",
      latestRecordPath: "/tmp/root-record.json",
      explanation: {
        phase: "failed",
        currentRef: selectedBlock.ref,
        currentExecutor: "codex",
        latestRecordId: "T-ALPHA#B-001::RUN-ROOT",
        latestRecordPath: "/tmp/root-record.json",
        latestOutputSummary: "failed",
        error: "failed",
        nextAction: {
          kind: "inspect_record",
          message: "Inspect the latest run record.",
          command: null,
          targetPath: "/tmp/root-record.json",
          ref: selectedBlock.ref
        }
      }
    });
    rerender({ state: rootCanvasState });
    await act(async () => {
      await result.current.handleAutoRunNextAction(result.current.autoRunNextAction!);
    });
    expect(bridge.revealPathInFinder).toHaveBeenCalledWith("/tmp/root-record.json");
    expect(openRunWorkspace).toHaveBeenCalledTimes(1);

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
    const runningState = autoRunState({
      phase: "running",
      scope: { kind: "block", blockRef: selectedBlock.ref }
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
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() => {
      const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(
        blockedState
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
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      });
    });

    await act(async () => {
      await result.current.handleAutoRunNextAction(result.current.autoRunNextAction!);
    });

    expect(bridge.unblockBlock).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      selectedBlock.ref,
      "Retry requested from Auto Run."
    );
    expect(bridge.startAutoRun).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "block", blockRef: selectedBlock.ref },
      20,
      { tmuxEnabled: false }
    );
    expect(calls).toEqual(["unblock", "start"]);
    expect(result.current.autoRunState).toEqual(runningState);
  });
});

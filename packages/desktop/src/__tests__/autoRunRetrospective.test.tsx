/* @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
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

describe("auto run control hook retrospective", () => {
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
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();

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
      expect(getAutoRunRetrospective).toHaveBeenCalledWith(
        { projectRoot: project.rootPath, canvasId: "canvas-main" },
        blockedState.runId
      );
      expect(result.current.autoRunRetrospective?.runId).toBe(blockedState.runId);
    });
  });

  it("clears stale auto-run state when retrospective state was deleted", async () => {
    const blockedState = autoRunState({
      phase: "blocked",
      runId: "DESKTOP-RUN-0008",
      currentRef: selectedBlock.ref
    });
    const getAutoRunRetrospective = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'planweave:getAutoRunRetrospective': Error: Auto Run 'DESKTOP-RUN-0008' could not be read: auto_run_state_missing: /tmp/demo/results/auto-runs/DESKTOP-RUN-0008/state.json: Auto Run state '/tmp/demo/results/auto-runs/DESKTOP-RUN-0008/state.json' does not exist."
        )
      );
    const bridge = createDesktopBridgeMock({
      getAutoRunRetrospective,
      getLatestAutoRunRetrospective: vi.fn()
    });
    stubAutoRunControlBridge(bridge);
    const { useAutoRunControl } = await loadAutoRunControl();
    const setAutoRunState = vi.fn();
    const setError = vi.fn();

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: blockedState,
        handleOpenRunRecord: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState,
        setError,
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      })
    );

    await waitFor(() =>
      expect(getAutoRunRetrospective).toHaveBeenCalledWith(
        { projectRoot: project.rootPath, canvasId: "canvas-main" },
        blockedState.runId
      )
    );
    await waitFor(() => expect(setAutoRunState).toHaveBeenCalledWith(null));
    expect(result.current.autoRunRetrospective).toBeNull();
    expect(setError).not.toHaveBeenCalled();
  });
});

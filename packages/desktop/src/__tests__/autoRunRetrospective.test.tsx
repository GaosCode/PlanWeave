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
          openRunWorkspace: vi.fn(),
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
        openRunWorkspace: vi.fn(),
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

  it("loads the latest effective retrospective after a completed no-work run", async () => {
    const noWorkState = autoRunState({
      phase: "completed",
      runId: "DESKTOP-RUN-0002",
      runSessionId: "SESSION-0002",
      stepCount: 0,
      latestOutputSummary: "no_claimable_blocks"
    });
    const effectiveRetrospective = {
      runId: "DESKTOP-RUN-0001",
      runSessionId: "SESSION-0001",
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      phase: "completed" as const,
      scope: { kind: "project" as const },
      startedAt: noWorkState.startedAt,
      updatedAt: noWorkState.updatedAt,
      elapsedMs: 164_000,
      stepCount: 4,
      completedBlockRefs: [selectedBlock.ref],
      blockedRef: null,
      failedReason: null,
      reviewVerdicts: [],
      latestRecordId: "T-ALPHA#B-001::RUN-001",
      latestRecordPath: "/tmp/metadata.json",
      latestReportPath: "/tmp/report.md",
      nextAction: noWorkState.explanation.nextAction,
      diagnostics: []
    };
    const getAutoRunRetrospective = vi.fn();
    const getLatestAutoRunRetrospective = vi.fn().mockResolvedValue(effectiveRetrospective);
    stubAutoRunControlBridge(
      createDesktopBridgeMock({
        getAutoRunRetrospective,
        getLatestAutoRunRetrospective
      })
    );
    const { useAutoRunControl } = await loadAutoRunControl();

    const { result } = renderHook(() =>
      useAutoRunControl({
        autoRunState: noWorkState,
        openRunWorkspace: vi.fn(),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setAutoRunState: vi.fn(),
        setError: vi.fn(),
        t: createTranslator("en"),
        tmuxMonitoringEnabled: false
      })
    );

    await waitFor(() =>
      expect(result.current.autoRunRetrospective).toEqual(effectiveRetrospective)
    );
    expect(getLatestAutoRunRetrospective).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(getAutoRunRetrospective).not.toHaveBeenCalled();
  });
});

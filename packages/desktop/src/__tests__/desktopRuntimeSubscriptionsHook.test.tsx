/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopGraphViewModel, ValidationIssue } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

async function flushAsyncEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

async function settleMockCalls(mock: ReturnType<typeof vi.fn>): Promise<void> {
  let stableTicks = 0;
  for (let index = 0; index < 20; index += 1) {
    const callCount = mock.mock.calls.length;
    await act(async () => {
      await flushAsyncEffects();
    });
    if (mock.mock.calls.length === callCount) {
      stableTicks += 1;
      if (stableTicks >= 3) {
        return;
      }
    } else {
      stableTicks = 0;
    }
  }
}

describe("desktop runtime subscriptions hook", () => {
  it("polls lightweight runtime state for external runtime updates", async () => {
    vi.useFakeTimers();
    try {
      const runtimeDiagnostic: ValidationIssue = {
        code: "auto_run_state_invalid_json",
        message: "Auto Run state could not be parsed.",
        path: "/tmp/demo/results/auto-runs/DESKTOP-RUN-0002/state.json"
      };
      const getDesktopProjectSnapshot = vi.fn().mockResolvedValue(projectSnapshot());
      const getDesktopRuntimeRefresh = vi.fn().mockResolvedValue({
        latestAutoRun: null,
        diagnostics: [runtimeDiagnostic],
        errors: ["Auto Run state could not be parsed."]
      });
      const bridge = createDesktopBridgeMock({
        listProjects: vi.fn().mockResolvedValueOnce([project]).mockResolvedValue([]),
        getDesktopProjectSnapshot,
        getDesktopRuntimeRefresh,
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

      await act(async () => {
        for (let index = 0; index < 4; index += 1) {
          await flushAsyncEffects();
        }
      });
      expect(result.current.graph?.graphVersion).toBe(graph.graphVersion);
      expect(result.current.selectedProject?.projectId).toBe(project.projectId);
      await settleMockCalls(getDesktopProjectSnapshot);
      getDesktopProjectSnapshot.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await flushAsyncEffects();
      });

      expect(getDesktopRuntimeRefresh).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
      expect(getDesktopProjectSnapshot).not.toHaveBeenCalled();
      expect(result.current.runtimeDiagnostics).toEqual([runtimeDiagnostic]);
      expect(setError).toHaveBeenCalledWith("Auto Run state could not be parsed.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes only the graph when the current canvas runtime state changes", async () => {
    let runtimeStateChangedCallback: ((event: {
      projectRoot: string;
      canvasId: string | null;
      stateFile: string;
      changedAt: string;
    }) => void) | null = null;
    const refreshedGraph: DesktopGraphViewModel = {
      ...graph,
      graphVersion: "pgv-runtime-state-event"
    };
    const getDesktopProjectSnapshot = vi.fn().mockResolvedValue(projectSnapshot());
    const getGraphViewModel = vi.fn().mockResolvedValue(refreshedGraph);
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValueOnce([project]).mockResolvedValue([]),
      getDesktopProjectSnapshot,
      getGraphViewModel,
      onRuntimeStateChanged: vi.fn((callback) => {
        runtimeStateChangedCallback = callback;
        return () => undefined;
      }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined),
      watchRuntimeState: vi.fn().mockResolvedValue(undefined)
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

    await waitFor(() => expect(result.current.graph?.graphVersion).toBe(graph.graphVersion));
    await waitFor(() => expect(runtimeStateChangedCallback).not.toBeNull());
    await settleMockCalls(getDesktopProjectSnapshot);
    getDesktopProjectSnapshot.mockClear();

    await act(async () => {
      runtimeStateChangedCallback?.({
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        stateFile: "/tmp/demo/canvases/canvas-main/state.json",
        changedAt: "2026-06-16T00:00:01.000Z"
      });
      await flushAsyncEffects();
    });

    expect(getGraphViewModel).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(getDesktopProjectSnapshot).not.toHaveBeenCalled();
    expect(result.current.graph?.graphVersion).toBe("pgv-runtime-state-event");
  });
});

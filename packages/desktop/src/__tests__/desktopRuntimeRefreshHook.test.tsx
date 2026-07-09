/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type {
  DesktopAutoRunState,
  DesktopProjectSummary,
  ValidationIssue
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

async function flushAsyncEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

async function settleRendererUpdates(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await flushAsyncEffects();
    });
  }
}

const otherProject: DesktopProjectSummary = {
  ...project,
  projectId: "P-002",
  name: "Other project",
  rootPath: "/tmp/other-demo",
  workspaceRoot: "/tmp/other-demo"
};

function latestAutoRunState(patch: Partial<DesktopAutoRunState> = {}): DesktopAutoRunState {
  const base: DesktopAutoRunState = {
    runId: "RUN-LIGHTWEIGHT",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "project" },
    phase: "completed",
    stepCount: 2,
    stepLimit: 20,
    currentRef: null,
    currentExecutor: null,
    elapsedMs: 125,
    latestOutputSummary: "Auto Run completed.",
    latestRecordId: "REC-001",
    latestRecordPath: "/tmp/demo/results/RUN-LIGHTWEIGHT/metadata.json",
    explanation: {
      phase: "completed",
      currentRef: null,
      currentExecutor: null,
      latestRecordId: "REC-001",
      latestRecordPath: "/tmp/demo/results/RUN-LIGHTWEIGHT/metadata.json",
      latestOutputSummary: "Auto Run completed.",
      error: null,
      nextAction: {
        kind: "review_status",
        message: "Review the latest Auto Run status.",
        command: null,
        targetPath: null,
        ref: null
      }
    },
    statePath: "/tmp/demo/results/auto-runs/RUN-LIGHTWEIGHT/state.json",
    eventLogPath: "/tmp/demo/results/auto-runs/RUN-LIGHTWEIGHT/events.ndjson",
    options: { tmuxEnabled: true },
    error: null,
    startedAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:05.000Z"
  };
  return { ...base, ...patch };
}

describe("desktop runtime refresh hook integration", () => {
  it("updates Auto Run state from lightweight runtime refresh without loading a full project snapshot", async () => {
    vi.useFakeTimers();
    try {
      const latestAutoRun = latestAutoRunState();
      const getDesktopProjectSnapshot = vi.fn().mockResolvedValue(projectSnapshot());
      const getDesktopRuntimeRefresh = vi.fn().mockResolvedValue({
        latestAutoRun,
        diagnostics: [],
        errors: []
      });
      const bridge = createDesktopBridgeMock({
        listProjects: vi.fn().mockResolvedValue([project]),
        getDesktopProjectSnapshot,
        getDesktopRuntimeRefresh,
        getLatestAutoRunSummaryWithDiagnostics: vi
          .fn()
          .mockResolvedValue({ state: null, diagnostics: [] }),
        refreshPackageFileChanges: vi
          .fn()
          .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
        watchPackageFiles: vi.fn().mockResolvedValue(undefined),
        watchRuntimeState: vi.fn().mockResolvedValue(undefined)
      });
      vi.stubGlobal("planweave", bridge);
      vi.resetModules();
      const clearSelectedBlockRecords = vi.fn();
      const selectBlock = vi.fn().mockResolvedValue(undefined);
      const setActiveView = vi.fn();
      const setBlockInspectorOpen = vi.fn();
      const setError = vi.fn();
      const setSelectedBlock = vi.fn();
      const setSelectedRunRecord = vi.fn();
      const updateSettings = vi.fn();
      const [{ useDesktopProject }, { useDesktopProjectSession }] = await Promise.all([
        import("../renderer/hooks/useDesktopProject"),
        import("../renderer/hooks/useDesktopProjectSession")
      ]);

      const { result } = renderHook(() => {
        const projectState = useDesktopProject({
          setError,
          t: createTranslator("en"),
          updateSettings
        });
        return useDesktopProjectSession({
          clearSelectedBlockRecords,
          language: "en",
          projectState,
          selectBlock,
          setActiveView,
          setBlockInspectorOpen,
          setError,
          setSelectedBlock,
          setSelectedRunRecord
        });
      });

      await settleRendererUpdates();
      expect(result.current.selectedProject?.projectId).toBe(project.projectId);
      expect(result.current.graph?.graphVersion).toBe(projectSnapshot().graph.graphVersion);
      getDesktopProjectSnapshot.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await flushAsyncEffects();
      });
      await settleRendererUpdates();

      expect(result.current.autoRunState?.runId).toBe("RUN-LIGHTWEIGHT");
      expect(getDesktopRuntimeRefresh).toHaveBeenCalledWith({
        projectRoot: project.rootPath,
        canvasId: "canvas-main"
      });
      expect(result.current.autoRunState).toBe(latestAutoRun);
      expect(getDesktopProjectSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale lightweight runtime refresh responses after switching projects", async () => {
    vi.useFakeTimers();
    try {
      const staleDiagnostic: ValidationIssue = {
        code: "auto_run_state_invalid_json",
        message: "Stale Auto Run state could not be parsed.",
        path: "/tmp/demo/results/auto-runs/RUN-STALE/state.json"
      };
      const staleRefresh = deferred<{
        latestAutoRun: DesktopAutoRunState | null;
        diagnostics: ValidationIssue[];
        errors: string[];
      }>();
      const getDesktopProjectSnapshot = vi.fn().mockResolvedValue(projectSnapshot());
      const getDesktopRuntimeRefresh = vi.fn().mockReturnValueOnce(staleRefresh.promise);
      const bridge = createDesktopBridgeMock({
        listProjects: vi.fn().mockResolvedValue([project, otherProject]),
        getDesktopProjectSnapshot,
        getDesktopRuntimeRefresh,
        getLatestAutoRunSummaryWithDiagnostics: vi
          .fn()
          .mockResolvedValue({ state: null, diagnostics: [] }),
        refreshPackageFileChanges: vi
          .fn()
          .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
        selectTaskCanvas: vi.fn().mockResolvedValue("canvas-main"),
        watchPackageFiles: vi.fn().mockResolvedValue(undefined),
        watchRuntimeState: vi.fn().mockResolvedValue(undefined)
      });
      vi.stubGlobal("planweave", bridge);
      vi.resetModules();
      const clearSelectedBlockRecords = vi.fn();
      const selectBlock = vi.fn().mockResolvedValue(undefined);
      const setActiveView = vi.fn();
      const setBlockInspectorOpen = vi.fn();
      const setError = vi.fn();
      const setSelectedBlock = vi.fn();
      const setSelectedRunRecord = vi.fn();
      const updateSettings = vi.fn();
      const [{ useDesktopProject }, { useDesktopProjectSession }] = await Promise.all([
        import("../renderer/hooks/useDesktopProject"),
        import("../renderer/hooks/useDesktopProjectSession")
      ]);

      const { result } = renderHook(() => {
        const projectState = useDesktopProject({
          setError,
          t: createTranslator("en"),
          updateSettings
        });
        return useDesktopProjectSession({
          clearSelectedBlockRecords,
          language: "en",
          projectState,
          selectBlock,
          setActiveView,
          setBlockInspectorOpen,
          setError,
          setSelectedBlock,
          setSelectedRunRecord
        });
      });

      await settleRendererUpdates();
      expect(result.current.selectedProject?.projectId).toBe(project.projectId);

      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await flushAsyncEffects();
      });
      expect(getDesktopRuntimeRefresh).toHaveBeenCalledWith({
        projectRoot: project.rootPath,
        canvasId: "canvas-main"
      });

      await act(async () => {
        await result.current.openProject(otherProject, "canvas-main");
      });
      await settleRendererUpdates();
      expect(result.current.selectedProject?.projectId).toBe(otherProject.projectId);

      await act(async () => {
        staleRefresh.resolve({
          latestAutoRun: latestAutoRunState({ runId: "RUN-STALE" }),
          diagnostics: [staleDiagnostic],
          errors: [staleDiagnostic.message]
        });
        await staleRefresh.promise;
        await flushAsyncEffects();
      });
      await settleRendererUpdates();

      expect(result.current.selectedProject?.projectId).toBe(otherProject.projectId);
      expect(result.current.autoRunState).toBeNull();
      expect(result.current.autoRunDiagnostics).toEqual([]);
      expect(setError).not.toHaveBeenCalledWith(staleDiagnostic.message);
      expect(getDesktopProjectSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale lightweight runtime refresh responses while project switching is still loading", async () => {
    vi.useFakeTimers();
    try {
      const staleDiagnostic: ValidationIssue = {
        code: "auto_run_state_invalid_json",
        message: "Pending switch stale Auto Run state could not be parsed.",
        path: "/tmp/demo/results/auto-runs/RUN-PENDING-STALE/state.json"
      };
      const staleRefresh = deferred<{
        latestAutoRun: DesktopAutoRunState | null;
        diagnostics: ValidationIssue[];
        errors: string[];
      }>();
      const pendingProjectSnapshot = deferred<ReturnType<typeof projectSnapshot>>();
      const getDesktopProjectSnapshot = vi
        .fn()
        .mockResolvedValueOnce(projectSnapshot())
        .mockReturnValueOnce(pendingProjectSnapshot.promise);
      const getDesktopRuntimeRefresh = vi.fn().mockReturnValueOnce(staleRefresh.promise);
      const bridge = createDesktopBridgeMock({
        listProjects: vi.fn().mockResolvedValue([project, otherProject]),
        getDesktopProjectSnapshot,
        getDesktopRuntimeRefresh,
        getLatestAutoRunSummaryWithDiagnostics: vi
          .fn()
          .mockResolvedValue({ state: null, diagnostics: [] }),
        refreshPackageFileChanges: vi
          .fn()
          .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
        selectTaskCanvas: vi.fn().mockResolvedValue("canvas-main"),
        watchPackageFiles: vi.fn().mockResolvedValue(undefined),
        watchRuntimeState: vi.fn().mockResolvedValue(undefined)
      });
      vi.stubGlobal("planweave", bridge);
      vi.resetModules();
      const clearSelectedBlockRecords = vi.fn();
      const selectBlock = vi.fn().mockResolvedValue(undefined);
      const setActiveView = vi.fn();
      const setBlockInspectorOpen = vi.fn();
      const setError = vi.fn();
      const setSelectedBlock = vi.fn();
      const setSelectedRunRecord = vi.fn();
      const updateSettings = vi.fn();
      const [{ useDesktopProject }, { useDesktopProjectSession }] = await Promise.all([
        import("../renderer/hooks/useDesktopProject"),
        import("../renderer/hooks/useDesktopProjectSession")
      ]);

      const { result } = renderHook(() => {
        const projectState = useDesktopProject({
          setError,
          t: createTranslator("en"),
          updateSettings
        });
        return useDesktopProjectSession({
          clearSelectedBlockRecords,
          language: "en",
          projectState,
          selectBlock,
          setActiveView,
          setBlockInspectorOpen,
          setError,
          setSelectedBlock,
          setSelectedRunRecord
        });
      });

      await settleRendererUpdates();
      expect(result.current.selectedProject?.projectId).toBe(project.projectId);

      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await flushAsyncEffects();
      });
      expect(getDesktopRuntimeRefresh).toHaveBeenCalledWith({
        projectRoot: project.rootPath,
        canvasId: "canvas-main"
      });

      let openProjectPromise: Promise<void> | null = null;
      await act(async () => {
        openProjectPromise = result.current.openProject(otherProject, "canvas-main");
        staleRefresh.resolve({
          latestAutoRun: latestAutoRunState({ runId: "RUN-PENDING-STALE" }),
          diagnostics: [staleDiagnostic],
          errors: [staleDiagnostic.message]
        });
        await staleRefresh.promise;
        await flushAsyncEffects();
      });

      expect(result.current.selectedProject?.projectId).toBe(otherProject.projectId);
      expect(result.current.projectLoading).toBe(true);
      expect(result.current.autoRunState).toBeNull();
      expect(result.current.autoRunDiagnostics).toEqual([]);
      expect(setError).not.toHaveBeenCalledWith(staleDiagnostic.message);
      expect(getDesktopProjectSnapshot).toHaveBeenCalledTimes(2);

      await act(async () => {
        pendingProjectSnapshot.resolve(projectSnapshot());
        await openProjectPromise;
        await flushAsyncEffects();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

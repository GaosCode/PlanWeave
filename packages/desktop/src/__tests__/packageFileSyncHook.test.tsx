/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer hook interfaces", () => {
  it("refreshes graph data without reloading the canvas for prompt-only package changes", async () => {
    const bridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: false,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [],
        dirtyPromptRefs: ["tasks/T-ALPHA/prompt.md"]
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setFileSyncDiagnostics = vi.fn();
    const { result } = renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics,
        setLastFileChange: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshPackageFiles();
    });

    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" });
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(reloadCurrentCanvas).not.toHaveBeenCalled();
    expect(setFileSyncDiagnostics).toHaveBeenCalledWith([]);
  });

  it("refreshes graph data when package sync reports dirty refs with an index failure", async () => {
    const bridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: false,
        fullRefresh: false,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [{ code: "plangraph_index_refresh_failed", message: "SQLite index refresh failed.", path: "cache/plangraph.sqlite" }],
        dirtyPromptRefs: ["T-ALPHA#B-001"]
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    const setFileSyncDiagnostics = vi.fn();
    const { result } = renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError,
        setFileSyncDiagnostics,
        setLastFileChange: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshPackageFiles();
    });

    expect(setFileSyncDiagnostics).toHaveBeenCalledWith(["SQLite index refresh failed."]);
    expect(setError).toHaveBeenCalledWith("SQLite index refresh failed.");
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(reloadCurrentCanvas).not.toHaveBeenCalled();
  });

  it("passes watcher changed paths to package file refresh", async () => {
    let packageFileChanged: ((event: { projectRoot: string; canvasId?: string | null; paths: string[]; triggeredAt: string }) => void) | null = null;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-23T00:00:02.500Z"));
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: false,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [],
        dirtyPromptRefs: ["T-ALPHA#B-001"],
        refreshedPromptCount: 1,
        refreshConcurrency: 4,
        refreshStats: {
          requested: 1,
          refreshed: 1,
          concurrency: 4,
          elapsedMs: 8,
          changedPathCount: 1,
          refreshedRefs: 1,
          mode: "incremental"
        }
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setFileSyncResult = vi.fn();
    const setLastFileChange = vi.fn();
    renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setFileSyncResult,
        setLastFileChange
      })
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    const event = {
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      paths: ["package/nodes/T-ALPHA/blocks/B-001.prompt.md"],
      changedPathCount: 1,
      backendKind: "native",
      triggeredAt: "2026-06-23T00:00:00.000Z"
    };
    act(() => {
      packageFileChanged?.(event);
    });

    await waitFor(() =>
      expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith(
        { projectRoot: project.rootPath, canvasId: "canvas-main" },
        { changedPaths: event.paths }
      )
    );
    expect(setLastFileChange).toHaveBeenCalledWith(event);
    await waitFor(() =>
      expect(setFileSyncResult).toHaveBeenCalledWith(
        expect.objectContaining({
          watcherBackendKind: "native",
          watcherChangedPathCount: 1,
          watcherRefreshElapsedMs: 2500,
          refreshStats: expect.objectContaining({
            changedPathCount: 1,
            refreshedRefs: 1,
            mode: "incremental"
          })
        })
      )
    );
    await waitFor(() => expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1));
  });

  it("reloads the current canvas for project prompt watcher changes", async () => {
    let packageFileChanged: ((event: { projectRoot: string; canvasId?: string | null; paths: string[]; triggeredAt: string }) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: false,
        primed: false,
        affectedTasks: [],
        diagnostics: [{ code: "package_change_non_package_prompt", message: "Project prompt changed.", path: "policy/project-prompt.md" }],
        dirtyPromptRefs: []
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setLastFileChange: vi.fn()
      })
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    const event = {
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      paths: ["policy/project-prompt.md"],
      triggeredAt: "2026-06-23T00:00:00.000Z"
    };
    act(() => {
      packageFileChanged?.(event);
    });

    await waitFor(() => expect(reloadCurrentCanvas).toHaveBeenCalledTimes(1));
    expect(refreshProjectDerivedState).not.toHaveBeenCalled();
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { changedPaths: event.paths }
    );
  });

  it("reloads the current canvas for package changes that require a full refresh", async () => {
    const bridge = createDesktopBridgeMock({
      refreshPackageFileChanges: vi.fn().mockResolvedValue({
        ok: true,
        fullRefresh: true,
        primed: false,
        affectedTasks: ["T-ALPHA"],
        diagnostics: [],
        dirtyPromptRefs: []
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setLastFileChange: vi.fn()
      })
    );

    await act(async () => {
      await result.current.refreshPackageFiles();
    });

    expect(reloadCurrentCanvas).toHaveBeenCalledTimes(1);
    expect(refreshProjectDerivedState).not.toHaveBeenCalled();
  });
});

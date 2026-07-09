/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopPackageFileChangeEvent,
  DesktopPackageFileSyncResult
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createSuccessfulSyncResult(
  overrides: Partial<DesktopPackageFileSyncResult> = {}
): DesktopPackageFileSyncResult {
  return {
    ok: true,
    fullRefresh: false,
    primed: false,
    affectedTasks: ["T-ALPHA"],
    diagnostics: [],
    dirtyPromptRefs: ["T-ALPHA#B-001"],
    refreshedPromptCount: 1,
    refreshConcurrency: 4,
    ...overrides
  };
}

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

    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
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
        diagnostics: [
          {
            code: "plangraph_index_refresh_failed",
            message: "SQLite index refresh failed.",
            path: "cache/plangraph.sqlite"
          }
        ],
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
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
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

  it("serializes watcher refreshes and coalesces changed paths while a refresh is in flight", async () => {
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
    const firstRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const secondRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi
        .fn()
        .mockReturnValueOnce(firstRefresh.promise)
        .mockReturnValueOnce(secondRefresh.promise)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setLastFileChange = vi.fn();
    renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setLastFileChange
      })
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    const firstEvent: DesktopPackageFileChangeEvent = {
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      paths: ["package/nodes/T-ALPHA/blocks/B-002.prompt.md"],
      changedPathCount: 1,
      backendKind: "native",
      triggeredAt: "2026-06-23T00:00:00.000Z"
    };
    const secondEvent: DesktopPackageFileChangeEvent = {
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      paths: [
        "package/nodes/T-ALPHA/blocks/B-001.prompt.md",
        "package/nodes/T-ALPHA/blocks/B-002.prompt.md"
      ],
      changedPathCount: 2,
      backendKind: "polling",
      triggeredAt: "2026-06-23T00:00:01.000Z"
    };

    act(() => {
      packageFileChanged?.(firstEvent);
      packageFileChanged?.(secondEvent);
    });

    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);
    expect(bridge.refreshPackageFileChanges).toHaveBeenNthCalledWith(
      1,
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { changedPaths: ["package/nodes/T-ALPHA/blocks/B-002.prompt.md"] }
    );
    expect(setLastFileChange).toHaveBeenNthCalledWith(1, firstEvent);
    expect(setLastFileChange).toHaveBeenNthCalledWith(2, secondEvent);

    await act(async () => {
      firstRefresh.resolve(createSuccessfulSyncResult());
    });

    await waitFor(() => expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(2));
    expect(bridge.refreshPackageFileChanges).toHaveBeenNthCalledWith(
      2,
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      {
        changedPaths: [
          "package/nodes/T-ALPHA/blocks/B-001.prompt.md",
          "package/nodes/T-ALPHA/blocks/B-002.prompt.md"
        ]
      }
    );

    await act(async () => {
      secondRefresh.resolve(createSuccessfulSyncResult());
    });
    await waitFor(() => expect(refreshProjectDerivedState).toHaveBeenCalledTimes(2));
  });

  it("does not enqueue watcher events for another project or canvas", async () => {
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi.fn().mockResolvedValue(createSuccessfulSyncResult())
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const setLastFileChange = vi.fn();
    renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setLastFileChange
      })
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    act(() => {
      packageFileChanged?.({
        projectRoot: "/other/project",
        canvasId: "canvas-main",
        paths: ["package/manifest.json"],
        triggeredAt: "2026-06-23T00:00:00.000Z"
      });
      packageFileChanged?.({
        projectRoot: project.rootPath,
        canvasId: "other-canvas",
        paths: ["package/manifest.json"],
        triggeredAt: "2026-06-23T00:00:01.000Z"
      });
    });

    await Promise.resolve();
    expect(bridge.refreshPackageFileChanges).not.toHaveBeenCalled();
    expect(setLastFileChange).not.toHaveBeenCalled();
  });

  it("does not write stale watcher results after the selected canvas changes", async () => {
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
    const firstRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi.fn().mockReturnValueOnce(firstRefresh.promise)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const setFileSyncDiagnostics = vi.fn();
    const setFileSyncResult = vi.fn();
    const { rerender } = renderHook(
      ({ canvasId }) =>
        usePackageFileSync({
          refreshProjectDerivedState,
          reloadCurrentCanvas,
          selectedCanvasId: canvasId,
          selectedProject: project,
          setError: vi.fn(),
          setFileSyncDiagnostics,
          setFileSyncResult,
          setLastFileChange: vi.fn()
        }),
      { initialProps: { canvasId: "canvas-main" } }
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    act(() => {
      packageFileChanged?.({
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        paths: ["package/nodes/T-ALPHA/blocks/B-001.prompt.md"],
        triggeredAt: "2026-06-23T00:00:00.000Z"
      });
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    rerender({ canvasId: "canvas-next" });
    await act(async () => {
      firstRefresh.resolve(createSuccessfulSyncResult());
    });

    expect(setFileSyncDiagnostics).not.toHaveBeenCalled();
    expect(setFileSyncResult).not.toHaveBeenCalled();
    expect(refreshProjectDerivedState).not.toHaveBeenCalled();
    expect(reloadCurrentCanvas).not.toHaveBeenCalled();
  });

  it("drops stale queued watcher paths when the selected canvas changes before a new watcher refresh", async () => {
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
    const firstRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const secondRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi
        .fn()
        .mockReturnValueOnce(firstRefresh.promise)
        .mockReturnValueOnce(secondRefresh.promise)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const setFileSyncResult = vi.fn();
    const { rerender } = renderHook(
      ({ canvasId }) =>
        usePackageFileSync({
          refreshProjectDerivedState,
          reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
          selectedCanvasId: canvasId,
          selectedProject: project,
          setError: vi.fn(),
          setFileSyncDiagnostics: vi.fn(),
          setFileSyncResult,
          setLastFileChange: vi.fn()
        }),
      { initialProps: { canvasId: "canvas-main" } }
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    act(() => {
      packageFileChanged?.({
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        paths: ["package/nodes/T-ALPHA/blocks/B-001.prompt.md"],
        backendKind: "native",
        triggeredAt: "2026-06-23T00:00:00.000Z"
      });
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenNthCalledWith(
      1,
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { changedPaths: ["package/nodes/T-ALPHA/blocks/B-001.prompt.md"] }
    );

    act(() => {
      packageFileChanged?.({
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        paths: ["package/nodes/T-ALPHA/blocks/B-002.prompt.md"],
        backendKind: "native",
        triggeredAt: "2026-06-23T00:00:01.000Z"
      });
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    rerender({ canvasId: "canvas-next" });
    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    act(() => {
      packageFileChanged?.({
        projectRoot: project.rootPath,
        canvasId: "canvas-next",
        paths: ["package/nodes/T-BETA/blocks/B-001.prompt.md"],
        changedPathCount: 1,
        backendKind: "polling",
        triggeredAt: "2026-06-23T00:00:02.000Z"
      });
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRefresh.resolve(createSuccessfulSyncResult());
    });

    await waitFor(() => expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(2));
    expect(bridge.refreshPackageFileChanges).toHaveBeenNthCalledWith(
      2,
      { projectRoot: project.rootPath, canvasId: "canvas-next" },
      { changedPaths: ["package/nodes/T-BETA/blocks/B-001.prompt.md"] }
    );

    await act(async () => {
      secondRefresh.resolve(createSuccessfulSyncResult());
    });
    await waitFor(() =>
      expect(setFileSyncResult).toHaveBeenCalledWith(
        expect.objectContaining({
          watcherBackendKind: "polling",
          watcherChangedPathCount: 1
        })
      )
    );
    expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("resolves stale queued manual refreshes and runs a new manual refresh for the current canvas", async () => {
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
    const firstRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const secondRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi
        .fn()
        .mockReturnValueOnce(firstRefresh.promise)
        .mockReturnValueOnce(secondRefresh.promise)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const setFileSyncResult = vi.fn();
    const { rerender, result } = renderHook(
      ({ canvasId }) =>
        usePackageFileSync({
          refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
          reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
          selectedCanvasId: canvasId,
          selectedProject: project,
          setError: vi.fn(),
          setFileSyncDiagnostics: vi.fn(),
          setFileSyncResult,
          setLastFileChange: vi.fn()
        }),
      { initialProps: { canvasId: "canvas-main" } }
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    act(() => {
      packageFileChanged?.({
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        paths: ["package/nodes/T-ALPHA/blocks/B-001.prompt.md"],
        backendKind: "native",
        triggeredAt: "2026-06-23T00:00:00.000Z"
      });
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    let staleManualRefresh: Promise<void> | null = null;
    let staleManualResolved = false;
    act(() => {
      staleManualRefresh = result.current.refreshPackageFiles();
      staleManualRefresh.then(() => {
        staleManualResolved = true;
      });
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    rerender({ canvasId: "canvas-next" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(staleManualResolved).toBe(true);

    let currentManualRefresh: Promise<void> | null = null;
    act(() => {
      currentManualRefresh = result.current.refreshPackageFiles();
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRefresh.resolve(createSuccessfulSyncResult());
    });

    await waitFor(() => expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(2));
    expect(bridge.refreshPackageFileChanges).toHaveBeenNthCalledWith(2, {
      projectRoot: project.rootPath,
      canvasId: "canvas-next"
    });

    await act(async () => {
      secondRefresh.resolve(createSuccessfulSyncResult({ fullRefresh: true }));
      await currentManualRefresh;
    });
    await waitFor(() => expect(setFileSyncResult).toHaveBeenCalledTimes(1));
    expect(setFileSyncResult.mock.calls[0][0]).not.toHaveProperty("watcherBackendKind");
    expect(setFileSyncResult.mock.calls[0][0]).not.toHaveProperty("watcherChangedPathCount");
  });

  it("queues a manual full refresh behind an in-flight watcher refresh", async () => {
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
    const firstRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const secondRefresh = createDeferred<DesktopPackageFileSyncResult>();
    const bridge = createDesktopBridgeMock({
      onPackageFileChanged: vi.fn((callback) => {
        packageFileChanged = callback;
        return vi.fn();
      }),
      refreshPackageFileChanges: vi
        .fn()
        .mockReturnValueOnce(firstRefresh.promise)
        .mockReturnValueOnce(secondRefresh.promise)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");

    const refreshProjectDerivedState = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePackageFileSync({
        refreshProjectDerivedState,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        setFileSyncDiagnostics: vi.fn(),
        setLastFileChange: vi.fn()
      })
    );

    await waitFor(() => expect(packageFileChanged).not.toBeNull());
    act(() => {
      packageFileChanged?.({
        projectRoot: project.rootPath,
        canvasId: "canvas-main",
        paths: ["package/nodes/T-ALPHA/blocks/B-001.prompt.md"],
        triggeredAt: "2026-06-23T00:00:00.000Z"
      });
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    let manualRefresh: Promise<void> | null = null;
    act(() => {
      manualRefresh = result.current.refreshPackageFiles();
    });
    expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRefresh.resolve(createSuccessfulSyncResult());
    });

    await waitFor(() => expect(bridge.refreshPackageFileChanges).toHaveBeenCalledTimes(2));
    expect(bridge.refreshPackageFileChanges).toHaveBeenNthCalledWith(2, {
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });

    await act(async () => {
      secondRefresh.resolve(createSuccessfulSyncResult({ fullRefresh: true }));
      await manualRefresh;
    });
    await waitFor(() => expect(refreshProjectDerivedState).toHaveBeenCalledTimes(1));
  });

  it("reloads the current canvas for project prompt watcher changes", async () => {
    let packageFileChanged: ((event: DesktopPackageFileChangeEvent) => void) | null = null;
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
        diagnostics: [
          {
            code: "package_change_non_package_prompt",
            message: "Project prompt changed.",
            path: "policy/project-prompt.md"
          }
        ],
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

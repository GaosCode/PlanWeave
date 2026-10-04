/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DesktopPackageFileChangeEvent,
  DesktopPackageFileSyncResult
} from "@planweave-ai/runtime";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import { buildNotificationItems } from "../renderer/notifications";
import { defaultDesktopSettings } from "../shared/desktopSettings";

afterEach(cleanupRendererTestEnvironment);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function syncResult(
  overrides: Partial<DesktopPackageFileSyncResult> = {}
): DesktopPackageFileSyncResult {
  return {
    ok: true,
    primed: false,
    fullRefresh: false,
    affectedTasks: [],
    dirtyPromptRefs: [],
    refreshedPromptCount: 0,
    refreshConcurrency: null,
    diagnostics: [],
    ...overrides
  };
}

for (const queue of ["manual", "watcher"] as const) {
  for (const outcome of ["conflict", "prompt-only", "full-refresh"] as const) {
    it(`delivers queued ${queue} ${outcome} to B callbacks and notifications after retiring in-flight A`, async () => {
      const first = deferred<DesktopPackageFileSyncResult>();
      const bResult = syncResult({
        ok: outcome !== "conflict",
        fullRefresh: outcome === "full-refresh",
        dirtyPromptRefs: ["T-B"],
        diagnostics:
          outcome === "conflict"
            ? [{ code: "file_conflict", message: "B conflict", path: "prompt.md" }]
            : []
      });
      let watcher: ((event: DesktopPackageFileChangeEvent) => void) | undefined;
      const mock = createDesktopBridgeMock({
        refreshPackageFileChanges: vi
          .fn()
          .mockReturnValueOnce(first.promise)
          .mockResolvedValueOnce(bResult),
        onPackageFileChanged: vi.fn((callback) => {
          watcher = callback;
          return () => {
            watcher = undefined;
          };
        })
      });
      const refreshDerived = vi
        .fn<(canvasId: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const reloadCanvas = vi
        .fn<(canvasId: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const setError = vi.fn();
      vi.stubGlobal("planweave", mock);
      vi.resetModules();
      const { useFileSyncController } = await import("../renderer/controllers/AutoRunController");
      const hook = renderHook(
        ({ canvasId }) => {
          const fileSync = useFileSyncController({
            projectDiagnostics: [],
            refreshProjectDerivedState: () => refreshDerived(canvasId),
            reloadCurrentCanvas: () => reloadCanvas(canvasId),
            selectedCanvasId: canvasId,
            selectedProject: project,
            setError,
            t: createTranslator("en")
          });
          const notifications = buildNotificationItems({
            autoRunState: null,
            graph: null,
            graphScope: { projectRoot: project.rootPath, canvasId },
            navigationContext: { projectRoot: project.rootPath, canvasId },
            fileSyncDiagnostics: fileSync.fileSyncDiagnostics,
            lastFileChange: fileSync.lastFileChange,
            promptConflicts: [],
            settings: defaultDesktopSettings,
            t: createTranslator("en")
          });
          return { fileSync, notifications };
        },
        { initialProps: { canvasId: "A" } }
      );
      let a!: Promise<void>;
      act(() => {
        a = hook.result.current.fileSync.refreshPackageFiles();
      });
      hook.rerender({ canvasId: "B" });
      let b: Promise<void> | undefined;
      act(() => {
        if (queue === "manual") b = hook.result.current.fileSync.refreshPackageFiles();
        else {
          if (!watcher) throw new Error("Expected active B watcher subscription");
          watcher({
            projectRoot: project.rootPath,
            canvasId: "B",
            paths: ["package/nodes/T-B/prompt.md"],
            triggeredAt: "2026-10-04T00:00:00.000Z"
          });
        }
      });
      await act(async () => {
        first.resolve(
          syncResult({ diagnostics: [{ code: "old", message: "retired A conflict" }] })
        );
        await Promise.all([a, b]);
      });
      if (queue === "manual")
        expect(mock.refreshPackageFileChanges).toHaveBeenNthCalledWith(2, {
          projectRoot: project.rootPath,
          canvasId: "B"
        });
      else
        expect(mock.refreshPackageFileChanges).toHaveBeenNthCalledWith(
          2,
          { projectRoot: project.rootPath, canvasId: "B" },
          { changedPaths: ["package/nodes/T-B/prompt.md"] }
        );
      expect(hook.result.current.fileSync.fileSyncDiagnostics).toEqual(
        outcome === "conflict" ? ["B conflict"] : []
      );
      expect(hook.result.current.fileSync.fileSyncResult).toMatchObject(bResult);
      expect(refreshDerived.mock.calls).toEqual(outcome === "full-refresh" ? [] : [["B"]]);
      expect(reloadCanvas.mock.calls).toEqual(outcome === "full-refresh" ? [["B"]] : []);
      expect(setError.mock.calls).toEqual(outcome === "conflict" ? [["B conflict"]] : []);
      const unreadB = hook.result.current.notifications.filter(
        (item) => item.id.startsWith("sync:") && !item.read
      );
      expect(unreadB).toHaveLength(outcome === "conflict" ? 1 : 0);
      hook.rerender({ canvasId: "A" });
      expect(hook.result.current.fileSync.fileSyncDiagnostics).toEqual([]);
      expect(hook.result.current.fileSync.fileSyncResult).toBeNull();
      expect(
        hook.result.current.notifications.filter((item) => item.id.startsWith("sync:"))
      ).toEqual([]);
      hook.rerender({ canvasId: "B" });
      expect(
        hook.result.current.notifications.filter(
          (item) => item.id.startsWith("sync:") && !item.read
        )
      ).toEqual(unreadB);
    });
  }
}

it("does not publish a retired B derived-refresh rejection into active A", async () => {
  const derived = deferred<void>();
  const derivedStarted = deferred<void>();
  const mock = createDesktopBridgeMock({
    refreshPackageFileChanges: vi.fn().mockResolvedValue(
      syncResult({
        ok: false,
        diagnostics: [{ code: "file_conflict", message: "B conflict" }]
      })
    )
  });
  const setError = vi.fn();
  vi.stubGlobal("planweave", mock);
  vi.resetModules();
  const { useFileSyncController } = await import("../renderer/controllers/AutoRunController");
  const hook = renderHook(
    ({ canvasId }) =>
      useFileSyncController({
        projectDiagnostics: [],
        selectedProject: project,
        selectedCanvasId: canvasId,
        refreshProjectDerivedState: async () => {
          derivedStarted.resolve();
          await derived.promise;
          throw new Error("retired B derived failure");
        },
        reloadCurrentCanvas: async () => {},
        setError,
        t: createTranslator("en")
      }),
    { initialProps: { canvasId: "B" } }
  );
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = hook.result.current.refreshPackageFiles();
    await derivedStarted.promise;
  });
  expect(setError).toHaveBeenCalledWith("B conflict");
  setError.mockClear();
  hook.rerender({ canvasId: "A" });
  await act(async () => {
    derived.resolve();
    await refresh;
  });
  expect(setError).not.toHaveBeenCalled();
  expect(hook.result.current.fileSyncResult).toBeNull();
});

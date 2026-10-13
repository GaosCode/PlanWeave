/* @vitest-environment jsdom */

import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopBridgeApi,
  DesktopGraphViewModel,
  DesktopPackageFileChangeEvent,
  DesktopPackageFileSyncResult,
  DesktopRuntimeStateChangeEvent,
  DesktopWatchRegistration,
  ValidationIssue
} from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultDesktopSettings,
  type DesktopUiSettings,
  type PlanWeaveDesktopSettingsApi
} from "../shared/desktopSettings";
import { createTranslator } from "../renderer/i18n";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const homeA = "/home-a";
const homeB = "/home-b";
const settingsA: DesktopUiSettings = {
  ...defaultDesktopSettings,
  planweaveHome: homeA,
  runtimePath: project.workspaceRoot
};
const pendingTasks: Promise<unknown>[] = [];
const drainPending: (() => void)[] = [];
let originalLocalStorage: PropertyDescriptor | undefined;

function track<T>(promise: Promise<T>): Promise<T> {
  pendingTasks.push(promise);
  void promise.catch(() => undefined);
  return promise;
}

function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = track(
    new Promise<T>((success, failure) => {
      resolve = success;
      reject = failure;
    })
  );
  drainPending.push(() => resolve(cleanupValue));
  return { promise, resolve, reject };
}

function eventSource<Event>() {
  const listeners = new Set<(event: Event) => void>();
  return {
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: Event) {
      for (const listener of [...listeners]) listener(event);
    }
  };
}

function latestRegistration(
  api: DesktopBridgeApi,
  method: "watchPackageFiles" | "watchRuntimeState"
): DesktopWatchRegistration {
  const registration = vi.mocked(api[method]).mock.calls.at(-1)?.[0];
  if (!registration) throw new Error(`Expected an active ${method} registration.`);
  return registration;
}

function packageEvent(
  reference: DesktopWatchRegistration,
  paths: string[]
): DesktopPackageFileChangeEvent {
  return { ...reference, paths, triggeredAt: "2026-10-13T00:00:00Z" };
}

function runtimeEvent(reference: DesktopWatchRegistration): DesktopRuntimeStateChangeEvent {
  return {
    ...reference,
    canvasId: reference.canvasId ?? null,
    stateFile: `${reference.workspaceRoot}/state.json`,
    changedAt: "2026-10-13T00:00:00Z"
  };
}

async function mountProject() {
  let persisted = settingsA;
  let currentGraph: DesktopGraphViewModel = graph;
  const responses: Array<ReturnType<typeof deferred<DesktopUiSettings>>> = [];
  const packageChanges = eventSource<DesktopPackageFileChangeEvent>();
  const runtimeChanges = eventSource<DesktopRuntimeStateChangeEvent>();
  const syncResult: DesktopPackageFileSyncResult = {
    ok: true,
    primed: false,
    fullRefresh: false,
    affectedTasks: ["T-ALPHA"],
    dirtyPromptRefs: ["T-ALPHA#B-001"],
    refreshedPromptCount: 1,
    refreshConcurrency: 4,
    diagnostics: []
  };
  const settingsApi: PlanWeaveDesktopSettingsApi = {
    getDesktopSettings: vi.fn(async () => persisted),
    saveDesktopSettings: vi.fn(async (patch) => {
      if (patch.planweaveHome !== undefined) {
        const response = responses.shift();
        if (!response) throw new Error("Expected a queued Home save response.");
        persisted = await response.promise;
      } else if (patch.runtimePath !== undefined) {
        persisted = { ...persisted, runtimePath: patch.runtimePath };
      } else throw new Error("Unexpected settings patch.");
      return persisted;
    }),
    migrateLegacyDesktopSettings: vi.fn(async () => persisted)
  };
  const source = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([project]),
    getDesktopProjectSnapshot: vi.fn(async () => projectSnapshot({ graph: currentGraph })),
    getGraphViewModel: vi.fn(async () => currentGraph),
    refreshPackageFileChanges: vi.fn().mockResolvedValue(syncResult),
    watchPackageFiles: vi.fn().mockResolvedValue(undefined),
    watchRuntimeState: vi.fn().mockResolvedValue(undefined),
    onPackageFileChanged: packageChanges.subscribe,
    onRuntimeStateChanged: runtimeChanges.subscribe
  });
  vi.stubGlobal("planweaveDesktopSettings", settingsApi);
  vi.stubGlobal("planweave", source);
  vi.resetModules();
  const { useDesktopSettingsBridge } = await import("../renderer/hooks/useDesktopSettingsBridge");
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const { usePackageFileSync } = await import("../renderer/hooks/usePackageFileSync");
  const { bridge } = await import("../renderer/bridge");
  if (!bridge) throw new Error("The runtime bridge did not initialize.");
  const setError = vi.fn();
  const t = createTranslator("en");
  const hook = renderHook(() => {
    const settings = useDesktopSettingsBridge({ setError });
    const projects = useDesktopProject({
      planweaveHome: settings.settings.planweaveHome,
      settingsHydrated: settings.settingsHydrated,
      initialProjectPath: settings.settings.runtimePath,
      setError,
      t,
      updateSettings: settings.updateSettings
    });
    const [lastFileChange, setLastFileChange] = useState<DesktopPackageFileChangeEvent | null>(
      null
    );
    const [fileSyncResult, setFileSyncResult] = useState<DesktopPackageFileSyncResult | null>(null);
    const [fileSyncDiagnostics, setFileSyncDiagnostics] = useState<string[]>([]);
    usePackageFileSync({
      reloadCurrentCanvas: async () => {
        if (projects.selectedProject)
          await projects.loadProject(projects.selectedProject, projects.selectedCanvasId);
      },
      refreshProjectDerivedState: projects.refreshProjectDerivedState,
      selectedCanvasId: projects.selectedCanvasId,
      selectedProject: projects.selectedProject,
      setError,
      setFileSyncDiagnostics,
      setFileSyncResult,
      setLastFileChange
    });
    return { settings, projects, lastFileChange, fileSyncResult, fileSyncDiagnostics };
  });
  await waitFor(() => {
    expect(hook.result.current.projects.selectedProject).toEqual(project);
    expect(hook.result.current.projects.graph).toEqual(graph);
    expect(hook.result.current.projects.projectLoading).toBe(false);
    expect(source.watchPackageFiles).toHaveBeenCalled();
    expect(source.watchRuntimeState).toHaveBeenCalled();
  });
  return {
    ...hook,
    source,
    bridge,
    packageChanges,
    runtimeChanges,
    setError,
    setGraph(nextGraph: DesktopGraphViewModel) {
      currentGraph = nextGraph;
    },
    beginSave(home = homeB) {
      const response = deferred({ ...persisted, planweaveHome: home });
      responses.push(response);
      let save!: Promise<void>;
      act(() => {
        save = track(hook.result.current.settings.updateSettingsAndWait({ planweaveHome: home }));
      });
      return {
        async finish(outcome: "success" | "failure") {
          await act(async () => {
            if (outcome === "success") {
              response.resolve({ ...persisted, planweaveHome: home });
              await save;
            } else {
              response.reject(new Error("Home save failed."));
              await expect(save).rejects.toThrow("Home save failed.");
            }
          });
        }
      };
    }
  };
}

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});

afterEach(async () => {
  try {
    await act(async () => {
      for (const drain of drainPending) drain();
      await Promise.allSettled(pendingTasks);
    });
  } finally {
    drainPending.length = 0;
    pendingTasks.length = 0;
    cleanupRendererTestEnvironment();
    if (originalLocalStorage) Object.defineProperty(window, "localStorage", originalLocalStorage);
    else Reflect.deleteProperty(window, "localStorage");
  }
});

describe("desktop Home watcher recovery", () => {
  it("replays coalesced current notifications after a failed Home save and drops unsubscribed delivery", async () => {
    const h = await mountProject();
    const packageReference = latestRegistration(h.source, "watchPackageFiles");
    const runtimeReference = latestRegistration(h.source, "watchRuntimeState");
    const observer = vi.fn();
    const unsubscribe = h.bridge.onPackageFileChanged(observer);
    const freshGraph = { ...graph, graphVersion: "pgv-edited-while-home-pending" };
    h.setGraph(freshGraph);
    vi.mocked(h.source.getGraphViewModel).mockClear();
    vi.mocked(h.source.refreshPackageFileChanges).mockClear();
    const save = h.beginSave();

    act(() => {
      h.packageChanges.emit(packageEvent(packageReference, ["package/a.prompt.md"]));
      h.packageChanges.emit(packageEvent(packageReference, ["package/b.prompt.md"]));
      h.packageChanges.emit(packageEvent(packageReference, ["package/a.prompt.md"]));
      h.runtimeChanges.emit(runtimeEvent(runtimeReference));
      h.runtimeChanges.emit(runtimeEvent(runtimeReference));
      unsubscribe();
    });
    expect(h.result.current.lastFileChange).toBeNull();
    expect(h.result.current.projects.graph).toEqual(graph);
    expect(h.source.refreshPackageFileChanges).not.toHaveBeenCalled();
    expect(h.source.getGraphViewModel).not.toHaveBeenCalled();

    await save.finish("failure");
    await waitFor(() => {
      expect(h.result.current.fileSyncResult?.watcherChangedPathCount).toBe(2);
      expect(h.result.current.projects.graph).toEqual(freshGraph);
    });
    expect(h.result.current.settings.settings.planweaveHome).toBe(homeA);
    expect(h.result.current.lastFileChange?.paths).toEqual([
      "package/a.prompt.md",
      "package/b.prompt.md"
    ]);
    expect(h.source.refreshPackageFileChanges).toHaveBeenCalledExactlyOnceWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { changedPaths: ["package/a.prompt.md", "package/b.prompt.md"] }
    );
    expect(h.source.getGraphViewModel).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
    expect(h.setError).not.toHaveBeenCalledWith("PlanWeave Home is changing.");

    const second = h.beginSave();
    await second.finish("failure");
    expect(h.source.refreshPackageFileChanges).toHaveBeenCalledOnce();
    expect(h.source.getGraphViewModel).toHaveBeenCalledOnce();
  });

  it("retires buffered events before a successful Home commit, including a same-path Home ABA registration", async () => {
    const h = await mountProject();
    const originalPackage = latestRegistration(h.source, "watchPackageFiles");
    const originalRuntime = latestRegistration(h.source, "watchRuntimeState");
    vi.mocked(h.source.getGraphViewModel).mockClear();
    vi.mocked(h.source.refreshPackageFileChanges).mockClear();
    const bGraph = { ...graph, graphVersion: "pgv-home-b" };
    const first = h.beginSave();
    act(() => {
      h.packageChanges.emit(packageEvent(originalPackage, ["package/obsolete-a.prompt.md"]));
      h.runtimeChanges.emit(runtimeEvent(originalRuntime));
    });
    h.setGraph(bGraph);
    await first.finish("success");
    await waitFor(() => {
      expect(h.result.current.projects.graph).toEqual(bGraph);
      expect(h.result.current.projects.projectLoading).toBe(false);
    });
    expect(h.result.current.lastFileChange).toBeNull();
    expect(h.source.getGraphViewModel).not.toHaveBeenCalled();
    expect(
      vi.mocked(h.source.refreshPackageFileChanges).mock.calls.filter(([, options]) => options)
    ).toEqual([]);
    expect(latestRegistration(h.source, "watchPackageFiles").registrationId).not.toBe(
      originalPackage.registrationId
    );

    const aGraph = { ...graph, graphVersion: "pgv-home-a-returned" };
    const second = h.beginSave(homeA);
    act(() => {
      h.packageChanges.emit(packageEvent(originalPackage, ["package/obsolete-a.prompt.md"]));
      h.runtimeChanges.emit(runtimeEvent(originalRuntime));
    });
    h.setGraph(aGraph);
    await second.finish("success");
    await waitFor(() => {
      expect(h.result.current.projects.graph).toEqual(aGraph);
      expect(h.result.current.projects.projectLoading).toBe(false);
    });
    const currentPackage = latestRegistration(h.source, "watchPackageFiles");
    const currentRuntime = latestRegistration(h.source, "watchRuntimeState");
    expect(currentPackage.registrationId).not.toBe(originalPackage.registrationId);
    act(() => {
      h.packageChanges.emit(packageEvent(originalPackage, ["package/obsolete-a.prompt.md"]));
      h.runtimeChanges.emit(runtimeEvent(originalRuntime));
    });
    expect(h.result.current.lastFileChange).toBeNull();
    expect(h.source.getGraphViewModel).not.toHaveBeenCalled();

    const freshGraph = { ...graph, graphVersion: "pgv-current-a-update" };
    h.setGraph(freshGraph);
    act(() => {
      h.packageChanges.emit(packageEvent(currentPackage, ["package/current-a.prompt.md"]));
      h.runtimeChanges.emit(runtimeEvent(currentRuntime));
    });
    await waitFor(() => {
      expect(h.result.current.lastFileChange?.paths).toEqual(["package/current-a.prompt.md"]);
      expect(h.result.current.projects.graph).toEqual(freshGraph);
    });
    expect(h.setError).not.toHaveBeenCalledWith("PlanWeave Home is changing.");
  });

  it("skips periodic and visibility refreshes during Home saves and resumes after failure without a gate error", async () => {
    const h = await mountProject();
    const recoveredDiagnostic: ValidationIssue = {
      code: "runtime_refresh_recovered",
      message: "Current runtime diagnostics after the Home save failed.",
      path: `${project.workspaceRoot}/state.json`
    };
    vi.mocked(h.source.getDesktopRuntimeRefresh).mockResolvedValue({
      latestAutoRun: null,
      diagnostics: [recoveredDiagnostic],
      errors: []
    });
    h.setError.mockClear();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const save = h.beginSave();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(h.source.getDesktopRuntimeRefresh).not.toHaveBeenCalled();
    expect(h.setError).not.toHaveBeenCalled();

    await save.finish("failure");
    h.setError.mockClear();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(h.result.current.projects.runtimeDiagnostics).toEqual([recoveredDiagnostic])
    );
    expect(h.source.getDesktopRuntimeRefresh).toHaveBeenCalledExactlyOnceWith({
      projectRoot: project.rootPath,
      canvasId: "canvas-main"
    });
    expect(h.setError).not.toHaveBeenCalledWith("PlanWeave Home is changing.");
  });
});

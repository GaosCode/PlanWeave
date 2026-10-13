/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopBridgeApi, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultDesktopSettings,
  type DesktopSettingsPatch,
  type DesktopUiSettings,
  type PlanWeaveDesktopSettingsApi
} from "../shared/desktopSettings";
import { createTranslator } from "../renderer/i18n";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

type SettingsState = ReturnType<
  typeof import("../renderer/hooks/useDesktopSettingsBridge").useDesktopSettingsBridge
>;

const homeA = "/home-a";
const homeB = "/home-b";
const homeC = "/home-c";
const settingsA: DesktopUiSettings = { ...defaultDesktopSettings, planweaveHome: homeA };
const settingsB: DesktopUiSettings = { ...settingsA, planweaveHome: homeB };
const settingsC: DesktopUiSettings = { ...settingsA, planweaveHome: homeC };
const projectB: DesktopProjectSummary = {
  ...project,
  projectId: "P-HOME-B",
  rootPath: "/home-b/projects/demo",
  sourceRoot: "/home-b/projects/demo",
  workspaceRoot: "/home-b/projects/demo"
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
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  track(promise);
  drainPending.push(() => resolve(cleanupValue));
  return { promise, resolve, reject };
}

function createSettingsApi(): PlanWeaveDesktopSettingsApi {
  return {
    getDesktopSettings: vi.fn().mockResolvedValue(settingsA),
    saveDesktopSettings: vi.fn().mockResolvedValue(settingsA),
    migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(settingsA)
  };
}

function startSave(settings: SettingsState, patch: DesktopSettingsPatch): Promise<void> {
  let save!: Promise<void>;
  act(() => {
    save = track(settings.updateSettingsAndWait(patch));
  });
  return save;
}

async function mountSettings(
  settingsApi: PlanWeaveDesktopSettingsApi,
  runtimeApi: DesktopBridgeApi = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([projectB])
  })
) {
  vi.stubGlobal("planweaveDesktopSettings", settingsApi);
  vi.stubGlobal("planweave", runtimeApi);
  vi.resetModules();
  const { useDesktopSettingsBridge } = await import("../renderer/hooks/useDesktopSettingsBridge");
  const { bridge } = await import("../renderer/bridge");
  if (!bridge) throw new Error("The runtime bridge did not initialize.");
  const setError = vi.fn();
  const hook = renderHook(() => useDesktopSettingsBridge({ setError }));
  await waitFor(() => expect(hook.result.current.settingsHydrated).toBe(true));
  expect(hook.result.current.settings.planweaveHome).toBe(homeA);
  return { ...hook, bridge, runtimeApi, setError };
}

async function rejectQueryWhileChanging(bridge: DesktopBridgeApi): Promise<void> {
  await expect(track(bridge.listProjects())).rejects.toThrow("PlanWeave Home is changing.");
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

describe("desktop Home transition", () => {
  it.each([
    "success",
    "failure"
  ] as const)("releases admission after a fast %s save whose pending count is batched away", async (outcome) => {
    const settingsApi = createSettingsApi();
    if (outcome === "success") {
      vi.mocked(settingsApi.saveDesktopSettings).mockResolvedValueOnce(settingsB);
    } else {
      vi.mocked(settingsApi.saveDesktopSettings).mockRejectedValueOnce(new Error("Save failed."));
    }
    const { result, bridge } = await mountSettings(settingsApi);
    await act(async () => {
      const save = track(result.current.updateSettingsAndWait({ planweaveHome: homeB }));
      if (outcome === "success") await save;
      else await expect(save).rejects.toThrow("Save failed.");
      await rejectQueryWhileChanging(bridge);
    });
    expect(result.current.settingsHydrated).toBe(true);
    expect(result.current.settings.planweaveHome).toBe(outcome === "success" ? homeB : homeA);
    await expect(bridge.listProjects()).resolves.toEqual([projectB]);
  });

  it("keeps the confirmed Home and rejects commands until a successful save is acknowledged", async () => {
    const response = deferred(settingsB);
    const settingsApi = createSettingsApi();
    vi.mocked(settingsApi.saveDesktopSettings).mockReturnValueOnce(response.promise);
    const dispose = vi.fn();
    const runtimeApi = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([projectB]),
      onPackageFileChanged: () => dispose
    });
    const { result, bridge } = await mountSettings(settingsApi, runtimeApi);

    const save = startSave(result.current, { planweaveHome: homeB });

    expect(result.current.settings.planweaveHome).toBe(homeA);
    expect(result.current.settingsHydrated).toBe(false);
    await rejectQueryWhileChanging(bridge);
    expect(runtimeApi.listProjects).not.toHaveBeenCalled();
    const unsubscribe = bridge.onPackageFileChanged(() => undefined);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();

    await act(async () => {
      response.resolve(settingsB);
      await save;
      expect(result.current.settings.planweaveHome).toBe(homeA);
      await rejectQueryWhileChanging(bridge);
    });

    expect(result.current.settings.planweaveHome).toBe(homeB);
    expect(result.current.settingsHydrated).toBe(true);
    expect(runtimeApi.listProjects).not.toHaveBeenCalled();
    await expect(bridge.listProjects()).resolves.toEqual([projectB]);
  });

  it("restores command access at the original Home after a failed save", async () => {
    const response = deferred(settingsA);
    const settingsApi = createSettingsApi();
    vi.mocked(settingsApi.saveDesktopSettings).mockReturnValueOnce(response.promise);
    const { result, bridge, runtimeApi, setError } = await mountSettings(settingsApi);

    const save = startSave(result.current, { planweaveHome: homeB });

    expect(result.current.settings.planweaveHome).toBe(homeA);
    expect(result.current.settingsHydrated).toBe(false);
    await rejectQueryWhileChanging(bridge);
    expect(runtimeApi.listProjects).not.toHaveBeenCalled();
    await act(async () => {
      response.reject(new Error("Home B could not be saved."));
      await expect(save).rejects.toThrow("Home B could not be saved.");
    });

    expect(result.current.settings.planweaveHome).toBe(homeA);
    expect(result.current.settingsHydrated).toBe(true);
    expect(setError).toHaveBeenCalledWith("Home B could not be saved.");
    await expect(bridge.listProjects()).resolves.toEqual([projectB]);
  });

  it.each([
    { first: "success", second: "success", finalHome: homeC },
    { first: "success", second: "failure", finalHome: homeB },
    { first: "failure", second: "success", finalHome: homeC },
    { first: "failure", second: "failure", finalHome: homeA }
  ])("publishes the last confirmed Home only after queued $first then $second saves settle", async ({
    first,
    second,
    finalHome
  }) => {
    const firstResponse = deferred(settingsB);
    const secondResponse = deferred(settingsC);
    const settingsApi = createSettingsApi();
    vi.mocked(settingsApi.saveDesktopSettings)
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const { result, bridge, runtimeApi } = await mountSettings(settingsApi);

    const firstSave = startSave(result.current, { planweaveHome: homeB });
    const secondSave = startSave(result.current, { planweaveHome: homeC });

    expect(result.current.settings.planweaveHome).toBe(homeA);
    expect(result.current.settingsHydrated).toBe(false);
    await act(async () => {
      if (first === "success") {
        firstResponse.resolve(settingsB);
        await firstSave;
      } else {
        firstResponse.reject(new Error("Home B could not be saved."));
        await expect(firstSave).rejects.toThrow("Home B could not be saved.");
      }
    });
    await waitFor(() =>
      expect(settingsApi.saveDesktopSettings).toHaveBeenCalledWith({ planweaveHome: homeC })
    );

    expect(result.current.settings.planweaveHome).toBe(homeA);
    expect(result.current.settingsHydrated).toBe(false);
    await rejectQueryWhileChanging(bridge);
    expect(runtimeApi.listProjects).not.toHaveBeenCalled();

    await act(async () => {
      if (second === "success") {
        secondResponse.resolve(settingsC);
        await secondSave;
      } else {
        secondResponse.reject(new Error("Home C could not be saved."));
        await expect(secondSave).rejects.toThrow("Home C could not be saved.");
      }
    });

    expect(result.current.settings.planweaveHome).toBe(finalHome);
    expect(result.current.settingsHydrated).toBe(true);
    await expect(bridge.listProjects()).resolves.toEqual([projectB]);
  });

  it("keeps other settings optimistic through older Home and appearance acknowledgements", async () => {
    const darkB: DesktopUiSettings = { ...settingsB, appearance: "dark" };
    const finalSettings: DesktopUiSettings = {
      ...settingsC,
      appearance: "dark",
      language: "en"
    };
    const firstResponse = deferred(settingsB);
    const appearanceResponse = deferred(darkB);
    const lastResponse = deferred(finalSettings);
    const settingsApi = createSettingsApi();
    vi.mocked(settingsApi.saveDesktopSettings)
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(appearanceResponse.promise)
      .mockReturnValueOnce(lastResponse.promise);
    const { result, bridge, runtimeApi } = await mountSettings(settingsApi);

    const firstSave = startSave(result.current, { planweaveHome: homeB });
    const appearanceSave = startSave(result.current, { appearance: "dark" });
    const lastSave = startSave(result.current, { planweaveHome: homeC, language: "en" });

    expect(result.current.settings).toMatchObject({
      planweaveHome: homeA,
      appearance: "dark",
      language: "en"
    });
    expect(result.current.settingsHydrated).toBe(false);

    await act(async () => {
      firstResponse.resolve(settingsB);
      await firstSave;
      appearanceResponse.resolve(darkB);
      await appearanceSave;
    });

    expect(result.current.settings).toMatchObject({
      planweaveHome: homeA,
      appearance: "dark",
      language: "en"
    });
    expect(result.current.settingsHydrated).toBe(false);
    await rejectQueryWhileChanging(bridge);
    expect(runtimeApi.listProjects).not.toHaveBeenCalled();
    await act(async () => {
      lastResponse.resolve(finalSettings);
      await lastSave;
    });

    expect(result.current.settings).toEqual(finalSettings);
    expect(result.current.settingsHydrated).toBe(true);
    await expect(bridge.listProjects()).resolves.toEqual([projectB]);
  });

  it("starts the new Home project query after acknowledgement and discards a late old Home refresh", async () => {
    const oldRefresh = deferred<DesktopProjectSummary[]>([]);
    const homeResponse = deferred(settingsB);
    const settingsApi = createSettingsApi();
    vi.mocked(settingsApi.saveDesktopSettings).mockReturnValueOnce(homeResponse.promise);
    const queriedHomes: string[] = [];
    let currentRuntimeHome = homeA;
    const runtimeApi = createDesktopBridgeMock({
      listProjects: vi.fn(() => {
        queriedHomes.push(currentRuntimeHome);
        return Promise.resolve(currentRuntimeHome === homeA ? [project] : [projectB]);
      })
    });
    vi.stubGlobal("planweaveDesktopSettings", settingsApi);
    vi.stubGlobal("planweave", runtimeApi);
    vi.resetModules();
    const { useDesktopSettingsBridge } = await import("../renderer/hooks/useDesktopSettingsBridge");
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const t = createTranslator("en");
    const setError = vi.fn();
    const { result } = renderHook(() => {
      const settings = useDesktopSettingsBridge({ setError });
      const projects = useDesktopProject({
        planweaveHome: settings.settings.planweaveHome,
        settingsHydrated: settings.settingsHydrated,
        autoSelectInitialProject: false,
        setError,
        t,
        updateSettings: settings.updateSettings
      });
      return { settings, projects };
    });
    await waitFor(() => expect(result.current.projects.projects).toEqual([project]));
    vi.mocked(runtimeApi.listProjects).mockImplementationOnce(() => {
      queriedHomes.push(currentRuntimeHome);
      return oldRefresh.promise;
    });
    let refresh!: Promise<void>;
    act(() => {
      refresh = track(result.current.projects.refreshProjects());
    });
    const save = startSave(result.current.settings, { planweaveHome: homeB });

    expect(result.current.settings.settings.planweaveHome).toBe(homeA);
    expect(result.current.settings.settingsHydrated).toBe(false);
    expect(queriedHomes.every((home) => home === homeA)).toBe(true);
    await act(async () => {
      currentRuntimeHome = homeB;
      homeResponse.resolve(settingsB);
      await save;
    });
    await waitFor(() => expect(result.current.projects.projects).toEqual([projectB]));
    expect(queriedHomes).toContain(homeB);

    await act(async () => {
      oldRefresh.resolve([project]);
      await refresh;
    });

    expect(result.current.settings.settings.planweaveHome).toBe(homeB);
    expect(result.current.projects.projects).toEqual([projectB]);
    expect(setError).not.toHaveBeenCalled();
  });

  it.each([
    "success",
    "failure"
  ] as const)("scopes the selected project and runtime watchers to the confirmed Home after save %s", async (outcome) => {
    const bProjects = deferred<DesktopProjectSummary[]>([]);
    const homeResponse = deferred(settingsB);
    let persistedSettings = { ...settingsA, runtimePath: project.workspaceRoot };
    const settingsApi = createSettingsApi();
    vi.mocked(settingsApi.getDesktopSettings).mockResolvedValue(persistedSettings);
    vi.mocked(settingsApi.saveDesktopSettings).mockImplementation(async (patch) => {
      if (patch.planweaveHome !== undefined) return homeResponse.promise;
      if (patch.runtimePath !== undefined)
        persistedSettings = { ...persistedSettings, runtimePath: patch.runtimePath };
      return persistedSettings;
    });
    const graphB = {
      ...graph,
      projectId: projectB.projectId,
      projectTitle: projectB.name,
      graphVersion: "pgv-home-b"
    };
    const runtimeApi = createDesktopBridgeMock({
      listProjects: vi.fn(() =>
        persistedSettings.planweaveHome === homeA ? Promise.resolve([project]) : bProjects.promise
      ),
      getDesktopProjectSnapshot: vi.fn<DesktopBridgeApi["getDesktopProjectSnapshot"]>(
        async ({ projectRoot }) =>
          projectSnapshot({ graph: projectRoot === project.rootPath ? graph : graphB })
      ),
      watchRuntimeState: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweaveDesktopSettings", settingsApi);
    vi.stubGlobal("planweave", runtimeApi);
    vi.resetModules();
    const { useDesktopSettingsBridge } = await import("../renderer/hooks/useDesktopSettingsBridge");
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
    const t = createTranslator("en");
    const setError = vi.fn();
    const { result } = renderHook(() => {
      const settings = useDesktopSettingsBridge({ setError });
      const projects = useDesktopProject({
        planweaveHome: settings.settings.planweaveHome,
        settingsHydrated: settings.settingsHydrated,
        setError,
        t,
        updateSettings: settings.updateSettings
      });
      return { settings, projects };
    });
    await waitFor(() => expect(result.current.projects.selectedProject).toEqual(project));
    await waitFor(() => expect(result.current.projects.graph).toEqual(graph));
    await waitFor(() =>
      expect(runtimeApi.watchRuntimeState).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: project.rootPath })
      )
    );
    const watchRegistrations = vi.mocked(runtimeApi.watchRuntimeState).mock.calls.length;
    const save = startSave(result.current.settings, { planweaveHome: homeB });

    expect(result.current.settings.settings.planweaveHome).toBe(homeA);
    expect(result.current.projects.selectedProject).toEqual(project);
    expect(result.current.projects.graph).toEqual(graph);
    await act(async () => {
      if (outcome === "success") {
        persistedSettings = { ...settingsB, runtimePath: project.workspaceRoot };
        homeResponse.resolve(persistedSettings);
        await save;
      } else {
        homeResponse.reject(new Error("Home B could not be saved."));
        await expect(save).rejects.toThrow("Home B could not be saved.");
      }
    });

    expect(result.current.settings.settingsHydrated).toBe(true);
    expect(runtimeApi.watchRuntimeState).toHaveBeenCalledTimes(watchRegistrations);
    if (outcome === "failure") {
      expect(result.current.settings.settings.planweaveHome).toBe(homeA);
      expect(result.current.projects.selectedProject).toEqual(project);
      expect(result.current.projects.selectedCanvasId).toBe("canvas-main");
      expect(result.current.projects.graph).toEqual(graph);
      return;
    }

    expect(result.current.settings.settings.planweaveHome).toBe(homeB);
    expect(result.current.projects.selectedProject).toBeNull();
    expect(result.current.projects.selectedCanvasId).toBeNull();
    expect(result.current.projects.graph).toBeNull();
    await act(async () => {
      bProjects.resolve([projectB]);
      await bProjects.promise;
    });
    await waitFor(() => expect(result.current.projects.selectedProject).toEqual(projectB));
    await waitFor(() => expect(result.current.projects.graph).toEqual(graphB));
    expect(setError).not.toHaveBeenCalledWith("PlanWeave Home is changing.");
  });
});

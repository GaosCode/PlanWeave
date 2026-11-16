/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopSettingsBridge } from "../renderer/hooks/useDesktopSettingsBridge";
import {
  defaultDesktopSettings,
  legacyDesktopSettingsKey,
  mergeDesktopSettings,
  type DesktopAgentHost,
  type PlanWeaveDesktopSettingsApi
} from "../shared/desktopSettings";
import type { DesktopUiSettings } from "../renderer/types";

function deferred() {
  let resolve!: (settings: DesktopUiSettings) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DesktopUiSettings>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

const dark: DesktopUiSettings = { ...defaultDesktopSettings, appearance: "dark" };
const external: DesktopUiSettings = {
  ...defaultDesktopSettings,
  appearance: "light",
  language: "en"
};
function api(
  subscribe: (listener: (host: DesktopAgentHost) => void) => () => void = () => () => undefined
): PlanWeaveDesktopSettingsApi {
  return {
    getDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
    saveDesktopSettings: vi.fn().mockResolvedValue(dark),
    migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
    onAgentHostChanged: subscribe
  };
}
function focus() {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}
async function mount(settingsApi: PlanWeaveDesktopSettingsApi) {
  const setError = vi.fn();
  const hook = renderHook(() => useDesktopSettingsBridge({ setError, settingsApi }));
  await waitFor(() => expect(hook.result.current.settingsHydrated).toBe(true));
  return { ...hook, setError };
}
async function settle(read: ReturnType<typeof deferred>, settings: DesktopUiSettings) {
  await act(async () => {
    read.resolve(settings);
    await read.promise;
  });
}
beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    })
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "localStorage");
  vi.restoreAllMocks();
});

describe("desktop settings focus and draft lifecycle", () => {
  it("keeps a retired save response out of a current failure rollback before re-reading disk", async () => {
    const settingsApi = api();
    const retiredReply = deferred();
    const appearanceSave = deferred();
    const refreshRead = deferred();
    const { result, setError } = await mount(settingsApi);
    let persisted = mergeDesktopSettings(defaultDesktopSettings, { appearance: "light" });
    vi.mocked(settingsApi.saveDesktopSettings)
      .mockImplementationOnce((patch) => {
        persisted = mergeDesktopSettings(persisted, patch);
        return retiredReply.promise;
      })
      .mockReturnValueOnce(appearanceSave.promise);
    vi.mocked(settingsApi.getDesktopSettings).mockReturnValueOnce(refreshRead.promise);
    let current = true;
    const onError = vi.fn();
    act(() => {
      void result.current.updateSettingsAndWait(
        { agents: { codex: { acp: { configOptions: { model: "fast" } } } } },
        result.current.settings.execution.agentHost,
        { isCurrent: () => current, onError }
      );
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    expect(persisted).toMatchObject({
      appearance: "light",
      agents: { codex: { acp: { configOptions: { model: "fast" } } } }
    });
    const retiredSnapshot = persisted;
    current = false;
    persisted = mergeDesktopSettings(persisted, { appearance: "system" });
    act(() => result.current.updateSettings({ appearance: "dark" }));

    await settle(retiredReply, retiredSnapshot);
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    expect(result.current.settings.appearance).toBe("dark");
    await act(async () => {
      appearanceSave.reject(new Error("appearance not saved"));
      await appearanceSave.promise.catch(() => undefined);
    });
    await waitFor(() => expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(2));
    expect(result.current.settings.appearance).toBe("system");
    expect(result.current.settings.agents.codex.acp.configOptions).toEqual({});
    expect(setError).toHaveBeenCalledExactlyOnceWith("appearance not saved");
    expect(onError).not.toHaveBeenCalled();

    await settle(refreshRead, persisted);
    expect(result.current.settings).toEqual(persisted);
    expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(2);
  });

  it("re-reads before settling a refresh that crossed a failed current ACP write", async () => {
    const settingsApi = api();
    const retiredReply = deferred();
    const reasoningSave = deferred();
    const refreshRead = deferred();
    const retryRead = deferred();
    const { result, setError } = await mount(settingsApi);
    let persisted = defaultDesktopSettings;
    vi.mocked(settingsApi.saveDesktopSettings)
      .mockImplementationOnce((patch) => {
        persisted = mergeDesktopSettings(persisted, patch);
        return retiredReply.promise;
      })
      .mockReturnValueOnce(reasoningSave.promise);
    vi.mocked(settingsApi.getDesktopSettings)
      .mockReturnValueOnce(refreshRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    let current = true;
    const retiredError = vi.fn();
    act(() => {
      void result.current.updateSettingsAndWait(
        { agents: { codex: { acp: { configOptions: { model: "fast" } } } } },
        result.current.settings.execution.agentHost,
        { isCurrent: () => current, onError: retiredError }
      );
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    current = false;
    await settle(retiredReply, persisted);
    await waitFor(() => expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(2));
    const reasoningError = vi.fn();
    let save: Promise<void> | undefined;
    act(() => {
      save = result.current.updateSettingsAndWait(
        { agents: { codex: { acp: { configOptions: { reasoning: "high" } } } } },
        result.current.settings.execution.agentHost,
        { isCurrent: () => true, onError: reasoningError }
      );
      void save.catch(() => undefined);
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    await settle(refreshRead, persisted);
    expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(2);
    expect(result.current.settings.agents.codex.acp.configOptions).toEqual({});

    persisted = mergeDesktopSettings(persisted, { appearance: "light" });
    await act(async () => {
      reasoningSave.reject(new Error("reasoning not saved"));
      await save?.catch(() => undefined);
    });
    await waitFor(() => expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(3));
    await settle(retryRead, persisted);
    expect(result.current.settings).toEqual(persisted);
    expect(result.current.settings.agents.codex.acp.configOptions).toEqual({ model: "fast" });
    expect(reasoningError).toHaveBeenCalledExactlyOnceWith("reasoning not saved");
    expect(retiredError).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(3);
  });

  it.each([
    { laterAppearance: null, visibleAppearance: "system" },
    { laterAppearance: "light", visibleAppearance: "light" }
  ] as const)("retires an ACP write without changing the outcome of adjacent appearance saves ($visibleAppearance)", async ({
    laterAppearance,
    visibleAppearance
  }) => {
    const settingsApi = api();
    const failed = deferred();
    const next = deferred();
    vi.mocked(settingsApi.saveDesktopSettings)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(next.promise);
    const { result, setError } = await mount(settingsApi);
    let current = true;
    const onError = vi.fn();
    let acpSave: Promise<void> | undefined;
    act(() => {
      result.current.updateSettings({ appearance: "dark" });
      acpSave = result.current.updateSettingsAndWait(
        { agents: { codex: { acp: { configOptions: { model: "fast" } } } } },
        result.current.settings.execution.agentHost,
        { isCurrent: () => current, onError }
      );
      if (laterAppearance) result.current.updateSettings({ appearance: laterAppearance });
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    expect(settingsApi.saveDesktopSettings).toHaveBeenCalledWith({ appearance: "dark" });
    expect(result.current.settings.appearance).toBe(laterAppearance ?? "dark");

    current = false;
    await act(async () => {
      failed.reject(new Error("appearance not saved"));
      await acpSave;
    });

    expect(result.current.settings.appearance).toBe(visibleAppearance);
    expect(setError).toHaveBeenCalledExactlyOnceWith("appearance not saved");
    expect(onError).not.toHaveBeenCalled();
    if (laterAppearance) {
      expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2);
      expect(settingsApi.saveDesktopSettings).toHaveBeenLastCalledWith({
        appearance: laterAppearance
      });
      await settle(next, external);
      expect(result.current.settings).toEqual(external);
    } else {
      expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the confirmed Host through a delayed initial read, focus reads, and a queued save", async () => {
    const initialRead = deferred();
    const focusRead = deferred();
    const save = deferred();
    const queuedSave = deferred();
    const listeners = new Set<(host: DesktopAgentHost) => void>();
    const settingsApi = api((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const notify = (host: DesktopAgentHost) =>
      act(() => {
        for (const listener of listeners) listener(host);
      });
    vi.mocked(settingsApi.getDesktopSettings)
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(focusRead.promise);
    vi.mocked(settingsApi.saveDesktopSettings)
      .mockReturnValueOnce(save.promise)
      .mockReturnValueOnce(queuedSave.promise);
    const { result } = renderHook(() =>
      useDesktopSettingsBridge({ setError: vi.fn(), settingsApi })
    );
    const ubuntu = { kind: "wsl", distribution: "Ubuntu" } as const;
    const debian = { kind: "wsl", distribution: "Debian" } as const;
    const ubuntuSettings = { ...dark, execution: { ...dark.execution, agentHost: ubuntu } };
    notify(ubuntu);
    await settle(initialRead, dark);
    expect(result.current.settingsHydrated).toBe(true);
    expect(result.current.settings).toEqual(ubuntuSettings);

    focus();
    await waitFor(() => expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(2));
    act(() => {
      result.current.updateSettings({ appearance: "light" });
      result.current.updateSettings({ language: "en" });
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    notify(debian);
    expect(result.current.settings).toMatchObject({
      appearance: "light",
      language: "en",
      execution: { agentHost: debian }
    });
    await settle(focusRead, ubuntuSettings);
    await settle(save, { ...ubuntuSettings, appearance: "light" });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    expect(result.current.settings.execution.agentHost).toEqual(debian);
    await act(async () => {
      queuedSave.reject(new Error("queued save failed"));
      await queuedSave.promise.catch(() => undefined);
    });
    expect(result.current.settings).toMatchObject({
      appearance: "light",
      language: defaultDesktopSettings.language,
      execution: { agentHost: debian }
    });
  });

  it("reloads external settings on focus after a successful local save", async () => {
    const settingsApi = api();
    const { result } = await mount(settingsApi);
    await act(async () => {
      await result.current.updateSettingsAndWait({ appearance: "dark" });
    });
    expect(result.current.settings.appearance).toBe("dark");
    vi.mocked(settingsApi.getDesktopSettings).mockResolvedValue(external);
    focus();
    await waitFor(() => expect(result.current.settings).toEqual(external));
  });

  it.each([
    false,
    true
  ])("rejects a late focus read after a new draft (save settled: %s)", async (saveSettled) => {
    const settingsApi = api();
    const { result } = await mount(settingsApi);
    const read = deferred();
    const write = deferred();
    vi.mocked(settingsApi.getDesktopSettings).mockReturnValueOnce(read.promise);
    vi.mocked(settingsApi.saveDesktopSettings).mockReturnValueOnce(write.promise);
    focus();
    await waitFor(() => expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(2));
    act(() => {
      result.current.updateSettings({ appearance: "dark" });
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    if (saveSettled) await settle(write, dark);
    await settle(read, external);
    expect(result.current.settings).toEqual(dark);
    if (!saveSettled) await settle(write, dark);
    vi.mocked(settingsApi.saveDesktopSettings).mockRejectedValueOnce(new Error("latest failed"));
    act(() => {
      result.current.updateSettings({ appearance: "light" });
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.settings).toEqual(dark));
  });

  it("waits for pending saves and preserves the latest repeated focus request", async () => {
    const settingsApi = api();
    const { result } = await mount(settingsApi);
    const write = deferred();
    vi.mocked(settingsApi.saveDesktopSettings).mockReturnValueOnce(write.promise);
    vi.mocked(settingsApi.getDesktopSettings).mockResolvedValue(external);
    act(() => {
      result.current.updateSettings({ appearance: "dark" });
    });
    focus();
    focus();
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    expect(result.current.settings.appearance).toBe("dark");
    expect(settingsApi.getDesktopSettings).toHaveBeenCalledTimes(1);
    await settle(write, dark);
    await waitFor(() => expect(result.current.settings).toEqual(external));
  });

  it.each([
    false,
    true
  ])("protects the second draft from an older save response (failure: %s)", async (failure) => {
    const settingsApi = api();
    const { result } = await mount(settingsApi);
    const first = deferred();
    const second = deferred();
    vi.mocked(settingsApi.saveDesktopSettings)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    act(() => {
      result.current.updateSettings({ appearance: "dark" });
      result.current.updateSettings({ language: "en" });
    });
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    if (failure) {
      await act(async () => {
        first.reject(new Error("first failed"));
        await first.promise.catch(() => undefined);
      });
    } else await settle(first, dark);
    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    expect(result.current.settings).toMatchObject({ appearance: "dark", language: "en" });
    const final = { ...dark, language: "en" as const };
    await settle(second, final);
    expect(result.current.settings).toEqual(final);
    vi.mocked(settingsApi.saveDesktopSettings).mockRejectedValueOnce(new Error("last failed"));
    act(() => {
      result.current.updateSettings({ language: "zh-CN" });
    });
    await waitFor(() => expect(result.current.settings).toEqual(final));
    vi.mocked(settingsApi.getDesktopSettings).mockResolvedValue(external);
    focus();
    await waitFor(() => expect(result.current.settings).toEqual(external));
    await act(async () => {
      await result.current.updateSettingsAndWait({ appearance: "dark" });
    });
    expect(result.current.settings).toEqual(dark);
  });

  it("retries a failed initial read on focus", async () => {
    const settingsApi = api();
    vi.mocked(settingsApi.getDesktopSettings)
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(external);
    const { result, setError } = await mount(settingsApi);
    expect(setError).toHaveBeenCalledWith("read failed");
    focus();
    await waitFor(() => expect(result.current.settings).toEqual(external));
  });

  it("preserves a draft through slow migration and rolls a failed save back to migrated authority", async () => {
    const settingsApi = api();
    const migration = deferred();
    window.localStorage.setItem(legacyDesktopSettingsKey, JSON.stringify({ language: "en" }));
    vi.mocked(settingsApi.migrateLegacyDesktopSettings).mockReturnValueOnce(migration.promise);
    vi.mocked(settingsApi.saveDesktopSettings).mockRejectedValueOnce(new Error("save failed"));
    const { result } = renderHook(() =>
      useDesktopSettingsBridge({ setError: vi.fn(), settingsApi })
    );
    await waitFor(() => expect(settingsApi.migrateLegacyDesktopSettings).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.updateSettings({ appearance: "dark" });
    });
    expect(result.current.settings.appearance).toBe("dark");
    expect(settingsApi.saveDesktopSettings).not.toHaveBeenCalled();
    vi.mocked(settingsApi.getDesktopSettings).mockResolvedValue(external);
    await settle(migration, external);
    await waitFor(() => expect(result.current.settings).toEqual(external));
    expect(result.current.settingsHydrated).toBe(true);
  });

  it("does not mark a migration completed after unmount", async () => {
    const settingsApi = api();
    const migration = deferred();
    window.localStorage.setItem(legacyDesktopSettingsKey, JSON.stringify({ language: "en" }));
    vi.mocked(settingsApi.migrateLegacyDesktopSettings).mockReturnValueOnce(migration.promise);
    const { unmount } = renderHook(() =>
      useDesktopSettingsBridge({ setError: vi.fn(), settingsApi })
    );
    await waitFor(() => expect(settingsApi.migrateLegacyDesktopSettings).toHaveBeenCalledTimes(1));
    const setItem = vi.mocked(window.localStorage.setItem);
    setItem.mockClear();
    unmount();
    await settle(migration, external);
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each(["read", "save"] as const)("ignores late %s errors after unmount", async (operation) => {
    const settingsApi = api();
    const pending = deferred();
    const setError = vi.fn();
    if (operation === "read")
      vi.mocked(settingsApi.getDesktopSettings).mockReturnValueOnce(pending.promise);
    else vi.mocked(settingsApi.saveDesktopSettings).mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() =>
      useDesktopSettingsBridge({ setError, settingsApi })
    );
    let save: Promise<void> | undefined;
    if (operation === "save") {
      await waitFor(() => expect(result.current.settingsHydrated).toBe(true));
      act(() => {
        save = result.current.updateSettingsAndWait({ appearance: "dark" });
      });
      // Attach the caller's rejection handler before rejecting the bridge operation.
      void save!.catch(() => undefined);
      await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(1));
    }
    unmount();
    await act(async () => {
      pending.reject(new Error("late error"));
      await pending.promise.catch(() => undefined);
    });
    if (save) await expect(save).rejects.toThrow("late error");
    expect(setError).not.toHaveBeenCalled();
  });
});

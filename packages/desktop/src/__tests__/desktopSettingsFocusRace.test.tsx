/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopSettingsBridge } from "../renderer/hooks/useDesktopSettingsBridge";
import {
  defaultDesktopSettings,
  legacyDesktopSettingsKey,
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
function api(): PlanWeaveDesktopSettingsApi {
  return {
    getDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
    saveDesktopSettings: vi.fn().mockResolvedValue(dark),
    migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings)
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

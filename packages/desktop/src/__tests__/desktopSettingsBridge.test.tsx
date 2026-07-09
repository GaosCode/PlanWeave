/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopSettingsBridge } from "../renderer/hooks/useDesktopSettingsBridge";
import {
  defaultDesktopSettings,
  desktopSettingsKey,
  loadDesktopSettings
} from "../renderer/settings";
import {
  legacyDesktopSettingsMigrationMarkerKey,
  type PlanWeaveDesktopSettingsApi
} from "../shared/desktopSettings";
import type { DesktopUiSettings } from "../renderer/types";

function stubLocalStorage() {
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
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage
  });
}

beforeEach(() => {
  stubLocalStorage();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "localStorage");
  vi.restoreAllMocks();
});

describe("desktop settings bridge", () => {
  it("loads settings through the desktop settings bridge and migrates legacy localStorage once", async () => {
    const legacyPayload = JSON.stringify({
      appearance: "dark",
      language: "en"
    });
    const loadedSettings = {
      ...defaultDesktopSettings,
      appearance: "light" as const
    };
    const migratedSettings = {
      ...defaultDesktopSettings,
      appearance: "dark" as const,
      language: "en" as const
    };
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(loadedSettings),
      saveDesktopSettings: vi.fn().mockResolvedValue(loadedSettings),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(migratedSettings)
    };
    const setError = vi.fn();
    window.localStorage.setItem(desktopSettingsKey, legacyPayload);
    window.localStorage.setItem.mockClear();

    const { result } = renderHook(() => useDesktopSettingsBridge({ setError, settingsApi }));

    expect(result.current.settings).toEqual(defaultDesktopSettings);
    await waitFor(() =>
      expect(settingsApi.migrateLegacyDesktopSettings).toHaveBeenCalledWith(legacyPayload)
    );
    expect(result.current.settings).toMatchObject({ appearance: "dark", language: "en" });
    expect(window.localStorage.getItem(legacyDesktopSettingsMigrationMarkerKey)).toBe("1");
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      desktopSettingsKey,
      expect.any(String)
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("delegates legacy migration to the desktop settings bridge even when the renderer marker exists", async () => {
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
      saveDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings)
    };
    window.localStorage.setItem(desktopSettingsKey, JSON.stringify({ appearance: "dark" }));
    window.localStorage.setItem(legacyDesktopSettingsMigrationMarkerKey, "1");

    renderHook(() => useDesktopSettingsBridge({ setError: vi.fn(), settingsApi }));

    await waitFor(() =>
      expect(settingsApi.migrateLegacyDesktopSettings).toHaveBeenCalledWith(
        JSON.stringify({ appearance: "dark" })
      )
    );
  });

  it("saves settings through the desktop settings bridge without writing runtime settings to localStorage", async () => {
    const savedSettings = {
      ...defaultDesktopSettings,
      appearance: "dark" as const
    };
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
      saveDesktopSettings: vi.fn().mockResolvedValue(savedSettings),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(savedSettings)
    };
    const setError = vi.fn();
    const { result } = renderHook(() => useDesktopSettingsBridge({ setError, settingsApi }));
    window.localStorage.setItem.mockClear();

    act(() => result.current.updateSettings({ appearance: "dark" }));

    await waitFor(() => expect(result.current.settings.appearance).toBe("dark"));
    expect(settingsApi.saveDesktopSettings).toHaveBeenCalledWith({ appearance: "dark" });
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      desktopSettingsKey,
      expect.any(String)
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("serializes rapid desktop settings saves so patches do not race", async () => {
    let activeSaves = 0;
    let maxConcurrentSaves = 0;
    let persistedSettings = defaultDesktopSettings;
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
      saveDesktopSettings: vi.fn(async (patch) => {
        activeSaves += 1;
        maxConcurrentSaves = Math.max(maxConcurrentSaves, activeSaves);
        await new Promise((resolve) => setTimeout(resolve, 10));
        persistedSettings = {
          ...persistedSettings,
          ...patch,
          notifications: {
            ...persistedSettings.notifications,
            ...patch.notifications
          },
          windowMaterial: {
            ...persistedSettings.windowMaterial,
            ...patch.windowMaterial
          }
        };
        activeSaves -= 1;
        return persistedSettings;
      }),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings)
    };
    const { result } = renderHook(() =>
      useDesktopSettingsBridge({ setError: vi.fn(), settingsApi })
    );

    act(() => {
      result.current.updateSettings({ appearance: "dark" });
      result.current.updateSettings({ notifications: { autoRunFailure: false } });
    });

    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    expect(maxConcurrentSaves).toBe(1);
    expect(settingsApi.saveDesktopSettings).toHaveBeenNthCalledWith(1, { appearance: "dark" });
    expect(settingsApi.saveDesktopSettings).toHaveBeenNthCalledWith(2, {
      notifications: { autoRunFailure: false }
    });
    expect(result.current.settings).toMatchObject({
      appearance: "dark",
      notifications: {
        autoRunFailure: false,
        graphExceptions: true
      }
    });
  });

  it("keeps rapid functional nested setting updates from rolling each other back", async () => {
    let persistedSettings = defaultDesktopSettings;
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
      saveDesktopSettings: vi.fn(async (patch) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        persistedSettings = {
          ...persistedSettings,
          ...patch,
          review: {
            ...persistedSettings.review,
            ...patch.review
          }
        };
        return persistedSettings;
      }),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings)
    };
    const { result } = renderHook(() =>
      useDesktopSettingsBridge({ setError: vi.fn(), settingsApi })
    );

    act(() => {
      result.current.updateSettings((current) => ({
        review: { ...current.review, strictReview: false }
      }));
      result.current.updateSettings((current) => ({
        review: { ...current.review, feedbackLoop: false }
      }));
    });

    await waitFor(() =>
      expect(result.current.settings.review).toMatchObject({
        pipelineEnabled: true,
        strictReview: false,
        feedbackLoop: false,
        autoAppendReviewBlock: true
      })
    );
  });

  it("waits for initial legacy migration before saving local settings changes", async () => {
    const calls: string[] = [];
    let resolveGetDesktopSettings: (settings: DesktopUiSettings) => void = () => undefined;
    const getDesktopSettings = vi.fn(
      () =>
        new Promise<DesktopUiSettings>((resolve) => {
          resolveGetDesktopSettings = resolve;
        })
    );
    const migratedSettings = {
      ...defaultDesktopSettings,
      appearance: "dark" as const,
      language: "en" as const
    };
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings,
      saveDesktopSettings: vi.fn(async (patch) => {
        calls.push("save");
        return {
          ...migratedSettings,
          ...patch
        };
      }),
      migrateLegacyDesktopSettings: vi.fn(async () => {
        calls.push("migrate");
        return migratedSettings;
      })
    };
    window.localStorage.setItem(
      desktopSettingsKey,
      JSON.stringify({ appearance: "dark", language: "en" })
    );
    const { result } = renderHook(() =>
      useDesktopSettingsBridge({ setError: vi.fn(), settingsApi })
    );

    await waitFor(() => expect(getDesktopSettings).toHaveBeenCalledTimes(1));
    act(() => result.current.updateSettings({ appearance: "light" }));

    expect(settingsApi.saveDesktopSettings).not.toHaveBeenCalled();

    act(() => resolveGetDesktopSettings(defaultDesktopSettings));

    await waitFor(() =>
      expect(settingsApi.saveDesktopSettings).toHaveBeenCalledWith({ appearance: "light" })
    );
    expect(settingsApi.migrateLegacyDesktopSettings).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["migrate", "save"]);
    expect(result.current.settings).toMatchObject({
      appearance: "light",
      language: "en"
    });
  });

  it("shows desktop settings save errors instead of faking a successful update", async () => {
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings),
      saveDesktopSettings: vi.fn().mockRejectedValue(new Error("settings file is read-only")),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(defaultDesktopSettings)
    };
    const setError = vi.fn();
    const { result } = renderHook(() => useDesktopSettingsBridge({ setError, settingsApi }));

    act(() => result.current.updateSettings({ appearance: "dark" }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("settings file is read-only"));
    expect(result.current.settings.appearance).toBe(defaultDesktopSettings.appearance);
  });

  it("rolls back to the last confirmed settings when queued saves all fail", async () => {
    const confirmedSettings = {
      ...defaultDesktopSettings,
      appearance: "light" as const,
      language: "en" as const
    };
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(confirmedSettings),
      saveDesktopSettings: vi.fn().mockRejectedValue(new Error("settings disk unavailable")),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(confirmedSettings)
    };
    const setError = vi.fn();
    const { result } = renderHook(() => useDesktopSettingsBridge({ setError, settingsApi }));

    await waitFor(() =>
      expect(result.current.settings).toMatchObject({ appearance: "light", language: "en" })
    );

    act(() => {
      result.current.updateSettings({ appearance: "dark" });
      result.current.updateSettings({ notifications: { autoRunFailure: false } });
    });

    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("settings disk unavailable"));
    expect(result.current.settings).toMatchObject({
      appearance: "light",
      language: "en",
      notifications: {
        autoRunFailure: true
      }
    });
  });

  it("does not let an older failed save roll back a later successful revision", async () => {
    const confirmedSettings = {
      ...defaultDesktopSettings,
      appearance: "light" as const,
      language: "en" as const
    };
    const finalSettings = {
      ...confirmedSettings,
      appearance: "dark" as const,
      notifications: {
        ...confirmedSettings.notifications,
        autoRunFailure: false
      }
    };
    let saveCount = 0;
    const settingsApi: PlanWeaveDesktopSettingsApi = {
      getDesktopSettings: vi.fn().mockResolvedValue(confirmedSettings),
      saveDesktopSettings: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 1) {
          throw new Error("first save failed");
        }
        return finalSettings;
      }),
      migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(confirmedSettings)
    };
    const setError = vi.fn();
    const { result } = renderHook(() => useDesktopSettingsBridge({ setError, settingsApi }));

    await waitFor(() =>
      expect(result.current.settings).toMatchObject({ appearance: "light", language: "en" })
    );

    act(() => {
      result.current.updateSettings({ appearance: "dark" });
      result.current.updateSettings({ notifications: { autoRunFailure: false } });
    });

    await waitFor(() => expect(settingsApi.saveDesktopSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.settings).toMatchObject({
        appearance: "dark",
        language: "en",
        notifications: {
          autoRunFailure: false
        }
      })
    );
    expect(setError).toHaveBeenCalledWith("first save failed");
  });

  it("reports an error instead of faking persistence when no desktop settings bridge exists", async () => {
    const setError = vi.fn();
    const { result } = renderHook(() => useDesktopSettingsBridge({ setError, settingsApi: null }));
    window.localStorage.setItem.mockClear();

    act(() => result.current.updateSettings({ appearance: "dark" }));

    await waitFor(() =>
      expect(setError).toHaveBeenCalledWith("Desktop settings bridge is unavailable.")
    );
    expect(result.current.settings.appearance).toBe(defaultDesktopSettings.appearance);
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      desktopSettingsKey,
      expect.any(String)
    );
  });

  it("supports explicit test-only in-memory settings updates when no desktop settings bridge exists", () => {
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useDesktopSettingsBridge({ setError, settingsApi: null, allowInMemoryFallback: true })
    );
    window.localStorage.setItem.mockClear();

    act(() => result.current.updateSettings({ appearance: "dark" }));

    expect(result.current.settings.appearance).toBe("dark");
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      desktopSettingsKey,
      expect.any(String)
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not use legacy localStorage as the runtime settings authority", () => {
    window.localStorage.setItem(
      desktopSettingsKey,
      JSON.stringify({
        language: "en",
        appearance: "dark"
      })
    );
    window.localStorage.setItem.mockClear();

    expect(loadDesktopSettings()).toEqual(defaultDesktopSettings);
    expect(window.localStorage.getItem).not.toHaveBeenCalledWith(desktopSettingsKey);
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });
});

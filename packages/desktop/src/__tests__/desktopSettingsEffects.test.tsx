/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings, desktopSettingsKey } from "../renderer/settings";
import { useDesktopSettingsEffects } from "../renderer/hooks/useDesktopSettingsEffects";
import type { AppearanceMode, DesktopUiSettings } from "../renderer/types";

function settingsWithAppearance(
  appearance: AppearanceMode,
  windowMaterialEnabled = false
): DesktopUiSettings {
  return {
    ...defaultDesktopSettings,
    appearance,
    windowMaterial: {
      enabled: windowMaterialEnabled
    }
  };
}

function stubPrefersDark(matches: boolean) {
  let currentMatches = matches;
  const listeners = new Set<() => void>();
  const legacyListeners = new Set<() => void>();
  const mediaQueryList = {
    get matches() {
      return currentMatches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((_event: "change", listener: () => void) => {
      listeners.add(listener);
    }),
    addListener: vi.fn((listener: () => void) => {
      legacyListeners.add(listener);
    }),
    dispatchEvent: vi.fn(() => true),
    removeEventListener: vi.fn((_event: "change", listener: () => void) => {
      listeners.delete(listener);
    }),
    removeListener: vi.fn((listener: () => void) => {
      legacyListeners.delete(listener);
    })
  } satisfies MediaQueryList;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((): MediaQueryList => mediaQueryList)
  );
  return {
    mediaQueryList,
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches;
      for (const listener of listeners) {
        listener();
      }
      for (const listener of legacyListeners) {
        listener();
      }
    }
  };
}

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
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.windowMaterial;
  delete document.documentElement.dataset.reducedMotion;
  Reflect.deleteProperty(window, "localStorage");
  Reflect.deleteProperty(window, "planweaveWindow");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useDesktopSettingsEffects", () => {
  it("does not persist runtime settings to legacy localStorage", () => {
    stubPrefersDark(false);

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("dark")));

    expect(window.localStorage.setItem).not.toHaveBeenCalledWith(
      desktopSettingsKey,
      expect.any(String)
    );
  });

  it("adds the root dark class when system appearance prefers dark", () => {
    stubPrefersDark(true);

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("system")));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("updates the root dark class when system appearance changes", () => {
    const prefersDark = stubPrefersDark(false);

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("system")));

    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => prefersDark.setMatches(true));

    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => prefersDark.setMatches(false));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("cleans up the system appearance listener on unmount", () => {
    const prefersDark = stubPrefersDark(false);

    const { unmount } = renderHook(() =>
      useDesktopSettingsEffects(settingsWithAppearance("system"))
    );
    unmount();

    act(() => prefersDark.setMatches(true));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(prefersDark.mediaQueryList.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );
  });

  it("removes the root dark class when light appearance is forced", () => {
    document.documentElement.classList.add("dark");
    stubPrefersDark(true);

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("light")));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("adds the root dark class when dark appearance is forced", () => {
    stubPrefersDark(false);

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("dark")));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("sets the root window material state when material is enabled", () => {
    stubPrefersDark(false);
    const { rerender } = renderHook(({ settings }) => useDesktopSettingsEffects(settings), {
      initialProps: {
        settings: settingsWithAppearance("light", true)
      }
    });

    expect(document.documentElement.dataset.windowMaterial).toBe("true");

    rerender({ settings: settingsWithAppearance("light", false) });

    expect(document.documentElement.dataset.windowMaterial).toBeUndefined();
  });

  it("does not set the root window material state when capabilities are unsupported", async () => {
    stubPrefersDark(false);
    const setWindowMaterial = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "planweaveWindow", {
      configurable: true,
      value: {
        getWindowMaterialCapabilities: vi.fn().mockResolvedValue({
          platform: "linux",
          reason: "unsupported-platform",
          supported: false
        }),
        setWindowMaterial
      }
    });

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("light", true)));

    await waitFor(() =>
      expect(setWindowMaterial).toHaveBeenCalledWith({
        appearance: "light",
        enabled: false
      })
    );
    expect(document.documentElement.dataset.windowMaterial).toBeUndefined();
  });

  it("sets the root reduced motion state when the setting is enabled", () => {
    stubPrefersDark(false);

    renderHook(() =>
      useDesktopSettingsEffects({
        ...settingsWithAppearance("light"),
        reducedMotion: true
      })
    );

    expect(document.documentElement.dataset.reducedMotion).toBe("true");
  });

  it("sets the root reduced motion state when the system prefers reduced motion", () => {
    const prefersReducedMotion = stubPrefersDark(true);

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("light")));

    expect(document.documentElement.dataset.reducedMotion).toBe("true");

    act(() => prefersReducedMotion.setMatches(false));

    expect(document.documentElement.dataset.reducedMotion).toBeUndefined();
  });

  it("syncs window material settings when the desktop window API exists", () => {
    stubPrefersDark(false);
    const setWindowMaterial = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "planweaveWindow", {
      configurable: true,
      value: {
        setWindowMaterial
      }
    });

    renderHook(() => useDesktopSettingsEffects(settingsWithAppearance("dark", true)));

    expect(setWindowMaterial).toHaveBeenCalledWith({
      appearance: "dark",
      enabled: true
    });
  });
});

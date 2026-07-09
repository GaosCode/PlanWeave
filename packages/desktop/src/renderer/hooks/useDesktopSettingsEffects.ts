import { useEffect } from "react";
import type { DesktopUiSettings } from "../types";

export function useDesktopSettingsEffects(settings: DesktopUiSettings) {
  useEffect(() => {
    let cancelled = false;
    const root = document.documentElement;
    if (!settings.windowMaterial.enabled) {
      delete root.dataset.windowMaterial;
      return;
    }

    const windowApi = window.planweaveWindow;
    if (!windowApi?.getWindowMaterialCapabilities) {
      root.dataset.windowMaterial = "true";
      return () => {
        delete root.dataset.windowMaterial;
      };
    }
    void windowApi.getWindowMaterialCapabilities().then((capabilities) => {
      if (cancelled) {
        return;
      }
      if (capabilities.supported) {
        root.dataset.windowMaterial = "true";
      } else {
        delete root.dataset.windowMaterial;
      }
    });
    return () => {
      cancelled = true;
      delete root.dataset.windowMaterial;
    };
  }, [settings.windowMaterial.enabled]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.reducedMotion) {
      root.dataset.reducedMotion = "true";
      return () => {
        delete root.dataset.reducedMotion;
      };
    }
    if (typeof window.matchMedia !== "function") {
      delete root.dataset.reducedMotion;
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyReducedMotion = () => {
      if (mediaQuery.matches) {
        root.dataset.reducedMotion = "true";
      } else {
        delete root.dataset.reducedMotion;
      }
    };
    applyReducedMotion();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", applyReducedMotion);
      return () => {
        mediaQuery.removeEventListener("change", applyReducedMotion);
        delete root.dataset.reducedMotion;
      };
    }
    mediaQuery.addListener?.(applyReducedMotion);
    return () => {
      mediaQuery.removeListener?.(applyReducedMotion);
      delete root.dataset.reducedMotion;
    };
  }, [settings.reducedMotion]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.appearance === "dark") {
      root.classList.add("dark");
      return;
    }
    root.classList.remove("dark");
    if (settings.appearance !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemAppearance = () => {
      root.classList.toggle("dark", mediaQuery.matches);
    };
    applySystemAppearance();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", applySystemAppearance);
      return () => mediaQuery.removeEventListener("change", applySystemAppearance);
    }
    mediaQuery.addListener?.(applySystemAppearance);
    return () => {
      mediaQuery.removeListener?.(applySystemAppearance);
    };
  }, [settings.appearance]);

  useEffect(() => {
    let cancelled = false;
    const windowApi = window.planweaveWindow;
    if (!windowApi) {
      return;
    }
    const applyWindowMaterial = async () => {
      const capabilities = windowApi.getWindowMaterialCapabilities
        ? await windowApi.getWindowMaterialCapabilities()
        : { supported: true };
      if (cancelled) {
        return;
      }
      await windowApi.setWindowMaterial({
        appearance: settings.appearance,
        enabled: settings.windowMaterial.enabled && capabilities.supported
      });
    };
    void applyWindowMaterial().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [settings.appearance, settings.windowMaterial.enabled]);
}

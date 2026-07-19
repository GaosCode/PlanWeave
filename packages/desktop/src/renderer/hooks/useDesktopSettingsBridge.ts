import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanWeaveDesktopSettingsApi } from "../../shared/desktopSettings";
import {
  defaultDesktopSettings,
  legacyDesktopSettingsKey,
  legacyDesktopSettingsMigrationMarkerKey
} from "../../shared/desktopSettings";
import { settingsBridge } from "../bridge";
import { mergeDesktopSettings } from "../settings";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";

type LayoutSettingsPatch = {
  leftSidebar?: Partial<DesktopUiSettings["layout"]["leftSidebar"]>;
  rightSidebar?: Partial<DesktopUiSettings["layout"]["rightSidebar"]>;
  autoRunControl?: Partial<DesktopUiSettings["layout"]["autoRunControl"]>;
};

type UseDesktopSettingsBridgeArgs = {
  setError: (message: string | null) => void;
  settingsApi?: PlanWeaveDesktopSettingsApi | null;
  allowInMemoryFallback?: boolean;
};

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function legacyStorage(): Storage | null {
  return typeof window !== "undefined" ? window.localStorage : null;
}

function readLegacyDesktopSettingsPayload(): string | null {
  return legacyStorage()?.getItem(legacyDesktopSettingsKey) ?? null;
}

function writeLegacyMigrationMarker(): void {
  legacyStorage()?.setItem(legacyDesktopSettingsMigrationMarkerKey, "1");
}

const missingSettingsBridgeMessage = "Desktop settings bridge is unavailable.";

export function useDesktopSettingsBridge({
  setError,
  settingsApi = settingsBridge,
  allowInMemoryFallback = false
}: UseDesktopSettingsBridgeArgs) {
  const [settings, setSettings] = useState<DesktopUiSettings>(defaultDesktopSettings);
  const latestSettingsRef = useRef<DesktopUiSettings>(defaultDesktopSettings);
  const lastConfirmedSettingsRef = useRef<DesktopUiSettings>(defaultDesktopSettings);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const refreshQueueRef = useRef<Promise<void>>(Promise.resolve());
  const localRevisionRef = useRef(0);
  const initializationRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!settingsApi) {
      if (!allowInMemoryFallback) {
        setError(missingSettingsBridgeMessage);
      }
      return;
    }
    let cancelled = false;

    const loadSettings = async (options: { migrateLegacy: boolean }) => {
      try {
        const loaded = await settingsApi.getDesktopSettings();
        if (cancelled) {
          return;
        }
        lastConfirmedSettingsRef.current = loaded;
        if (localRevisionRef.current === 0) {
          latestSettingsRef.current = loaded;
          setSettings(loaded);
        }

        const legacyPayload = options.migrateLegacy ? readLegacyDesktopSettingsPayload() : null;
        if (!legacyPayload) {
          return;
        }

        const migrated = await settingsApi.migrateLegacyDesktopSettings(legacyPayload);
        if (cancelled) {
          return;
        }
        lastConfirmedSettingsRef.current = migrated;
        if (localRevisionRef.current === 0) {
          latestSettingsRef.current = migrated;
          setSettings(migrated);
        }
        writeLegacyMigrationMarker();
      } catch (caught) {
        if (!cancelled) {
          setError(errorMessage(caught));
        }
      }
    };

    const initialization = loadSettings({ migrateLegacy: true });
    initializationRef.current = initialization;
    refreshQueueRef.current = initialization;
    void initialization;
    const refreshOnFocus = () => {
      refreshQueueRef.current = refreshQueueRef.current
        .catch(() => undefined)
        .then(() => loadSettings({ migrateLegacy: false }));
      void refreshQueueRef.current;
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [allowInMemoryFallback, setError, settingsApi]);

  const updateSettingsAndWait = useCallback(
    (update: DesktopSettingsUpdate) => {
      if (!settingsApi && !allowInMemoryFallback) {
        setError(missingSettingsBridgeMessage);
        return Promise.resolve();
      }
      const patch = typeof update === "function" ? update(latestSettingsRef.current) : update;
      const nextRevision = localRevisionRef.current + 1;
      localRevisionRef.current = nextRevision;
      const optimisticSettings = mergeDesktopSettings(latestSettingsRef.current, patch);
      latestSettingsRef.current = optimisticSettings;
      setSettings(optimisticSettings);

      if (!settingsApi) {
        return Promise.resolve();
      }
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => initializationRef.current)
        .then(() => settingsApi.saveDesktopSettings(patch))
        .then((nextSettings) => {
          lastConfirmedSettingsRef.current = nextSettings;
          if (localRevisionRef.current === nextRevision) {
            latestSettingsRef.current = nextSettings;
            setSettings(nextSettings);
          }
        })
        .catch((caught: unknown) => {
          if (localRevisionRef.current === nextRevision) {
            latestSettingsRef.current = lastConfirmedSettingsRef.current;
            setSettings(lastConfirmedSettingsRef.current);
          }
          setError(errorMessage(caught));
        });
      void saveQueueRef.current;
      return saveQueueRef.current;
    },
    [allowInMemoryFallback, setError, settingsApi]
  );

  const updateSettings = useCallback(
    (update: DesktopSettingsUpdate) => {
      void updateSettingsAndWait(update);
    },
    [updateSettingsAndWait]
  );

  const updateLayoutSettings = useCallback(
    (patch: LayoutSettingsPatch) => {
      updateSettings({ layout: patch });
    },
    [updateSettings]
  );

  return {
    settings,
    updateLayoutSettings,
    updateSettings,
    updateSettingsAndWait
  };
}

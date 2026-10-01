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
  collaborationScope?: Partial<DesktopUiSettings["layout"]["collaborationScope"]>;
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
  const [settingsHydrated, setSettingsHydrated] = useState(!settingsApi);
  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;
  const latestSettingsRef = useRef<DesktopUiSettings>(defaultDesktopSettings);
  const lastConfirmedSettingsRef = useRef<DesktopUiSettings>(defaultDesktopSettings);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const refreshQueueRef = useRef<Promise<void>>(Promise.resolve());
  const localRevisionRef = useRef(0);
  const pendingSavesRef = useRef(0);
  const confirmedVersionRef = useRef(0);
  const effectVersionRef = useRef(0);
  const mountedRef = useRef(false);
  const initializationRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    mountedRef.current = true;
    effectVersionRef.current += 1;
    if (!settingsApi) {
      setSettingsHydrated(true);
      if (!allowInMemoryFallback) {
        setErrorRef.current(missingSettingsBridgeMessage);
      }
      return () => {
        mountedRef.current = false;
      };
    }
    let cancelled = false;
    setSettingsHydrated(false);

    const loadSettings = async (options: { migrateLegacy: boolean }) => {
      const revision = localRevisionRef.current;
      const confirmedVersion = confirmedVersionRef.current;
      const applyLoaded = (loaded: DesktopUiSettings) => {
        if (confirmedVersionRef.current !== confirmedVersion) {
          return;
        }
        lastConfirmedSettingsRef.current = loaded;
        if (localRevisionRef.current === revision && pendingSavesRef.current === 0) {
          latestSettingsRef.current = loaded;
          setSettings(loaded);
        }
      };
      try {
        const loaded = await settingsApi.getDesktopSettings();
        if (cancelled) {
          return;
        }
        applyLoaded(loaded);

        const legacyPayload = options.migrateLegacy ? readLegacyDesktopSettingsPayload() : null;
        if (!legacyPayload) {
          return;
        }

        const migrated = await settingsApi.migrateLegacyDesktopSettings(legacyPayload);
        if (cancelled) {
          return;
        }
        applyLoaded(migrated);
        writeLegacyMigrationMarker();
      } catch (caught) {
        if (!cancelled) {
          setErrorRef.current(errorMessage(caught));
        }
      }
    };

    const initialization = loadSettings({ migrateLegacy: true }).finally(() => {
      if (!cancelled) {
        setSettingsHydrated(true);
      }
    });
    initializationRef.current = initialization;
    refreshQueueRef.current = initialization;
    void initialization;
    const refreshOnFocus = () => {
      refreshQueueRef.current = refreshQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          while (!cancelled && pendingSavesRef.current > 0) {
            await saveQueueRef.current;
          }
          if (!cancelled) {
            await loadSettings({ migrateLegacy: false });
          }
        });
      void refreshQueueRef.current;
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [allowInMemoryFallback, settingsApi]);

  const updateSettingsAndWait = useCallback(
    (update: DesktopSettingsUpdate) => {
      if (!settingsApi && !allowInMemoryFallback) {
        setError(missingSettingsBridgeMessage);
        return Promise.reject(new Error(missingSettingsBridgeMessage));
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
      const effectVersion = effectVersionRef.current;
      const isCurrentEffect = () =>
        mountedRef.current && effectVersionRef.current === effectVersion;
      pendingSavesRef.current += 1;
      const save = saveQueueRef.current
        .then(() => initializationRef.current)
        .then(() => settingsApi.saveDesktopSettings(patch));
      const callerSave = save
        .then((nextSettings) => {
          if (!isCurrentEffect()) {
            return;
          }
          confirmedVersionRef.current += 1;
          lastConfirmedSettingsRef.current = nextSettings;
          if (localRevisionRef.current === nextRevision) {
            latestSettingsRef.current = nextSettings;
            setSettings(nextSettings);
          }
        })
        .catch((caught: unknown) => {
          if (isCurrentEffect() && localRevisionRef.current === nextRevision) {
            latestSettingsRef.current = lastConfirmedSettingsRef.current;
            setSettings(lastConfirmedSettingsRef.current);
          }
          if (isCurrentEffect()) {
            setErrorRef.current(errorMessage(caught));
          }
          throw caught;
        })
        .finally(() => {
          pendingSavesRef.current -= 1;
        });
      saveQueueRef.current = callerSave.then(
        () => undefined,
        () => undefined
      );
      return callerSave;
    },
    [allowInMemoryFallback, setError, settingsApi]
  );

  const updateSettings = useCallback(
    (update: DesktopSettingsUpdate) => {
      void updateSettingsAndWait(update).catch(() => undefined);
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
    settingsHydrated,
    updateLayoutSettings,
    updateSettings,
    updateSettingsAndWait
  };
}

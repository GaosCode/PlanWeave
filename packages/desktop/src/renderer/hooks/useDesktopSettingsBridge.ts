import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopAgentHost, PlanWeaveDesktopSettingsApi } from "../../shared/desktopSettings";
import {
  defaultDesktopSettings,
  desktopAgentHostKey,
  legacyDesktopSettingsKey,
  legacyDesktopSettingsMigrationMarkerKey
} from "../../shared/desktopSettings";
import { settingsBridge } from "../bridge";
import { beginDesktopHomeTransition } from "../desktopHomeTransition";
import { mergeDesktopSettings } from "../settings";
import type { DesktopSettingsUpdate, DesktopUiSettings, PersistDesktopSettings } from "../types";

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

function withAgentHost(
  settings: DesktopUiSettings,
  agentHost: DesktopAgentHost
): DesktopUiSettings {
  return { ...settings, execution: { ...settings.execution, agentHost } };
}

export function useDesktopSettingsBridge({
  setError,
  settingsApi = settingsBridge,
  allowInMemoryFallback = false
}: UseDesktopSettingsBridgeArgs) {
  const [settings, setSettings] = useState<DesktopUiSettings>(defaultDesktopSettings);
  const [settingsHydrated, setSettingsHydrated] = useState(!settingsApi);
  const [pendingHomeSaves, setPendingHomeSaves] = useState(0);
  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;
  const latestSettingsRef = useRef<DesktopUiSettings>(defaultDesktopSettings);
  const lastConfirmedSettingsRef = useRef<DesktopUiSettings>(defaultDesktopSettings);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const refreshQueueRef = useRef<Promise<void>>(Promise.resolve());
  const refreshSettingsRef = useRef<((options?: { reconcileAfterSave: boolean }) => void) | null>(
    null
  );
  const localRevisionRef = useRef(0);
  const pendingSavesRef = useRef(0);
  const pendingHomeSavesRef = useRef(0);
  const settledHomeTransitions = useRef<Array<() => void>>([]);
  const confirmedVersionRef = useRef(0);
  const agentHostVersionRef = useRef(0);
  const effectVersionRef = useRef(0);
  const mountedRef = useRef(false);
  const initializationRef = useRef<Promise<void>>(Promise.resolve());
  const retainNewerAgentHost = useCallback(
    (snapshot: DesktopUiSettings, agentHostVersion: number) => {
      const confirmedHost = lastConfirmedSettingsRef.current.execution.agentHost;
      return agentHostVersionRef.current !== agentHostVersion ||
        desktopAgentHostKey(snapshot.execution.agentHost) === desktopAgentHostKey(confirmedHost)
        ? withAgentHost(snapshot, confirmedHost)
        : snapshot;
    },
    []
  );
  useLayoutEffect(() => {
    if (pendingHomeSaves === 0) {
      for (const release of settledHomeTransitions.current.splice(0)) release();
    }
  });
  useLayoutEffect(
    () => () => {
      for (const release of settledHomeTransitions.current.splice(0)) release();
    },
    []
  );

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
    const unsubscribeAgentHost = settingsApi.onAgentHostChanged((agentHost) => {
      if (
        desktopAgentHostKey(agentHost) ===
        desktopAgentHostKey(lastConfirmedSettingsRef.current.execution.agentHost)
      ) {
        return;
      }
      agentHostVersionRef.current += 1;
      lastConfirmedSettingsRef.current = withAgentHost(lastConfirmedSettingsRef.current, agentHost);
      latestSettingsRef.current = withAgentHost(latestSettingsRef.current, agentHost);
      setSettings(latestSettingsRef.current);
    });

    const loadSettings = async (options: {
      migrateLegacy: boolean;
    }): Promise<"superseded" | "finished"> => {
      const revision = localRevisionRef.current;
      const confirmedVersion = confirmedVersionRef.current;
      const applyLoaded = (loaded: DesktopUiSettings, agentHostVersion: number) => {
        if (confirmedVersionRef.current !== confirmedVersion) {
          return false;
        }
        const confirmed = retainNewerAgentHost(loaded, agentHostVersion);
        lastConfirmedSettingsRef.current = confirmed;
        if (localRevisionRef.current !== revision || pendingSavesRef.current !== 0) {
          return false;
        }
        latestSettingsRef.current = confirmed;
        setSettings(confirmed);
        return true;
      };
      try {
        const readAgentHostVersion = agentHostVersionRef.current;
        const loaded = await settingsApi.getDesktopSettings();
        if (cancelled) {
          return "finished";
        }
        const published = applyLoaded(loaded, readAgentHostVersion);
        if (!options.migrateLegacy) {
          return published ? "finished" : "superseded";
        }

        const legacyPayload = readLegacyDesktopSettingsPayload();
        if (!legacyPayload) {
          return "finished";
        }

        const migrationAgentHostVersion = agentHostVersionRef.current;
        const migrated = await settingsApi.migrateLegacyDesktopSettings(legacyPayload);
        if (cancelled) {
          return "finished";
        }
        applyLoaded(migrated, migrationAgentHostVersion);
        writeLegacyMigrationMarker();
      } catch (caught) {
        if (!cancelled) {
          setErrorRef.current(errorMessage(caught));
        }
      }
      return "finished";
    };

    const initialization = loadSettings({ migrateLegacy: true })
      .then(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setSettingsHydrated(true);
        }
      });
    initializationRef.current = initialization;
    refreshQueueRef.current = initialization;
    void initialization;
    const refreshCurrentSettings = ({ reconcileAfterSave } = { reconcileAfterSave: false }) => {
      refreshQueueRef.current = refreshQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          while (!cancelled) {
            if (pendingSavesRef.current > 0) {
              await saveQueueRef.current;
            } else {
              const loaded = await loadSettings({ migrateLegacy: false });
              if (!reconcileAfterSave || loaded === "finished") return;
            }
          }
        });
      void refreshQueueRef.current;
    };
    refreshSettingsRef.current = refreshCurrentSettings;
    const refreshOnFocus = () => refreshCurrentSettings();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      refreshSettingsRef.current = null;
      unsubscribeAgentHost();
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [allowInMemoryFallback, retainNewerAgentHost, settingsApi]);

  const refreshSettings = useCallback(() => {
    refreshSettingsRef.current?.();
  }, []);

  const updateSettingsAndWait = useCallback<PersistDesktopSettings>(
    (update, expectedAgentHost, scope) => {
      if (!settingsApi && !allowInMemoryFallback) {
        if (scope) {
          if (scope.isCurrent()) scope.onError(missingSettingsBridgeMessage);
        } else {
          setError(missingSettingsBridgeMessage);
        }
        return Promise.reject(new Error(missingSettingsBridgeMessage));
      }
      const patch = typeof update === "function" ? update(latestSettingsRef.current) : update;
      const publishesOptimistically = !expectedAgentHost || !settingsApi;
      const optimisticRevision = publishesOptimistically
        ? ++localRevisionRef.current
        : localRevisionRef.current;
      const optimisticSettings = mergeDesktopSettings(latestSettingsRef.current, patch);
      if (settingsApi && patch.execution?.agentHost) {
        optimisticSettings.execution.agentHost = latestSettingsRef.current.execution.agentHost;
      }
      const changesHome = settingsApi !== null && patch.planweaveHome !== undefined;
      const releaseHomeTransition = changesHome ? beginDesktopHomeTransition() : null;
      if (changesHome) {
        pendingHomeSavesRef.current += 1;
        setPendingHomeSaves(pendingHomeSavesRef.current);
        optimisticSettings.planweaveHome = latestSettingsRef.current.planweaveHome;
      }
      if (publishesOptimistically) {
        latestSettingsRef.current = optimisticSettings;
        setSettings(optimisticSettings);
      }

      if (!settingsApi) {
        return Promise.resolve();
      }
      const effectVersion = effectVersionRef.current;
      const expectedAgentHostVersion = agentHostVersionRef.current;
      const isCurrentEffect = () =>
        mountedRef.current && effectVersionRef.current === effectVersion;
      const isExpectedHostCurrent = () =>
        !expectedAgentHost ||
        (agentHostVersionRef.current === expectedAgentHostVersion &&
          lastConfirmedSettingsRef.current.execution.agentHost === expectedAgentHost);
      const isSaveCurrent = () =>
        isCurrentEffect() && isExpectedHostCurrent() && (!scope || scope.isCurrent());
      const publishSettings = (nextSettings: DesktopUiSettings) => {
        const visibleSettings =
          pendingHomeSavesRef.current > 0
            ? { ...nextSettings, planweaveHome: latestSettingsRef.current.planweaveHome }
            : nextSettings;
        latestSettingsRef.current = visibleSettings;
        setSettings(visibleSettings);
      };
      pendingSavesRef.current += 1;
      const save = saveQueueRef.current
        .then(() => initializationRef.current)
        .then(async () => {
          const agentHostVersion = agentHostVersionRef.current;
          if ((expectedAgentHost || scope) && !isSaveCurrent()) {
            return null;
          }
          const nextSettings = expectedAgentHost
            ? await settingsApi.saveDesktopSettings(patch, expectedAgentHost)
            : await settingsApi.saveDesktopSettings(patch);
          return { nextSettings, agentHostVersion };
        });
      const callerSave = save
        .then((result) => {
          if (!result || !isCurrentEffect()) {
            return;
          }
          confirmedVersionRef.current += 1;
          if (!isSaveCurrent()) {
            refreshSettingsRef.current?.({ reconcileAfterSave: true });
            return;
          }
          const { nextSettings, agentHostVersion } = result;
          const confirmed = retainNewerAgentHost(nextSettings, agentHostVersion);
          lastConfirmedSettingsRef.current = confirmed;
          if (localRevisionRef.current === optimisticRevision) {
            publishSettings(confirmed);
          } else if (patch.execution?.agentHost) {
            publishSettings(
              withAgentHost(latestSettingsRef.current, confirmed.execution.agentHost)
            );
          }
        })
        .catch((caught: unknown) => {
          if (isSaveCurrent()) {
            if (publishesOptimistically && localRevisionRef.current === optimisticRevision) {
              publishSettings(lastConfirmedSettingsRef.current);
            }
            const reportError = scope ? scope.onError : setErrorRef.current;
            reportError(errorMessage(caught));
          }
          throw caught;
        })
        .finally(() => {
          pendingSavesRef.current -= 1;
          if (releaseHomeTransition) {
            pendingHomeSavesRef.current -= 1;
            if (mountedRef.current) {
              setPendingHomeSaves(pendingHomeSavesRef.current);
            }
            if (isCurrentEffect() && pendingHomeSavesRef.current === 0) {
              publishSettings({
                ...latestSettingsRef.current,
                planweaveHome: lastConfirmedSettingsRef.current.planweaveHome
              });
            }
            if (mountedRef.current && pendingHomeSavesRef.current === 0) {
              // Keep admission closed until the confirmed Home reaches the renderer commit.
              settledHomeTransitions.current.push(releaseHomeTransition);
            } else releaseHomeTransition();
          }
        });
      saveQueueRef.current = callerSave.then(
        () => undefined,
        () => undefined
      );
      return callerSave;
    },
    [allowInMemoryFallback, retainNewerAgentHost, setError, settingsApi]
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
    refreshSettings,
    settings,
    settingsHydrated: settingsHydrated && pendingHomeSaves === 0,
    updateLayoutSettings,
    updateSettings,
    updateSettingsAndWait
  };
}

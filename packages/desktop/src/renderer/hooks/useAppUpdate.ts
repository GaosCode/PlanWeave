import { useCallback, useEffect, useState } from "react";
import type { AppUpdateState } from "../../shared/appUpdate";

function idleState(): AppUpdateState {
  return {
    status: "idle",
    checkedAt: null,
    currentVersion: "",
    delivery: "in-app",
    error: null,
    progress: null,
    update: null,
    updatedAt: new Date(0).toISOString()
  };
}

export function useAppUpdate({ setError }: { setError: (message: string | null) => void }) {
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(() => idleState());
  const appUpdateApi = typeof window !== "undefined" ? window.planweaveAppUpdate : undefined;

  useEffect(() => {
    if (!appUpdateApi) {
      return;
    }
    let cancelled = false;
    void appUpdateApi.getAppUpdateState().then((state) => {
      if (!cancelled) {
        setAppUpdateState(state);
      }
    });
    const unsubscribe = appUpdateApi.onAppUpdateChanged((state) => {
      setAppUpdateState(state);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [appUpdateApi]);

  const checkForAppUpdate = useCallback(async () => {
    if (!appUpdateApi) {
      setError("Desktop update bridge unavailable.");
      return;
    }
    const nextState = await appUpdateApi.checkForAppUpdate();
    setAppUpdateState(nextState);
  }, [appUpdateApi, setError]);

  const downloadAppUpdate = useCallback(async () => {
    if (!appUpdateApi) {
      setError("Desktop update bridge unavailable.");
      return;
    }
    const nextState = await appUpdateApi.downloadAppUpdate();
    setAppUpdateState(nextState);
  }, [appUpdateApi, setError]);

  const installAppUpdate = useCallback(async () => {
    if (!appUpdateApi) {
      setError("Desktop update bridge unavailable.");
      return;
    }
    const nextState = await appUpdateApi.installAppUpdate();
    setAppUpdateState(nextState);
  }, [appUpdateApi, setError]);

  return {
    appUpdateAvailable: Boolean(appUpdateApi),
    appUpdateState,
    checkForAppUpdate,
    downloadAppUpdate,
    installAppUpdate
  };
}

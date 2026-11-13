import { useCallback, useEffect, useRef, useState } from "react";
import type { AppUpdateState, PlanWeaveAppUpdateApi } from "../../shared/appUpdate";
import { desktopCommandBridge } from "../desktopCommandBridge.js";

type UpdateCommand = "checkForAppUpdate" | "downloadAppUpdate" | "installAppUpdate";

type UpdateSession = {
  api: PlanWeaveAppUpdateApi;
  latestState: AppUpdateState | null;
  eventRevision: number;
  actionStarted: boolean;
  actionPending: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAppUpdateController() {
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null);
  const [appUpdatePending, setAppUpdatePending] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const activeSession = useRef<UpdateSession | null>(null);
  const api = typeof window === "undefined" ? undefined : window.planweaveAppUpdate;
  const appUpdateApi = api ? desktopCommandBridge(api) : undefined;

  const publish = useCallback((session: UpdateSession, state: AppUpdateState) => {
    session.latestState = state;
    setAppUpdateState(state);
  }, []);

  useEffect(() => {
    if (!appUpdateApi) return;
    const session: UpdateSession = {
      api: appUpdateApi,
      latestState: null,
      eventRevision: 0,
      actionStarted: false,
      actionPending: false
    };
    activeSession.current = session;
    setAppUpdateState(null);
    setAppUpdatePending(false);
    setAppUpdateError(null);
    const unsubscribe = appUpdateApi.onAppUpdateChanged((state) => {
      if (activeSession.current !== session) return;
      session.eventRevision += 1;
      publish(session, state);
      setAppUpdateError(null);
    });
    const readInitialState = async () => {
      try {
        const state = await appUpdateApi.getAppUpdateState();
        if (activeSession.current !== session || session.actionStarted) return;
        if (!session.latestState || state.updatedAt > session.latestState.updatedAt) {
          publish(session, state);
        }
      } catch (error) {
        if (activeSession.current === session && !session.actionStarted && !session.latestState) {
          setAppUpdateError(errorMessage(error));
        }
      }
    };
    void readInitialState();
    return () => {
      activeSession.current = null;
      unsubscribe();
    };
  }, [appUpdateApi, publish]);

  const runAction = useCallback(
    async (command: UpdateCommand) => {
      const session = activeSession.current;
      if (!session || session.api !== appUpdateApi || session.actionPending) return;
      const status = session.latestState?.status;
      if (status === "checking" || status === "downloading" || status === "unsupported") return;
      if (command === "downloadAppUpdate" && status !== "available") return;
      if (
        command === "installAppUpdate" &&
        (status !== "downloaded" || session.latestState?.delivery !== "in-app")
      ) {
        return;
      }

      const eventRevision = session.eventRevision;
      session.actionStarted = true;
      session.actionPending = true;
      setAppUpdatePending(true);
      setAppUpdateError(null);
      try {
        const state = await session.api[command]();
        if (activeSession.current !== session) return;
        const latest = session.latestState;
        if (
          !latest ||
          eventRevision === session.eventRevision ||
          state.updatedAt > latest.updatedAt
        ) {
          publish(session, state);
        }
      } catch (error) {
        if (activeSession.current === session) {
          setAppUpdateError(errorMessage(error));
        }
      } finally {
        session.actionPending = false;
        if (activeSession.current === session) setAppUpdatePending(false);
      }
    },
    [appUpdateApi, publish]
  );

  return {
    appUpdateAvailable: Boolean(appUpdateApi),
    appUpdatePending,
    appUpdateState,
    appUpdateError,
    checkForAppUpdate: () => runAction("checkForAppUpdate"),
    downloadAppUpdate: () => runAction("downloadAppUpdate"),
    installAppUpdate: () => runAction("installAppUpdate")
  };
}

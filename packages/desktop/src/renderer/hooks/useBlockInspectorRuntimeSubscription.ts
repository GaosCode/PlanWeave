import { useCallback, useEffect, useRef } from "react";
import { bridge } from "../bridge";
import { beginDesktopWatchRegistration } from "../desktopWatchRegistration";

export function useBlockInspectorRuntimeSubscription({
  projectRoot,
  canvasId,
  refresh,
  setError
}: {
  projectRoot: string;
  canvasId: string | null;
  refresh: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!bridge || !projectRoot) return;
    const runtimeBridge = bridge;
    let active = true;
    let registration: ReturnType<typeof beginDesktopWatchRegistration> | null = null;
    let pending: Promise<void> | null = null;
    const retire = () => {
      if (!registration) return;
      const retiring = registration;
      registration = null;
      retiring.retire();
      void runtimeBridge.unwatchRuntimeState(retiring.reference).catch((caught: unknown) => {
        console.error(caught);
      });
    };
    const unsubscribe = runtimeBridge.onRuntimeStateChanged((event) => {
      if (
        !active ||
        !registration ||
        event.registrationId !== registration.reference.registrationId ||
        event.projectRoot !== projectRoot ||
        event.workspaceRoot !== registration.reference.workspaceRoot ||
        event.canvasId !== canvasId
      )
        return;
      void refresh();
    });
    const start = (): Promise<void> => {
      if (pending) return pending;
      if (!active || registration) return Promise.resolve();
      pending = (async () => {
        const projects = await runtimeBridge.listProjects();
        if (!active) return;
        const project = projects.find((candidate) => candidate.rootPath === projectRoot);
        if (!project) return;
        registration = beginDesktopWatchRegistration(project, canvasId);
        await runtimeBridge.watchRuntimeState(registration.reference);
        if (active) await refresh();
      })()
        .catch((caught: unknown) => {
          retire();
          if (active) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    };
    retryRef.current = start;
    void start();
    return () => {
      active = false;
      if (retryRef.current === start) retryRef.current = null;
      unsubscribe();
      retire();
    };
  }, [canvasId, projectRoot, refresh, setError]);
  return useCallback(async () => {
    await retryRef.current?.();
  }, []);
}

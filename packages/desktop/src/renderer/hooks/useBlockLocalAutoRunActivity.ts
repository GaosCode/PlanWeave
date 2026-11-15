import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopAutoRunActivityScope } from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { LocalAutoRunActivity } from "../collaboration/remoteRunViewModels";

export function useBlockLocalAutoRunActivity(
  projectRoot: string,
  canvasId: string | null,
  blockRef: string | null
) {
  const selection = useMemo(
    () => ({ projectRoot, canvasId, blockRef }),
    [projectRoot, canvasId, blockRef]
  );
  const [snapshot, setSnapshot] = useState<{
    selection: typeof selection;
    activity: LocalAutoRunActivity;
  } | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!bridge || !selection.projectRoot || !selection.blockRef) return;
    const runtime = bridge;
    const { projectRoot, canvasId, blockRef } = selection;
    let active = true;
    let generation = 0;
    let scope: DesktopAutoRunActivityScope | null = null;
    let reading = false;
    let changedBeforeFirstRead = false;
    const refresh = async () => {
      const request = ++generation;
      const isCurrent = () => active && request === generation;
      reading = true;
      try {
        const activity = await runtime.getAutoRunActivity({ projectRoot, canvasId });
        if (!isCurrent()) return;
        scope = activity.scope;
        if (changedBeforeFirstRead) {
          changedBeforeFirstRead = false;
          await refresh();
          return;
        }
        setSnapshot({
          selection,
          activity: activity.activeBlockRefs.includes(blockRef) ? "active" : "inactive"
        });
      } catch (error) {
        if (!isCurrent()) return;
        changedBeforeFirstRead = false;
        console.error("Could not read local Auto Run activity.", error);
        setSnapshot({ selection, activity: "unavailable" });
      } finally {
        if (isCurrent()) reading = false;
      }
    };
    refreshRef.current = refresh;
    const unsubscribe = runtime.onAutoRunActivityChanged((event) => {
      if (!active) return;
      if (!scope) {
        if (reading) changedBeforeFirstRead = true;
        else void refresh();
        return;
      }
      if (
        event.scope.projectId === scope.projectId &&
        (event.scope.canvasKey === scope.canvasKey || canvasId === null)
      )
        void refresh();
    });
    void refresh();
    return () => {
      active = false;
      if (refreshRef.current === refresh) refreshRef.current = null;
      unsubscribe();
    };
  }, [selection]);

  return {
    activity:
      snapshot?.selection === selection ? snapshot.activity : bridge ? "checking" : "unavailable",
    refresh: useCallback(async () => {
      await refreshRef.current?.();
    }, [])
  };
}

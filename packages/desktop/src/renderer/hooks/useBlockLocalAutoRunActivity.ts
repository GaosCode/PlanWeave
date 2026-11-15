import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { autoRunEventMatchesInspectorCanvas } from "../autoRunEvents";
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
    const refresh = async () => {
      const request = ++generation;
      const isCurrent = () => active && request === generation;
      try {
        const refs = await runtime.listActiveAutoRunBlockRefs({ projectRoot, canvasId });
        if (isCurrent()) {
          setSnapshot({ selection, activity: refs.includes(blockRef) ? "active" : "inactive" });
        }
      } catch (error) {
        if (!isCurrent()) return;
        console.error("Could not read local Auto Run activity.", error);
        setSnapshot({ selection, activity: "unavailable" });
      }
    };
    refreshRef.current = refresh;
    const unsubscribe = runtime.onAutoRunActivityChanged((event) => {
      if (
        active &&
        (autoRunEventMatchesInspectorCanvas(event, projectRoot, canvasId) ||
          (event.projectRoot === projectRoot && (event.canvasId === null || canvasId === null)))
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

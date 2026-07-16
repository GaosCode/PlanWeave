import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopCanvasGraphViewModel,
  DesktopCanvasMapLayout,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { CanvasFlowNode } from "../types";

type UseCanvasMapArgs = {
  activeCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
};

type LayoutPendingOperation = "load" | "save" | "reset" | null;

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function useCanvasMap({ activeCanvasId, selectedProject, setError }: UseCanvasMapArgs) {
  const [canvasGraph, setCanvasGraph] = useState<DesktopCanvasGraphViewModel | null>(null);
  /** Working layout shown on the map (may be dirty after a failed save). */
  const [canvasMapLayout, setCanvasMapLayout] = useState<DesktopCanvasMapLayout | null>(null);
  /** Last layout confirmed persisted by the runtime. */
  const [persistedCanvasMapLayout, setPersistedCanvasMapLayout] =
    useState<DesktopCanvasMapLayout | null>(null);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [layoutPending, setLayoutPending] = useState<LayoutPendingOperation>(null);
  const [selectedMapCanvasId, setSelectedMapCanvasId] = useState<string | null>(null);

  /** Single epoch across load/save/reset so a late response cannot cross a newer mutation. */
  const layoutEpochRef = useRef(0);
  const projectRootRef = useRef<string | null>(null);
  const workingLayoutRef = useRef<DesktopCanvasMapLayout | null>(null);
  const layoutDirtyRef = useRef(false);

  useEffect(() => {
    workingLayoutRef.current = canvasMapLayout;
  }, [canvasMapLayout]);

  useEffect(() => {
    layoutDirtyRef.current = layoutDirty;
  }, [layoutDirty]);

  useEffect(() => {
    const nextRoot = selectedProject?.rootPath ?? null;
    if (projectRootRef.current !== nextRoot) {
      projectRootRef.current = nextRoot;
      setCanvasGraph(null);
      setCanvasMapLayout(null);
      setPersistedCanvasMapLayout(null);
      setLayoutDirty(false);
      setLayoutPending(null);
      setSelectedMapCanvasId(null);
      layoutEpochRef.current += 1;
    }
  }, [selectedProject?.rootPath]);

  const loadCanvasMap = useCallback(async () => {
    if (!bridge || !selectedProject) {
      setCanvasGraph(null);
      setCanvasMapLayout(null);
      setPersistedCanvasMapLayout(null);
      setLayoutDirty(false);
      setLayoutPending(null);
      setSelectedMapCanvasId(null);
      return;
    }

    const epoch = layoutEpochRef.current + 1;
    layoutEpochRef.current = epoch;
    setLayoutPending("load");
    setError(null);

    const projectRoot = selectedProject.rootPath;
    const [graphResult, layoutResult] = await Promise.allSettled([
      bridge.getCanvasGraphViewModel(projectRoot),
      bridge.getCanvasMapLayout(projectRoot)
    ]);

    if (layoutEpochRef.current !== epoch || projectRootRef.current !== projectRoot) {
      return;
    }

    const errors: string[] = [];
    if (graphResult.status === "fulfilled") {
      setCanvasGraph(graphResult.value);
      setSelectedMapCanvasId(
        (current) => current ?? activeCanvasId ?? graphResult.value.canvases[0]?.canvasId ?? null
      );
    } else {
      setCanvasGraph(null);
      errors.push(errorMessage(graphResult.reason));
    }

    if (layoutResult.status === "fulfilled") {
      // Disk is always the persisted baseline, but an unsaved working layout must
      // survive graph/name/policy reloads until explicit reset or successful save.
      setPersistedCanvasMapLayout(layoutResult.value);
      if (layoutDirtyRef.current && workingLayoutRef.current) {
        setCanvasMapLayout(workingLayoutRef.current);
        setLayoutDirty(true);
      } else {
        setCanvasMapLayout(layoutResult.value);
        setLayoutDirty(false);
      }
    } else {
      // Keep last-known-good working/persisted layout; only clear when never loaded.
      errors.push(errorMessage(layoutResult.reason));
    }

    if (errors.length > 0) {
      setError(errors.join("\n"));
    }
    setLayoutPending((current) => (current === "load" ? null : current));
  }, [activeCanvasId, selectedProject, setError]);

  useEffect(() => {
    void loadCanvasMap();
  }, [loadCanvasMap]);

  const persistWorkingLayout = useCallback(
    async (workingLayout: DesktopCanvasMapLayout) => {
      if (!bridge || !selectedProject) {
        return;
      }

      const projectRoot = selectedProject.rootPath;
      setCanvasMapLayout(workingLayout);
      setLayoutDirty(true);

      const epoch = layoutEpochRef.current + 1;
      layoutEpochRef.current = epoch;
      setLayoutPending("save");
      setError(null);

      try {
        const saved = await bridge.saveCanvasMapLayout(projectRoot, workingLayout);
        if (layoutEpochRef.current !== epoch || projectRootRef.current !== projectRoot) {
          return;
        }
        setCanvasMapLayout(saved);
        setPersistedCanvasMapLayout(saved);
        setLayoutDirty(false);
      } catch (caught: unknown) {
        if (layoutEpochRef.current !== epoch || projectRootRef.current !== projectRoot) {
          return;
        }
        // Working layout stays as the user-edited positions for retry.
        setError(errorMessage(caught));
      } finally {
        if (layoutEpochRef.current === epoch) {
          setLayoutPending((current) => (current === "save" ? null : current));
        }
      }
    },
    [selectedProject, setError]
  );

  const saveCanvasMapLayoutFromNodes = useCallback(
    async (nodes: CanvasFlowNode[]) => {
      if (!bridge || !selectedProject || !canvasMapLayout) {
        return;
      }

      const workingLayout: DesktopCanvasMapLayout = {
        ...canvasMapLayout,
        nodes: nodes.map((node) => ({
          canvasId: node.id,
          x: node.position.x,
          y: node.position.y
        }))
      };
      await persistWorkingLayout(workingLayout);
    },
    [canvasMapLayout, persistWorkingLayout, selectedProject]
  );

  const retrySaveCanvasMapLayout = useCallback(async () => {
    const working = workingLayoutRef.current;
    if (!working) {
      return;
    }
    await persistWorkingLayout(working);
  }, [persistWorkingLayout]);

  const resetCanvasMapLayout = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }

    const projectRoot = selectedProject.rootPath;
    const epoch = layoutEpochRef.current + 1;
    layoutEpochRef.current = epoch;
    setLayoutPending("reset");
    setError(null);

    try {
      const reset = await bridge.resetCanvasMapLayout(projectRoot);
      if (layoutEpochRef.current !== epoch || projectRootRef.current !== projectRoot) {
        return;
      }
      setCanvasMapLayout(reset);
      setPersistedCanvasMapLayout(reset);
      setLayoutDirty(false);
    } catch (caught: unknown) {
      if (layoutEpochRef.current !== epoch || projectRootRef.current !== projectRoot) {
        return;
      }
      // Leave working and persisted state unchanged on failure.
      setError(errorMessage(caught));
    } finally {
      if (layoutEpochRef.current === epoch) {
        setLayoutPending((current) => (current === "reset" ? null : current));
      }
    }
  }, [selectedProject, setError]);

  const selectedCanvas =
    canvasGraph?.canvases.find((canvas) => canvas.canvasId === selectedMapCanvasId) ?? null;

  return {
    canvasGraph,
    canvasMapLayout,
    layoutDirty,
    layoutPending,
    loadCanvasMap,
    persistedCanvasMapLayout,
    resetCanvasMapLayout,
    retrySaveCanvasMapLayout,
    saveCanvasMapLayoutFromNodes,
    selectedCanvas,
    selectedMapCanvasId,
    setSelectedMapCanvasId
  };
}

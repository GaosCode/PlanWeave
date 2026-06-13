import { useCallback, useEffect, useState } from "react";
import type { DesktopCanvasGraphViewModel, DesktopCanvasMapLayout, DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import type { CanvasFlowNode } from "../types";

type UseCanvasMapArgs = {
  activeCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
};

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function useCanvasMap({ activeCanvasId, selectedProject, setError }: UseCanvasMapArgs) {
  const [canvasGraph, setCanvasGraph] = useState<DesktopCanvasGraphViewModel | null>(null);
  const [canvasMapLayout, setCanvasMapLayout] = useState<DesktopCanvasMapLayout | null>(null);
  const [selectedMapCanvasId, setSelectedMapCanvasId] = useState<string | null>(null);

  const loadCanvasMap = useCallback(async () => {
    if (!bridge || !selectedProject) {
      setCanvasGraph(null);
      setCanvasMapLayout(null);
      setSelectedMapCanvasId(null);
      return;
    }
    const [graphResult, layoutResult] = await Promise.allSettled([
      bridge.getCanvasGraphViewModel(selectedProject.rootPath),
      bridge.getCanvasMapLayout(selectedProject.rootPath)
    ]);
    const errors: string[] = [];
    if (graphResult.status === "fulfilled") {
      setCanvasGraph(graphResult.value);
      setSelectedMapCanvasId((current) => current ?? activeCanvasId ?? graphResult.value.canvases[0]?.canvasId ?? null);
    } else {
      setCanvasGraph(null);
      errors.push(errorMessage(graphResult.reason));
    }
    if (layoutResult.status === "fulfilled") {
      setCanvasMapLayout(layoutResult.value);
    } else {
      setCanvasMapLayout(null);
      errors.push(errorMessage(layoutResult.reason));
    }
    if (errors.length > 0) {
      setError(errors.join("\n"));
    }
  }, [activeCanvasId, selectedProject, setError]);

  useEffect(() => {
    void loadCanvasMap();
  }, [loadCanvasMap]);

  const saveCanvasMapLayoutFromNodes = useCallback(
    async (nodes: CanvasFlowNode[]) => {
      if (!bridge || !selectedProject || !canvasMapLayout) {
        return;
      }
      const nextLayout: DesktopCanvasMapLayout = {
        ...canvasMapLayout,
        nodes: nodes.map((node) => ({
          canvasId: node.id,
          x: node.position.x,
          y: node.position.y
        }))
      };
      setCanvasMapLayout(await bridge.saveCanvasMapLayout(selectedProject.rootPath, nextLayout));
    },
    [canvasMapLayout, selectedProject]
  );

  const resetCanvasMapLayout = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    setCanvasMapLayout(await bridge.resetCanvasMapLayout(selectedProject.rootPath));
  }, [selectedProject]);

  const selectedCanvas = canvasGraph?.canvases.find((canvas) => canvas.canvasId === selectedMapCanvasId) ?? null;

  return {
    canvasGraph,
    canvasMapLayout,
    loadCanvasMap,
    resetCanvasMapLayout,
    saveCanvasMapLayoutFromNodes,
    selectedCanvas,
    selectedMapCanvasId,
    setSelectedMapCanvasId
  };
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import type { AppFlowNode } from "../types";

type GraphFlow = ReactFlowInstance<AppFlowNode, Edge>;

export function useGraphViewportLifecycle({
  graphScopeId,
  preserveSourceViewport,
  selectedTaskPanelId,
  setFlowInstance,
  visibleNodeCount
}: {
  graphScopeId: string | null;
  preserveSourceViewport: boolean;
  selectedTaskPanelId: string | null;
  setFlowInstance: Dispatch<SetStateAction<GraphFlow | null>>;
  visibleNodeCount: number;
}) {
  const [localFlowInstance, setLocalFlowInstance] = useState<GraphFlow | null>(null);
  const ownedInstance = useRef<GraphFlow | null>(null);
  const mounted = useRef(false);
  const fittedGraphScopeId = useRef<string | null>(null);
  const hasGraph = graphScopeId !== null;

  useLayoutEffect(() => {
    mounted.current = hasGraph;
    setLocalFlowInstance(null);
    if (!hasGraph) fittedGraphScopeId.current = null;
    return () => {
      mounted.current = false;
      const instance = ownedInstance.current;
      ownedInstance.current = null;
      setFlowInstance((current) => (current === instance ? null : current));
    };
  }, [hasGraph, setFlowInstance]);

  const handleFlowInit = useCallback(
    (instance: GraphFlow) => {
      if (!mounted.current) return;
      ownedInstance.current = instance;
      setLocalFlowInstance(instance);
      setFlowInstance(instance);
    },
    [setFlowInstance]
  );

  useEffect(() => {
    if (!graphScopeId || !localFlowInstance || visibleNodeCount === 0) return;
    if (fittedGraphScopeId.current === graphScopeId) return;
    fittedGraphScopeId.current = graphScopeId;
    if (preserveSourceViewport || selectedTaskPanelId) return;
    const frame = window.requestAnimationFrame(() => {
      void localFlowInstance.fitView({ maxZoom: 1 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    graphScopeId,
    localFlowInstance,
    preserveSourceViewport,
    selectedTaskPanelId,
    visibleNodeCount
  ]);

  return { handleFlowInit, localFlowInstance };
}

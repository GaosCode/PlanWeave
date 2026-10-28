import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import type { AppFlowNode } from "../types";

type GraphFlow = ReactFlowInstance<AppFlowNode, Edge>;

export function useGraphFlowOwner() {
  const currentInstance = useRef<GraphFlow | null>(null);
  const [flowInstance, publishFlowInstance] = useState<GraphFlow | null>(null);
  const getFlowInstance = useCallback(() => currentInstance.current, []);
  const setFlowInstance: Dispatch<SetStateAction<GraphFlow | null>> = useCallback((update) => {
    const next = typeof update === "function" ? update(currentInstance.current) : update;
    currentInstance.current = next;
    publishFlowInstance(next);
  }, []);
  return { flowInstance, getFlowInstance, setFlowInstance };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import type { AppFlowNode, AppView } from "../types";

const fallbackTaskNodeSize = {
  width: 320,
  height: 220
};

type TaskFocusFlow = Pick<ReactFlowInstance<AppFlowNode, Edge>, "getNode" | "setCenter">;
type TaskFocusNode = Pick<AppFlowNode, "id" | "type" | "position" | "width" | "height" | "measured">;

export function focusTaskNode(flowInstance: TaskFocusFlow | null, nodes: TaskFocusNode[], taskId: string | null): boolean {
  if (!flowInstance || !taskId) {
    return false;
  }
  const node = flowInstance.getNode(taskId) ?? nodes.find((candidate) => candidate.id === taskId);
  if (!node || node.type !== "task") {
    return false;
  }
  const width = node.measured?.width ?? node.width ?? fallbackTaskNodeSize.width;
  const height = node.measured?.height ?? node.height ?? fallbackTaskNodeSize.height;
  void flowInstance.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
    duration: 260,
    zoom: 1
  });
  return true;
}

export function useTaskNodeFocus({
  activeView,
  flowInstance,
  nodes,
  selectedTaskPanelId
}: {
  activeView: AppView;
  flowInstance: ReactFlowInstance<AppFlowNode, Edge> | null;
  nodes: AppFlowNode[];
  selectedTaskPanelId: string | null;
}) {
  const lastFocusedTaskId = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ taskId: string; version: number } | null>(null);

  const requestTaskFocus = useCallback((taskId: string | null) => {
    if (!taskId) {
      setFocusRequest(null);
      lastFocusedTaskId.current = null;
      return;
    }
    setFocusRequest((current) => ({ taskId, version: (current?.version ?? 0) + 1 }));
  }, []);

  const runTaskFocus = useCallback(
    (taskId: string | null) => {
      if (focusTaskNode(flowInstance, nodes, taskId)) {
        lastFocusedTaskId.current = taskId;
        return true;
      }
      return false;
    },
    [flowInstance, nodes]
  );

  useEffect(() => {
    if (activeView !== "graph") {
      return;
    }
    const taskId = focusRequest?.taskId ?? selectedTaskPanelId;
    if (!taskId) {
      lastFocusedTaskId.current = null;
      return;
    }
    if (!focusRequest && lastFocusedTaskId.current === taskId) {
      return;
    }
    if (runTaskFocus(taskId) && focusRequest?.taskId === taskId) {
      setFocusRequest(null);
    }
  }, [activeView, focusRequest, runTaskFocus, selectedTaskPanelId]);

  return { requestTaskFocus };
}

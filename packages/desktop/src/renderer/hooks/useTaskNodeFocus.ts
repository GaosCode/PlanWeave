import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import type { AppFlowNode, AppView } from "../types";

const fallbackTaskNodeSize = {
  width: 320,
  height: 220
};

type TaskFocusFlow = Pick<ReactFlowInstance<AppFlowNode, Edge>, "getNode" | "setCenter">;
type TaskFocusNode = Pick<
  AppFlowNode,
  "id" | "type" | "position" | "width" | "height" | "measured"
>;
type TaskFocusRequest = { taskId: string; version: number };

export function focusTaskNode(
  flowInstance: TaskFocusFlow | null,
  nodes: TaskFocusNode[],
  taskId: string | null
): boolean {
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
  taskFocusRequest,
  selectedTaskPanelId
}: {
  activeView: AppView;
  flowInstance: ReactFlowInstance<AppFlowNode, Edge> | null;
  nodes: AppFlowNode[];
  taskFocusRequest?: TaskFocusRequest | null;
  selectedTaskPanelId: string | null;
}) {
  const lastFocusedTaskId = useRef<string | null>(null);
  const consumedTaskFocusRequest = useRef<TaskFocusRequest | null>(null);
  const [focusRequest, setFocusRequest] = useState<TaskFocusRequest | null>(null);

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
    if (!taskFocusRequest) {
      consumedTaskFocusRequest.current = null;
    }
    if (!selectedTaskPanelId) {
      lastFocusedTaskId.current = null;
    }
    if (activeView !== "graph") {
      return;
    }
    const externalFocusRequest =
      taskFocusRequest &&
      (consumedTaskFocusRequest.current?.taskId !== taskFocusRequest.taskId ||
        consumedTaskFocusRequest.current.version !== taskFocusRequest.version)
        ? taskFocusRequest
        : null;
    const activeFocusRequest = externalFocusRequest ?? focusRequest;
    const taskId = activeFocusRequest?.taskId ?? selectedTaskPanelId;
    if (!taskId) {
      lastFocusedTaskId.current = null;
      return;
    }
    if (!activeFocusRequest && lastFocusedTaskId.current === taskId) {
      return;
    }
    if (runTaskFocus(taskId)) {
      if (externalFocusRequest?.taskId === taskId) {
        consumedTaskFocusRequest.current = externalFocusRequest;
      }
      if (focusRequest?.taskId === taskId) {
        setFocusRequest(null);
      }
    }
  }, [activeView, focusRequest, runTaskFocus, selectedTaskPanelId, taskFocusRequest]);

  return { requestTaskFocus };
}

import { useCallback, useLayoutEffect, useRef } from "react";
import type * as React from "react";
import type { Node } from "@xyflow/react";
import type {
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { CanvasLocator } from "../../shared/canvasLocator";
import { bridge, desktopCanvasReference } from "../bridge";
import type { createTranslator } from "../i18n";
import { defaultTaskNodePositions } from "../graph/defaultTaskLayout";
import type { AppFlowNode } from "../types";
import type { DesktopSelectionReceipt } from "./useDesktopProjectSnapshot";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

type UseGraphLayoutActionsArgs = {
  captureProjectSelection: () => DesktopSelectionReceipt;
  canvasLocator: CanvasLocator | null;
  getLayoutNodes?: (dragStopNode?: Node) => AppFlowNode[];
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  nodes: AppFlowNode[];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  setLayout: (layout: DesktopLayout | null) => void;
  workspaceCanvas: WorkspaceCanvasCommandsResult | null;
  t: ReturnType<typeof createTranslator>;
};

export function useGraphLayoutActions({
  captureProjectSelection,
  canvasLocator,
  getLayoutNodes,
  graph,
  layout,
  nodes,
  selectedCanvasId,
  selectedProject,
  setError,
  setLayout,
  workspaceCanvas,
  t
}: UseGraphLayoutActionsArgs) {
  const scopeKey = JSON.stringify([
    selectedProject?.projectId,
    selectedProject?.rootPath,
    selectedProject?.workspaceRoot,
    selectedCanvasId,
    canvasLocator
  ]);
  const sessionAuthority = workspaceCanvas?.sessionAuthority;
  const owner = useRef({ generation: 0, operation: 0, scopeKey, sessionAuthority });
  const queues = useRef(new Map<string, Promise<void>>());
  useLayoutEffect(() => {
    owner.current = {
      ...owner.current,
      generation: owner.current.generation + 1,
      scopeKey,
      sessionAuthority
    };
    return () => {
      owner.current.generation += 1;
    };
  }, [scopeKey, sessionAuthority]);

  const persistLayout = useCallback(
    (
      write: (
        isSelectionCurrent: () => boolean,
        isCurrent: () => boolean
      ) => Promise<DesktopLayout | null>
    ) => {
      const generation = owner.current.generation;
      const operation = ++owner.current.operation;
      const selection = captureProjectSelection();
      const isSelectionCurrent = () =>
        owner.current.generation === generation &&
        owner.current.scopeKey === scopeKey &&
        owner.current.sessionAuthority === sessionAuthority &&
        selection.isCurrent();
      const isCurrent = () => isSelectionCurrent() && owner.current.operation === operation;
      const execute = async () => {
        if (!isSelectionCurrent()) return;
        try {
          const saved = await write(isSelectionCurrent, isCurrent);
          if (saved && isCurrent()) {
            setLayout(saved);
            setError(null);
          }
        } catch (caught) {
          if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
        }
      };
      const previous = queues.current.get(scopeKey);
      const pending = previous ? previous.then(execute) : execute();
      queues.current.set(scopeKey, pending);
      void pending.then(() => {
        if (queues.current.get(scopeKey) === pending) queues.current.delete(scopeKey);
      });
      return pending;
    },
    [captureProjectSelection, scopeKey, sessionAuthority, setError, setLayout]
  );

  const handleNodeDragStop = useCallback(
    async (_event: React.MouseEvent, node: Node) => {
      const layoutNodes = (getLayoutNodes?.(node) ?? nodes).map((item) => ({
        nodeId: item.id,
        x: item.id === node.id && !getLayoutNodes ? node.position.x : item.position.x,
        y: item.id === node.id && !getLayoutNodes ? node.position.y : item.position.y
      }));
      if (workspaceCanvas?.enabled) {
        const updatedAt = new Date().toISOString();
        return persistLayout(async (_isSelectionCurrent, isCurrent) => {
          const result = await workspaceCanvas.submit({
            intent: { kind: "update_layout", nodes: layoutNodes, updatedAt },
            isOwnerCurrent: isCurrent
          });
          if (result.status === "retired") return null;
          if (!result.ok) throw new Error(result.error ?? t("canvasCommandNotConnected"));
          return graph
            ? {
                version: "desktop-layout/v1",
                projectId: graph.projectId,
                nodes: layoutNodes,
                updatedAt
              }
            : null;
        });
      }
      if (!bridge || !selectedProject) return;
      const api = bridge;
      const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
      return persistLayout(async (isSelectionCurrent) => {
        const baseLayout = layout ?? (await api.getDesktopLayout(canvas));
        if (!isSelectionCurrent()) return null;
        return api.saveDesktopLayout(canvas, { ...baseLayout, nodes: layoutNodes });
      });
    },
    [
      getLayoutNodes,
      graph,
      layout,
      nodes,
      persistLayout,
      selectedCanvasId,
      selectedProject,
      workspaceCanvas,
      t
    ]
  );

  const resetLayout = useCallback(async () => {
    if (workspaceCanvas?.enabled) {
      if (!graph || graph.tasks.length === 0) return;
      const positions = defaultTaskNodePositions(graph, getLayoutNodes?.() ?? nodes);
      const layoutNodes = graph.tasks.map((task) => ({
        nodeId: task.taskId,
        ...positions.get(task.taskId)!
      }));
      const updatedAt = new Date().toISOString();
      return persistLayout(async (_isSelectionCurrent, isCurrent) => {
        const result = await workspaceCanvas.submit({
          intent: { kind: "update_layout", nodes: layoutNodes, updatedAt },
          isOwnerCurrent: isCurrent
        });
        if (result.status === "retired") return null;
        if (!result.ok) throw new Error(result.error ?? t("canvasCommandNotConnected"));
        return {
          version: "desktop-layout/v1",
          projectId: graph.projectId,
          nodes: layoutNodes,
          updatedAt
        };
      });
    }
    if (!bridge || !selectedProject) return;
    const api = bridge;
    const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
    return persistLayout(() => api.resetDesktopLayout(canvas));
  }, [
    graph,
    getLayoutNodes,
    nodes,
    persistLayout,
    selectedCanvasId,
    selectedProject,
    workspaceCanvas,
    t
  ]);

  return { handleNodeDragStop, resetLayout };
}

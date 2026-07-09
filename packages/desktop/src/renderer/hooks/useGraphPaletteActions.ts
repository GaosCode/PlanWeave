import { useCallback } from "react";
import type * as React from "react";
import type { Connection, Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import {
  dependencyConnectionToManifestEndpoints,
  dependencyDisplayEdgeToManifestEndpoints
} from "../graph/dependencyEdges";
import type { createTranslator } from "../i18n";
import { visibleBlockSet } from "../settings";
import type {
  AppFlowNode,
  DesktopUiSettings,
  PaletteDropComponent,
  PaletteDropPosition
} from "../types";
import { defaultBlockTitleForUi } from "../viewHelpers";

type UseGraphPaletteActionsArgs = {
  flowInstance: ReactFlowInstance<AppFlowNode, Edge> | null;
  getLayoutNodes?: (dragStopNode?: Node) => AppFlowNode[];
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  nodes: AppFlowNode[];
  refreshProjectDerivedState: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedBlock: DesktopBlockDetail | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setError: (message: string | null) => void;
  setLayout: (layout: DesktopLayout | null) => void;
  setNewTaskTargetId: (taskId: string | null) => void;
  selectTaskPanel: (taskId: string | null) => void;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
};

function currentLayoutSnapshot(
  graph: DesktopGraphViewModel | null,
  layout: DesktopLayout | null,
  nodes: AppFlowNode[]
): DesktopLayout | undefined {
  if (!graph || nodes.length === 0) {
    return undefined;
  }
  return {
    version: "desktop-layout/v1",
    projectId: layout?.projectId ?? graph.projectId,
    nodes: nodes.map((node) => ({
      nodeId: node.id,
      x: node.position.x,
      y: node.position.y
    })),
    updatedAt: layout?.updatedAt ?? new Date(0).toISOString()
  };
}

export function useGraphPaletteActions({
  flowInstance,
  getLayoutNodes,
  graph,
  layout,
  loadProject,
  nodes,
  refreshProjectDerivedState,
  selectedCanvasId,
  selectedBlock,
  selectedProject,
  selectedTaskPanelId,
  setError,
  setLayout,
  setNewTaskTargetId,
  selectTaskPanel,
  settings,
  t
}: UseGraphPaletteActionsArgs) {
  const getPersistableLayoutNodes = useCallback(
    (dragStopNode?: Node) => getLayoutNodes?.(dragStopNode) ?? nodes,
    [getLayoutNodes, nodes]
  );

  const handleNodeDragStop = useCallback(
    async (_event: React.MouseEvent, node: Node) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
      const baseLayout = layout ?? (await bridge.getDesktopLayout(canvas));
      const layoutNodes = getPersistableLayoutNodes(node);
      const nextLayout: DesktopLayout = {
        ...baseLayout,
        nodes: layoutNodes.map((item) => ({
          nodeId: item.id,
          x: item.id === node.id && !getLayoutNodes ? node.position.x : item.position.x,
          y: item.id === node.id && !getLayoutNodes ? node.position.y : item.position.y
        }))
      };
      const saved = await bridge.saveDesktopLayout(canvas, nextLayout);
      setLayout(saved);
    },
    [
      getLayoutNodes,
      getPersistableLayoutNodes,
      layout,
      selectedCanvasId,
      selectedProject,
      setLayout
    ]
  );

  const resetLayout = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    setLayout(
      await bridge.resetDesktopLayout(desktopCanvasReference(selectedProject, selectedCanvasId))
    );
  }, [selectedCanvasId, selectedProject, setLayout]);

  const handleConnect = useCallback(
    async (connection: Connection) => {
      const manifestEdge = dependencyConnectionToManifestEndpoints(connection);
      if (!bridge || !selectedProject || !manifestEdge) {
        return;
      }
      try {
        const result = await bridge.addDependencyEdge(
          desktopCanvasReference(selectedProject, selectedCanvasId),
          manifestEdge.from,
          manifestEdge.to,
          graph?.graphVersion,
          currentLayoutSnapshot(graph, layout, getPersistableLayoutNodes())
        );
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshProjectDerivedState();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      getPersistableLayoutNodes,
      graph,
      layout,
      refreshProjectDerivedState,
      selectedCanvasId,
      selectedProject,
      setError
    ]
  );

  const handleEdgesDelete = useCallback(
    async (deletedEdges: Edge[]) => {
      if (!bridge || !selectedProject) {
        return;
      }
      for (const edge of deletedEdges) {
        const manifestEdge = dependencyDisplayEdgeToManifestEndpoints(edge);
        if (manifestEdge) {
          const result = await bridge.removeDependencyEdge(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            manifestEdge.from,
            manifestEdge.to,
            graph?.graphVersion,
            currentLayoutSnapshot(graph, layout, getPersistableLayoutNodes())
          );
          if (!result.ok) {
            setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            return;
          }
        }
      }
      await refreshProjectDerivedState();
    },
    [
      getPersistableLayoutNodes,
      graph,
      layout,
      refreshProjectDerivedState,
      selectedCanvasId,
      selectedProject,
      setError
    ]
  );

  const handleReconnectEdge = useCallback(
    async (oldEdge: Edge, connection: Connection) => {
      const oldManifestEdge = dependencyDisplayEdgeToManifestEndpoints(oldEdge);
      const newManifestEdge = dependencyConnectionToManifestEndpoints(connection);
      if (!bridge || !selectedProject || !oldManifestEdge || !newManifestEdge) {
        return;
      }
      try {
        const result = await bridge.reconnectDependencyEdge(
          desktopCanvasReference(selectedProject, selectedCanvasId),
          oldManifestEdge.from,
          oldManifestEdge.to,
          newManifestEdge.from,
          newManifestEdge.to,
          graph?.graphVersion,
          currentLayoutSnapshot(graph, layout, getPersistableLayoutNodes())
        );
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshProjectDerivedState();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      getPersistableLayoutNodes,
      graph,
      layout,
      refreshProjectDerivedState,
      selectedCanvasId,
      selectedProject,
      setError
    ]
  );

  const addPaletteComponent = useCallback(
    async (type: PaletteDropComponent, dropPosition?: PaletteDropPosition) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
        if (type === "task") {
          const result = await bridge.addTaskNode(canvas, {
            title: t("defaultTaskTitle"),
            promptMarkdown: t("defaultTaskPrompt"),
            acceptance: [t("defaultTaskAcceptance")],
            blockTypes: visibleBlockSet(settings),
            executor: settings.defaultExecutor.trim() || null,
            layoutPosition: dropPosition ? { x: dropPosition.x, y: dropPosition.y } : undefined
          });
          if (!result.ok) {
            setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            return;
          }
          const createdTaskId =
            result.affectedTasks.find(
              (taskId) => !graph?.tasks.some((task) => task.taskId === taskId)
            ) ??
            result.affectedTasks[0] ??
            null;
          if (createdTaskId) {
            selectTaskPanel(createdTaskId);
            setNewTaskTargetId(createdTaskId);
          }
          await loadProject(selectedProject, selectedCanvasId);
          return;
        }
        const targetTaskId =
          selectedBlock?.taskId ?? selectedTaskPanelId ?? graph?.tasks[0]?.taskId;
        if (!targetTaskId) {
          setError(t("selectTaskBeforeBlock"));
          return;
        }
        const result = await bridge.addBlock(canvas, {
          taskId: targetTaskId,
          type,
          title: defaultBlockTitleForUi(type, t),
          promptMarkdown: `# ${defaultBlockTitleForUi(type, t)}\n`,
          executor: settings.defaultExecutor.trim() || null
        });
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await loadProject(selectedProject, selectedCanvasId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      graph,
      loadProject,
      selectedBlock,
      selectedCanvasId,
      selectedProject,
      selectedTaskPanelId,
      setError,
      setNewTaskTargetId,
      selectTaskPanel,
      settings,
      t
    ]
  );

  const handlePaletteDragStart = useCallback(
    (event: React.DragEvent, type: PaletteDropComponent) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-planweave-palette", type);
    },
    []
  );

  const handleGraphDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("application/x-planweave-palette")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleGraphDrop = useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData(
        "application/x-planweave-palette"
      ) as PaletteDropComponent;
      if (!type) {
        return;
      }
      event.preventDefault();
      const dropPosition = flowInstance?.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      });
      void addPaletteComponent(type, type === "task" ? dropPosition : undefined);
    },
    [addPaletteComponent, flowInstance]
  );

  return {
    addPaletteComponent,
    handleConnect,
    handleEdgesDelete,
    handleReconnectEdge,
    handleGraphDragOver,
    handleGraphDrop,
    handleNodeDragStop,
    handlePaletteDragStart,
    resetLayout
  };
}

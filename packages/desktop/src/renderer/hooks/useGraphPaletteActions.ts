import { useCallback } from "react";
import type * as React from "react";
import type { Connection, Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type { DesktopBlockDetail, DesktopGraphViewModel, DesktopLayout, DesktopProjectSummary } from "@planweave/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { dependencyConnectionToManifestEndpoints, dependencyDisplayEdgeToManifestEndpoints } from "../graph/dependencyEdges";
import type { createTranslator } from "../i18n";
import { visibleBlockSet } from "../settings";
import type { AppFlowNode, DesktopUiSettings, PaletteDropComponent, PaletteDropPosition } from "../types";
import { defaultBlockTitleForUi } from "../viewHelpers";

type UseGraphPaletteActionsArgs = {
  flowInstance: ReactFlowInstance<AppFlowNode, Edge> | null;
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  nodes: AppFlowNode[];
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedBlock: DesktopBlockDetail | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setError: (message: string | null) => void;
  setLayout: (layout: DesktopLayout | null) => void;
  setNewTaskTargetId: (taskId: string | null) => void;
  setSelectedTaskPanelId: (taskId: string | null) => void;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
};

export function useGraphPaletteActions({
  flowInstance,
  graph,
  layout,
  loadProject,
  nodes,
  refreshGraph,
  selectedCanvasId,
  selectedBlock,
  selectedProject,
  selectedTaskPanelId,
  setError,
  setLayout,
  setNewTaskTargetId,
  setSelectedTaskPanelId,
  settings,
  t
}: UseGraphPaletteActionsArgs) {
  const handleNodeDragStop = useCallback(
    async (_event: React.MouseEvent, node: Node) => {
      if (!bridge || !selectedProject) {
        return;
      }
      const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
      const baseLayout = layout ?? (await bridge.getDesktopLayout(canvas));
      const nextLayout: DesktopLayout = {
        ...baseLayout,
        nodes: nodes.map((item) => ({
          nodeId: item.id,
          x: item.id === node.id ? node.position.x : item.position.x,
          y: item.id === node.id ? node.position.y : item.position.y
        }))
      };
      const saved = await bridge.saveDesktopLayout(canvas, nextLayout);
      setLayout(saved);
    },
    [layout, nodes, selectedCanvasId, selectedProject, setLayout]
  );

  const resetLayout = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    setLayout(await bridge.resetDesktopLayout(desktopCanvasReference(selectedProject, selectedCanvasId)));
  }, [selectedCanvasId, selectedProject, setLayout]);

  const handleConnect = useCallback(
    async (connection: Connection) => {
      const manifestEdge = dependencyConnectionToManifestEndpoints(connection);
      if (!bridge || !selectedProject || !manifestEdge) {
        return;
      }
      try {
        const result = await bridge.addDependencyEdge(desktopCanvasReference(selectedProject, selectedCanvasId), manifestEdge.from, manifestEdge.to);
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedCanvasId, selectedProject, setError]
  );

  const handleEdgesDelete = useCallback(
    async (deletedEdges: Edge[]) => {
      if (!bridge || !selectedProject) {
        return;
      }
      for (const edge of deletedEdges) {
        const manifestEdge = dependencyDisplayEdgeToManifestEndpoints(edge);
        if (manifestEdge) {
          await bridge.removeDependencyEdge(desktopCanvasReference(selectedProject, selectedCanvasId), manifestEdge.from, manifestEdge.to);
        }
      }
      await refreshGraph();
    },
    [refreshGraph, selectedCanvasId, selectedProject]
  );

  const addPaletteComponent = useCallback(
    async (type: PaletteDropComponent, dropPosition?: PaletteDropPosition) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
        if (type === "task") {
          const previousTaskIds = new Set(graph?.tasks.map((task) => task.taskId) ?? []);
          const result = await bridge.addTaskNode(canvas, {
            title: t("defaultTaskTitle"),
            promptMarkdown: t("defaultTaskPrompt"),
            acceptance: [t("defaultTaskAcceptance")],
            blockTypes: visibleBlockSet(settings),
            executor: settings.defaultExecutor.trim() || null
          });
          if (!result.ok) {
            setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            return;
          }
          if (dropPosition) {
            const nextGraph = await bridge.getGraphViewModel(canvas);
            const createdTask = nextGraph.tasks.find((task) => !previousTaskIds.has(task.taskId));
            if (createdTask) {
              const baseLayout = await bridge.getDesktopLayout(canvas);
              const nextLayout: DesktopLayout = {
                ...baseLayout,
                nodes: [...baseLayout.nodes.filter((node) => node.nodeId !== createdTask.taskId), { nodeId: createdTask.taskId, x: dropPosition.x, y: dropPosition.y }]
              };
              const savedLayout = await bridge.saveDesktopLayout(canvas, nextLayout);
              await loadProject(selectedProject, selectedCanvasId);
              setLayout(savedLayout);
              setSelectedTaskPanelId(createdTask.taskId);
              setNewTaskTargetId(createdTask.taskId);
              return;
            }
          }
          await loadProject(selectedProject, selectedCanvasId);
          return;
        }
        if (type === "context") {
          const previousContextIds = new Set(graph?.contextNodes.map((node) => node.nodeId) ?? []);
          const result = await bridge.addContextNode(canvas, {
            type: "component",
            title: t("defaultContextTitle"),
            summary: t("defaultContextSummary")
          });
          if (!result.ok) {
            setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            return;
          }
          if (dropPosition) {
            const nextGraph = await bridge.getGraphViewModel(canvas);
            const createdContext = nextGraph.contextNodes.find((node) => !previousContextIds.has(node.nodeId));
            if (createdContext) {
              const baseLayout = await bridge.getDesktopLayout(canvas);
              const nextLayout: DesktopLayout = {
                ...baseLayout,
                nodes: [...baseLayout.nodes.filter((node) => node.nodeId !== createdContext.nodeId), { nodeId: createdContext.nodeId, x: dropPosition.x, y: dropPosition.y }]
              };
              const savedLayout = await bridge.saveDesktopLayout(canvas, nextLayout);
              await loadProject(selectedProject, selectedCanvasId);
              setLayout(savedLayout);
              return;
            }
          }
          await loadProject(selectedProject, selectedCanvasId);
          return;
        }
        const targetTaskId = selectedBlock?.taskId ?? selectedTaskPanelId ?? graph?.tasks[0]?.taskId;
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
    [graph, loadProject, selectedBlock, selectedCanvasId, selectedProject, selectedTaskPanelId, setError, setLayout, setNewTaskTargetId, setSelectedTaskPanelId, settings, t]
  );

  const handlePaletteDragStart = useCallback((event: React.DragEvent, type: PaletteDropComponent) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-planweave-palette", type);
  }, []);

  const handleGraphDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("application/x-planweave-palette")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleGraphDrop = useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData("application/x-planweave-palette") as PaletteDropComponent;
      if (!type) {
        return;
      }
      event.preventDefault();
      const dropPosition = flowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void addPaletteComponent(type, type === "task" || type === "context" ? dropPosition : undefined);
    },
    [addPaletteComponent, flowInstance]
  );

  return {
    addPaletteComponent,
    handleConnect,
    handleEdgesDelete,
    handleGraphDragOver,
    handleGraphDrop,
    handleNodeDragStop,
    handlePaletteDragStart,
    resetLayout
  };
}

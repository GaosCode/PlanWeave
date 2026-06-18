import { useCallback, useEffect, useState, type MouseEvent } from "react";
import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { FolderOpenIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { createTranslator } from "../i18n";
import { canvasMapEdges, canvasMapNodes, canvasNodeTypes, type DisplayCanvasEdgeData } from "../graph/canvasFlowModel";
import { useCanvasMap } from "../hooks/useCanvasMap";
import type { AppView, CanvasFlowNode } from "../types";
import { CanvasMapInspector } from "./CanvasMapInspector";

type CanvasMapViewProps = {
  handleOpenProject: () => Promise<void>;
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  onTaskPanelSelect: (taskId: string | null) => void;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

function canvasEdgeData(edge: Edge | null): DisplayCanvasEdgeData | null {
  const data = edge?.data as Partial<DisplayCanvasEdgeData> | undefined;
  if (!data?.manifestEdgeType || !data.manifestFrom || !data.manifestTo) {
    return null;
  }
  return {
    health: data.health ?? null,
    manifestEdgeType: data.manifestEdgeType,
    manifestFrom: data.manifestFrom,
    manifestTo: data.manifestTo
  };
}

export function CanvasMapView({
  handleOpenProject,
  handleOpenBlockInspector,
  loadProject,
  onTaskPanelSelect,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError,
  t
}: CanvasMapViewProps) {
  const {
    canvasGraph,
    canvasMapLayout,
    resetCanvasMapLayout,
    saveCanvasMapLayoutFromNodes,
    selectedCanvas,
    selectedMapCanvasId,
    setSelectedMapCanvasId
  } = useCanvasMap({ activeCanvasId: selectedCanvasId, selectedProject, setError });
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const openCanvas = useCallback(
    (canvasId: string) => {
      if (!selectedProject) {
        return;
      }
      void loadProject(selectedProject, canvasId)
        .then(() => setActiveView("graph"))
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    },
    [loadProject, selectedProject, setActiveView, setError]
  );
  const openTask = useCallback(
    (canvasId: string, taskId: string) => {
      if (!selectedProject) {
        return;
      }
      void loadProject(selectedProject, canvasId)
        .then(() => onTaskPanelSelect(taskId))
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    },
    [loadProject, onTaskPanelSelect, selectedProject, setError]
  );
  const openBlock = useCallback(
    (canvasId: string, blockRef: string) => {
      if (!selectedProject) {
        return;
      }
      void loadProject(selectedProject, canvasId)
        .then(() => handleOpenBlockInspector(blockRef, canvasId))
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    },
    [handleOpenBlockInspector, loadProject, selectedProject, setError]
  );

  useEffect(() => {
    if (!canvasGraph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(
      canvasMapNodes(
        canvasGraph,
        canvasMapLayout,
        {
          blocked: t("blocked"),
          error: t("error"),
          open: t("enterCanvas"),
          warning: t("warning")
        },
        selectedMapCanvasId,
        openCanvas,
        setSelectedMapCanvasId
      )
    );
    setEdges(canvasMapEdges(canvasGraph));
  }, [canvasGraph, canvasMapLayout, openCanvas, selectedMapCanvasId, setEdges, setNodes, setSelectedMapCanvasId, t]);

  const selectedEdgeData = canvasEdgeData(edges.find((edge) => edge.id === selectedEdgeId) ?? null);
  const selectedManifestEdge = selectedEdgeData
    ? canvasGraph?.edges.find(
      (edge) => edge.from === selectedEdgeData.manifestFrom && edge.to === selectedEdgeData.manifestTo && edge.type === selectedEdgeData.manifestEdgeType
    ) ?? null
    : null;

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, node: Node) => {
      const nextNodes = nodes.map((current) => (current.id === node.id ? { ...current, position: node.position } : current));
      void saveCanvasMapLayoutFromNodes(nextNodes);
    },
    [nodes, saveCanvasMapLayoutFromNodes]
  );
  const closeInspector = useCallback(() => {
    setSelectedMapCanvasId(null);
    setSelectedEdgeId(null);
  }, [setSelectedMapCanvasId]);

  if (!selectedProject || !canvasGraph) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-md border border-border/80 bg-surface-raised p-5 text-center text-text shadow-sm">
          <div className="flex items-center justify-center gap-2 text-sm font-semibold text-text-strong">
            <FolderOpenIcon data-icon="inline-start" />
            {t("noProject")}
          </div>
          <div className="text-sm text-text-muted">{t("openProjectHint")}</div>
          <Button className="w-fit" variant="outline" onClick={handleOpenProject}>
            <FolderOpenIcon data-icon="inline-start" />
            {t("openProject")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_320px]">
      <div className="relative min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={canvasNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => {
            setSelectedMapCanvasId(node.id);
            setSelectedEdgeId(null);
          }}
          onNodeDoubleClick={(_event, node) => openCanvas(node.id)}
          onNodeDragStop={handleNodeDragStop}
          onEdgeClick={(_event, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedMapCanvasId(null);
          }}
          onPaneClick={closeInspector}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <aside className="flex min-h-0 flex-col border-l border-border/80 bg-app-panel text-text">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-app-topbar px-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <GitBranchIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("canvasMap")}</span>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={t("resetCanvasMapLayout")} onClick={() => void resetCanvasMapLayout()}>
            <RotateCcwIcon data-icon="inline-start" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            <CanvasMapInspector
              graph={canvasGraph}
              onClose={closeInspector}
              onBlockOpen={openBlock}
              onCanvasOpen={openCanvas}
              onTaskOpen={openTask}
              selectedCanvas={selectedCanvas}
              selectedCanvasId={selectedMapCanvasId}
              selectedEdge={selectedManifestEdge}
              t={t}
            />
          </div>
        </ScrollArea>
      </aside>
    </div>
  );
}

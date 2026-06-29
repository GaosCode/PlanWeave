import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type DragEvent, type MouseEvent, type PointerEvent, type Ref, type SetStateAction } from "react";
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  type ReactFlowInstance,
  type OnEdgesChange,
  type OnNodesChange
} from "@xyflow/react";
import type {
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopPackageFileSyncResult,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { ChevronRightIcon, NetworkIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { styleGraphEdgesForInteraction, type AppEdgeTypes, type AppNodeTypes } from "../graph/flowModel";
import { useEdgeReconnect } from "../hooks/useEdgeReconnect";
import type { AppView } from "../types";
import type { createTranslator } from "../i18n";
import { GraphEmptyState } from "./GraphEmptyState";
import { FloatingAutoRunControl } from "../run/FloatingAutoRunControl";
import type { AutoRunNextActionDescriptor } from "../run/autoRunNextActions";
import type { AppFlowNode, AutoRunScopeMode } from "../types";

type GraphViewProps = {
  autoRunControlStyle: CSSProperties;
  autoRunControlRef: Ref<HTMLDivElement>;
  autoRunNextAction: AutoRunNextActionDescriptor | null;
  autoRunRetrospective: DesktopAutoRunRetrospectiveSummary | null;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  edges: Edge[];
  fileSyncResult: DesktopPackageFileSyncResult | null;
  graph: DesktopGraphViewModel | null;
  handleAutoRunClick: () => Promise<void>;
  handleAutoRunNextAction: (action: AutoRunNextActionDescriptor) => Promise<void>;
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  handleConnect: (connection: Connection) => Promise<void>;
  handleEdgesDelete: (deletedEdges: Edge[]) => Promise<void>;
  handleReconnectEdge: (oldEdge: Edge, connection: Connection) => Promise<void>;
  handleGraphDragOver: (event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleOpenProject: () => Promise<void>;
  handleRedoGraph: () => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  resetRuntimeStateClick: () => Promise<void>;
  handleUndoGraph: () => Promise<void>;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  edgeTypes: AppEdgeTypes;
  nodeTypes: AppNodeTypes;
  nodes: AppFlowNode[];
  projectLoading: boolean;
  onEdgesChange: OnEdgesChange<Edge>;
  onNodesChange: OnNodesChange<AppFlowNode>;
  onTaskPanelSelect: (taskId: string | null) => void;
  refreshPackageFiles: () => Promise<void>;
  selectedBlockPresent: boolean;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setAutoRunScopeMode: Dispatch<SetStateAction<AutoRunScopeMode>>;
  setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<AppFlowNode, Edge> | null>>;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  startAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  stopAutoRunClick: () => Promise<void>;
  stopAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  t: ReturnType<typeof createTranslator>;
  visibleTaskIds: Set<string>;
  visibleTasks: DesktopGraphViewModel["tasks"] | undefined;
  onNodeDragStop: (event: MouseEvent, node: Node) => Promise<void>;
};

export function GraphView({
  autoRunControlStyle,
  autoRunControlRef,
  autoRunNextAction,
  autoRunRetrospective,
  autoRunScopeMode,
  autoRunState,
  edges,
  fileSyncResult,
  graph,
  handleAutoRunClick,
  handleAutoRunNextAction,
  handleOpenBlockInspector,
  handleConnect,
  handleEdgesDelete,
  handleReconnectEdge,
  handleGraphDragOver,
  handleGraphDrop,
  handleOpenProject,
  handleRedoGraph,
  handleRevealPathInFinder,
  resetRuntimeStateClick,
  handleUndoGraph,
  miniRunPanelOpen,
  moveAutoRunControl,
  edgeTypes,
  nodeTypes,
  nodes,
  projectLoading,
  onEdgesChange,
  onNodeDragStop,
  onNodesChange,
  onTaskPanelSelect,
  refreshPackageFiles,
  selectedBlockPresent,
  selectedCanvasId,
  selectedProject,
  selectedTaskPanelId,
  setActiveView,
  setAutoRunScopeMode,
  setFlowInstance,
  setMiniRunPanelOpen,
  startAutoRunControlDrag,
  stopAutoRunClick,
  stopAutoRunControlDrag,
  t,
  visibleTaskIds,
  visibleTasks
}: GraphViewProps) {
  const fittedGraphScopeId = useRef<string | null>(null);
  const [localFlowInstance, setLocalFlowInstance] = useState<ReactFlowInstance<AppFlowNode, Edge> | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const dirtyPromptRefs = graph?.dirtyPromptRefs ?? [];
  const dirtyPromptCount = dirtyPromptRefs.length;
  const visibleNodes = visibleTasks ? nodes.filter((node) => node.type !== "task" || visibleTaskIds.has(node.id)) : nodes;
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = visibleTasks ? edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)) : edges;
  const styledVisibleEdges = useMemo(
    () => styleGraphEdgesForInteraction(visibleEdges, { hoveredEdgeId, hoveredNodeId }),
    [hoveredEdgeId, hoveredNodeId, visibleEdges]
  );
  const currentCanvasName = selectedProject?.taskCanvases.find((canvas) => canvas.canvasId === selectedCanvasId)?.name ?? t("taskCanvas");
  const graphScopeId = useMemo(() => {
    if (!graph || !selectedProject) {
      return null;
    }
    return `${selectedProject.projectId}:${selectedCanvasId ?? "default"}`;
  }, [graph, selectedCanvasId, selectedProject]);
  const handleFlowInit = useCallback(
    (instance: ReactFlowInstance<AppFlowNode, Edge>) => {
      setLocalFlowInstance(instance);
      setFlowInstance(instance);
    },
    [setFlowInstance]
  );
  const { handleReconnect, handleReconnectEnd, handleReconnectStart } = useEdgeReconnect({
    handleEdgesDelete,
    handleReconnectEdge
  });
  const handleOpenFileSyncRef = useCallback(
    (ref: string) => {
      setActiveView("graph");
      if (ref.includes("#")) {
        void handleOpenBlockInspector(ref, selectedCanvasId);
        return;
      }
      onTaskPanelSelect(ref);
    },
    [handleOpenBlockInspector, onTaskPanelSelect, selectedCanvasId, setActiveView]
  );

  useEffect(() => {
    if (!graph) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
      ) {
        return;
      }
      const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z";
      const isRedo =
        ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z") ||
        (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "y");
      if (!isUndo && !isRedo) {
        return;
      }
      event.preventDefault();
      void (isUndo ? handleUndoGraph() : handleRedoGraph());
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [graph, handleRedoGraph, handleUndoGraph]);

  useEffect(() => {
    if (!graphScopeId || !localFlowInstance || visibleNodes.length === 0) {
      return undefined;
    }
    if (fittedGraphScopeId.current === graphScopeId) {
      return undefined;
    }
    fittedGraphScopeId.current = graphScopeId;
    if (selectedTaskPanelId) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      void localFlowInstance.fitView({ maxZoom: 1 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [graphScopeId, localFlowInstance, selectedTaskPanelId, visibleNodes.length]);

  return (
    <div className="relative h-full min-h-0 bg-app-canvas text-text" data-graph-surface onDragOver={handleGraphDragOver} onDrop={handleGraphDrop}>
      {!graph ? (
        <div className="flex h-full items-center justify-center p-6">
          <GraphEmptyState handleOpenProject={handleOpenProject} projectLoading={projectLoading} t={t} />
        </div>
      ) : (
        <ReactFlow
          nodes={visibleNodes}
          edges={styledVisibleEdges}
          edgeTypes={edgeTypes}
          nodeTypes={nodeTypes}
          onConnect={(connection) => void handleConnect(connection)}
          onEdgesDelete={(deletedEdges) => void handleEdgesDelete(deletedEdges)}
          onReconnect={handleReconnect}
          onReconnectStart={handleReconnectStart}
          onReconnectEnd={handleReconnectEnd}
          edgesReconnectable
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => {
            if (node.type === "task") {
              onTaskPanelSelect(node.id);
            }
          }}
          onNodeMouseEnter={(_event, node) => setHoveredNodeId(node.id)}
          onNodeMouseLeave={(_event, node) => setHoveredNodeId((current) => (current === node.id ? null : current))}
          onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
          onEdgeMouseLeave={(_event, edge) => setHoveredEdgeId((current) => (current === edge.id ? null : current))}
          onPaneMouseEnter={() => {
            setHoveredEdgeId(null);
            setHoveredNodeId(null);
          }}
          onNodeDragStop={(event, node) => void onNodeDragStop(event, node)}
          onInit={handleFlowInit}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
        >
          <Background color="var(--border)" gap={24} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      )}
      {graph ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex h-9 items-center overflow-hidden rounded-md border border-border/80 bg-surface-overlay/95 text-sm text-text shadow-sm">
          <Button
            className="pointer-events-auto h-full rounded-none border-0 px-2.5 text-xs text-text-muted shadow-none hover:bg-surface-muted hover:text-text-strong"
            variant="ghost"
            onClick={() => setActiveView("canvas-map")}
          >
            <NetworkIcon data-icon="inline-start" />
            {t("canvasMap")}
          </Button>
          <ChevronRightIcon className="size-4 text-text-faint" aria-hidden="true" />
          <span className="max-w-[220px] truncate border-l border-border/70 px-2 text-xs font-medium text-text-strong">{currentCanvasName}</span>
          <div className="flex h-full border-l border-border/70">
            <Button
              aria-label={t("undoGraphCommand")}
              className="pointer-events-auto h-full rounded-none border-0 px-2 text-text-muted shadow-none hover:bg-surface-muted hover:text-text-strong"
              title={t("undoGraphCommand")}
              variant="ghost"
              onClick={() => void handleUndoGraph()}
            >
              <Undo2Icon />
            </Button>
            <Button
              aria-label={t("redoGraphCommand")}
              className="pointer-events-auto h-full rounded-none border-0 px-2 text-text-muted shadow-none hover:bg-surface-muted hover:text-text-strong"
              title={t("redoGraphCommand")}
              variant="ghost"
              onClick={() => void handleRedoGraph()}
            >
              <Redo2Icon />
            </Button>
          </div>
        </div>
      ) : null}
      <FloatingAutoRunControl
        autoRunScopeMode={autoRunScopeMode}
        autoRunNextAction={autoRunNextAction}
        autoRunRetrospective={autoRunRetrospective}
        autoRunState={autoRunState}
        controlRef={autoRunControlRef}
        affectedTasks={fileSyncResult?.affectedTasks ?? []}
        diagnostics={fileSyncResult?.diagnostics ?? []}
        dirtyPromptRefs={dirtyPromptRefs}
        dirtyPromptCount={dirtyPromptCount}
        autoRunPreflightExecutorHint={graph?.autoRunPreflightExecutorHint ?? null}
        handleAutoRunClick={handleAutoRunClick}
        handleAutoRunNextAction={handleAutoRunNextAction}
        handleRevealPathInFinder={handleRevealPathInFinder}
        miniRunPanelOpen={miniRunPanelOpen}
        moveAutoRunControl={moveAutoRunControl}
        onOpenFileSyncRef={handleOpenFileSyncRef}
        refreshPackageFiles={refreshPackageFiles}
        refreshedPromptCount={fileSyncResult?.refreshedPromptCount ?? 0}
        refreshConcurrency={fileSyncResult?.refreshConcurrency ?? null}
        resetRuntimeStateClick={resetRuntimeStateClick}
        selectedBlockPresent={selectedBlockPresent}
        selectedCanvasId={selectedCanvasId}
        selectedProject={selectedProject}
        selectedTaskPanelId={selectedTaskPanelId}
        setAutoRunScopeMode={setAutoRunScopeMode}
        setMiniRunPanelOpen={setMiniRunPanelOpen}
        startAutoRunControlDrag={startAutoRunControlDrag}
        stopAutoRunClick={stopAutoRunClick}
        stopAutoRunControlDrag={stopAutoRunControlDrag}
        style={autoRunControlStyle}
        t={t}
      />
    </div>
  );
}

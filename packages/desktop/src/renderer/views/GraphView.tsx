import type { CSSProperties, Dispatch, DragEvent, MouseEvent, PointerEvent, SetStateAction } from "react";
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
import type { DesktopAutoRunState, DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { ChevronRightIcon, FolderOpenIcon, NetworkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppNodeTypes } from "../graph/flowModel";
import type { AppView } from "../types";
import type { createTranslator } from "../i18n";
import { FloatingAutoRunControl } from "../run/FloatingAutoRunControl";
import type { AppFlowNode, AutoRunScopeMode } from "../types";

type GraphViewProps = {
  autoRunControlStyle: CSSProperties;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  dirtyPromptRefs: string[];
  edges: Edge[];
  graph: DesktopGraphViewModel | null;
  handleAutoRunClick: () => Promise<void>;
  handleConnect: (connection: Connection) => Promise<void>;
  handleEdgesDelete: (deletedEdges: Edge[]) => Promise<void>;
  handleGraphDragOver: (event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleOpenProject: () => Promise<void>;
  handleRevealPathInFinder: (path: string | null | undefined) => Promise<void>;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  nodeTypes: AppNodeTypes;
  nodes: AppFlowNode[];
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
  autoRunScopeMode,
  autoRunState,
  dirtyPromptRefs,
  edges,
  graph,
  handleAutoRunClick,
  handleConnect,
  handleEdgesDelete,
  handleGraphDragOver,
  handleGraphDrop,
  handleOpenProject,
  handleRevealPathInFinder,
  miniRunPanelOpen,
  moveAutoRunControl,
  nodeTypes,
  nodes,
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
  const dirtyPromptCount = Math.max(dirtyPromptRefs.length, graph?.dirtyPromptRefs.length ?? 0);
  const visibleNodes = visibleTasks ? nodes.filter((node) => node.type !== "task" || visibleTaskIds.has(node.id)) : nodes;
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = visibleTasks ? edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)) : edges;
  const currentCanvasName = selectedProject?.taskCanvases.find((canvas) => canvas.canvasId === selectedCanvasId)?.name ?? t("taskCanvas");

  return (
    <div className="relative h-full min-h-0" data-graph-surface onDragOver={handleGraphDragOver} onDrop={handleGraphDrop}>
      {!graph ? (
        <div className="flex h-full items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center gap-3 bg-background p-5 text-center">
            <div className="flex items-center justify-center gap-2 text-sm font-semibold">
              <FolderOpenIcon data-icon="inline-start" />
              {t("noProject")}
            </div>
            <div className="text-sm text-muted-foreground">{t("openProjectHint")}</div>
            <Button className="w-fit" variant="outline" onClick={handleOpenProject}>
              <FolderOpenIcon data-icon="inline-start" />
              {t("openProject")}
            </Button>
          </div>
        </div>
      ) : (
        <ReactFlow
          nodes={visibleNodes}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          onConnect={(connection) => void handleConnect(connection)}
          onEdgesDelete={(deletedEdges) => void handleEdgesDelete(deletedEdges)}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => {
            if (node.type === "task") {
              onTaskPanelSelect(node.id);
            }
          }}
          onNodeDragStop={(event, node) => void onNodeDragStop(event, node)}
          onInit={setFlowInstance}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      )}
      {graph ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1 rounded-md border bg-background/95 px-2 py-1 text-sm shadow-sm">
          <Button className="pointer-events-auto h-7 gap-1 px-2 text-xs" variant="ghost" onClick={() => setActiveView("canvas-map")}>
            <NetworkIcon data-icon="inline-start" />
            {t("canvasMap")}
          </Button>
          <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="max-w-[220px] truncate px-1 text-xs font-medium">{currentCanvasName}</span>
        </div>
      ) : null}
      <FloatingAutoRunControl
        autoRunScopeMode={autoRunScopeMode}
        autoRunState={autoRunState}
        dirtyPromptCount={dirtyPromptCount}
        handleAutoRunClick={handleAutoRunClick}
        handleRevealPathInFinder={handleRevealPathInFinder}
        miniRunPanelOpen={miniRunPanelOpen}
        moveAutoRunControl={moveAutoRunControl}
        refreshPackageFiles={refreshPackageFiles}
        selectedBlockPresent={selectedBlockPresent}
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

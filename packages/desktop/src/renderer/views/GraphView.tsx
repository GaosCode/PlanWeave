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
    <div className="relative h-full min-h-0 bg-app-canvas text-text" data-graph-surface onDragOver={handleGraphDragOver} onDrop={handleGraphDrop}>
      {!graph ? (
        <div className="flex h-full items-center justify-center p-6">
          <div className="flex max-w-[380px] flex-col gap-3 rounded-md border border-border/80 bg-surface-raised p-4 text-left shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface-muted text-text-muted">
                <FolderOpenIcon className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-text-strong">{t("noProject")}</div>
                <div className="text-xs text-text-muted">{t("openProjectSecondaryHint")}</div>
              </div>
            </div>
            <div className="text-sm leading-5 text-text-muted">{t("openProjectHint")}</div>
            <div className="rounded-md border border-border/70 bg-surface-muted/70 px-3 py-2 text-xs text-text-muted">{t("exampleProjectHint")}</div>
            <Button className="h-8 w-fit gap-2 border-border/80 bg-surface-base text-text hover:bg-surface-muted hover:text-text-strong" variant="outline" onClick={handleOpenProject}>
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

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
import type { DesktopAutoRunState, DesktopGraphViewModel, DesktopProjectSummary } from "@planweave/runtime";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppNodeTypes } from "../graph/flowModel";
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
  handleOpenRunRecord: (recordId: string | null | undefined) => Promise<void>;
  miniRunPanelOpen: boolean;
  moveAutoRunControl: (event: PointerEvent<HTMLButtonElement>) => void;
  nodeTypes: AppNodeTypes;
  nodes: AppFlowNode[];
  onEdgesChange: OnEdgesChange<Edge>;
  onNodesChange: OnNodesChange<AppFlowNode>;
  refreshPackageFiles: () => Promise<void>;
  selectedBlockPresent: boolean;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setAutoRunScopeMode: Dispatch<SetStateAction<AutoRunScopeMode>>;
  setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<AppFlowNode, Edge> | null>>;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
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
  handleOpenRunRecord,
  miniRunPanelOpen,
  moveAutoRunControl,
  nodeTypes,
  nodes,
  onEdgesChange,
  onNodeDragStop,
  onNodesChange,
  refreshPackageFiles,
  selectedBlockPresent,
  selectedProject,
  selectedTaskPanelId,
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
          nodes={visibleTasks ? nodes.filter((node) => node.type !== "task" || visibleTaskIds.has(node.id)) : nodes}
          edges={visibleTasks ? edges.filter((edge) => visibleTaskIds.has(edge.source) && visibleTaskIds.has(edge.target)) : edges}
          nodeTypes={nodeTypes}
          onConnect={(connection) => void handleConnect(connection)}
          onEdgesDelete={(deletedEdges) => void handleEdgesDelete(deletedEdges)}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={(event, node) => void onNodeDragStop(event, node)}
          onInit={setFlowInstance}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      )}
      <FloatingAutoRunControl
        autoRunScopeMode={autoRunScopeMode}
        autoRunState={autoRunState}
        dirtyPromptCount={dirtyPromptCount}
        handleAutoRunClick={handleAutoRunClick}
        handleOpenRunRecord={handleOpenRunRecord}
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

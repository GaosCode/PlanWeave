import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type SetStateAction
} from "react";
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
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopPackageFileSyncResult,
  DesktopProjectSummary,
  ValidationIssue
} from "@planweave-ai/runtime";
import { ChevronRightIcon, NetworkIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { styleDependencyEdgesForInteraction } from "../graph/dependencyEdgeVisual";
import { CanvasPresenceOverlay } from "../graph/CanvasPresenceOverlay";
import type { AppEdgeTypes, AppNodeTypes } from "../graph/flowModel";
import { sharedResourceColor } from "../graph/sharedResourceColors";
import { useEdgeReconnect } from "../hooks/useEdgeReconnect";
import { ResourceInspector } from "../inspector/ResourceInspector";
import type { AppView } from "../types";
import type { createTranslator } from "../i18n";
import { GraphEmptyState } from "./GraphEmptyState";
import { FloatingAutoRunControl } from "../run/FloatingAutoRunControl";
import type { AutoRunNextActionDescriptor } from "../run/autoRunNextActions";
import type { AppFlowNode, AutoRunScopeMode } from "../types";
import type { CollaborationCanvasPresenceResult } from "../hooks/useCollaborationCanvasPresence";
import type { CollaborationRuntimeAvailabilityView } from "../collaboration/runtimeAvailabilityView";

type GraphViewProps = {
  autoRunControlStyle: CSSProperties;
  autoRunControlRef: Ref<HTMLDivElement>;
  autoRunNextAction: AutoRunNextActionDescriptor | null;
  autoRunRetrospective: DesktopAutoRunRetrospectiveSummary | null;
  autoRunScopeMode: AutoRunScopeMode;
  autoRunState: DesktopAutoRunState | null;
  endpointScopeRunPhase: "running" | "completed" | "failed" | null;
  edges: Edge[];
  fileSyncResult: DesktopPackageFileSyncResult | null;
  graph: DesktopGraphViewModel | null;
  projectDiagnostics: ValidationIssue[];
  applyCanvasLaneLayout: (ref: DesktopCanvasReference) => Promise<void>;
  copyText: (text: string) => Promise<void>;
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
  runtimeOperationsAllowed: boolean;
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
  refreshProjectDerivedState: () => Promise<void>;
  selectedBlockPresent: boolean;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setAutoRunScopeMode: Dispatch<SetStateAction<AutoRunScopeMode>>;
  setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<AppFlowNode, Edge> | null>>;
  setError: (message: string | null) => void;
  setMiniRunPanelOpen: Dispatch<SetStateAction<boolean>>;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  startAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  stopAutoRunClick: () => Promise<void>;
  stopAutoRunControlDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  t: ReturnType<typeof createTranslator>;
  visibleTaskIds: Set<string>;
  visibleTasks: DesktopGraphViewModel["tasks"] | undefined;
  onNodeDragStop: (event: MouseEvent, node: Node) => Promise<void>;
  pinnedResource: string | null;
  onResourceHover: (name: string | null) => void;
  onResourcePin: (name: string | null) => void;
  clearPinnedResource: () => void;
  presence?: CollaborationCanvasPresenceResult;
  sharedCanvasOffline: boolean;
  sharedCanvasRevision: number | null;
  runtimeAvailability: CollaborationRuntimeAvailabilityView;
};

function runtimeAvailabilityBanner(
  availability: CollaborationRuntimeAvailabilityView,
  t: ReturnType<typeof createTranslator>
): string | null {
  switch (availability.kind) {
    case "not_applicable":
    case "available":
      return null;
    case "server_disconnected":
      return t("collaborationServerDisconnected");
    case "checking":
      return t("collaborationRuntimeChecking");
    case "error":
      return t("collaborationRuntimeError").replace("{message}", availability.message);
    case "unavailable":
      return t(
        availability.reason === "runtime_not_attached"
          ? "collaborationRuntimeNotAttached"
          : availability.reason === "host_offline"
            ? "collaborationRuntimeHostOffline"
            : "collaborationRuntimeContentOutOfSync"
      );
  }
}

export function GraphView({
  autoRunControlStyle,
  autoRunControlRef,
  autoRunNextAction,
  autoRunRetrospective,
  autoRunScopeMode,
  autoRunState,
  endpointScopeRunPhase,
  edges,
  fileSyncResult,
  graph,
  projectDiagnostics,
  applyCanvasLaneLayout,
  copyText,
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
  runtimeOperationsAllowed,
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
  refreshProjectDerivedState,
  selectedBlockPresent,
  selectedCanvasId,
  selectedProject,
  selectedTaskPanelId,
  setActiveView,
  setAutoRunScopeMode,
  setError,
  setFlowInstance,
  setMiniRunPanelOpen,
  startAutoRunControlDrag,
  stopAutoRunClick,
  stopAutoRunControlDrag,
  t,
  visibleTaskIds,
  visibleTasks,
  pinnedResource,
  onResourceHover,
  onResourcePin,
  clearPinnedResource,
  presence,
  sharedCanvasOffline,
  sharedCanvasRevision,
  runtimeAvailability
}: GraphViewProps) {
  const fittedGraphScopeId = useRef<string | null>(null);
  const [localFlowInstance, setLocalFlowInstance] = useState<ReactFlowInstance<
    AppFlowNode,
    Edge
  > | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const dirtyPromptRefs = graph?.dirtyPromptRefs ?? [];
  const dirtyPromptCount = dirtyPromptRefs.length;
  const runtimeBanner = runtimeAvailabilityBanner(runtimeAvailability, t);
  const visibleNodes = visibleTasks
    ? nodes.filter((node) => node.type !== "task" || visibleTaskIds.has(node.id))
    : nodes;
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = visibleTasks
    ? edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    : edges;
  const styledVisibleEdges = useMemo(
    () => styleDependencyEdgesForInteraction(visibleEdges, { hoveredEdgeId, hoveredNodeId }),
    [hoveredEdgeId, hoveredNodeId, visibleEdges]
  );
  const currentCanvasName =
    selectedProject?.taskCanvases.find((canvas) => canvas.canvasId === selectedCanvasId)?.name ??
    t("taskCanvas");
  const graphScopeId = useMemo(() => {
    if (!graph) {
      return null;
    }
    return `${graph.projectId}:${selectedCanvasId ?? "default"}`;
  }, [graph, selectedCanvasId]);
  const handleFlowInit = useCallback(
    (instance: ReactFlowInstance<AppFlowNode, Edge>) => {
      setLocalFlowInstance(instance);
      setFlowInstance(instance);
    },
    [setFlowInstance]
  );
  /**
   * Presence cursors must track the full graph surface, including task nodes and edges.
   * React Flow's onPaneMouseMove/Leave only cover empty pane background — moving onto a
   * node used to fire leave (null pointer) and stop updates, so peers saw cursors vanish.
   */
  const handleGraphPointerMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!presence || !localFlowInstance) return;
      presence.onPointerMove(
        localFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      );
    },
    [localFlowInstance, presence]
  );
  const handleGraphPointerLeave = useCallback(() => {
    presence?.onPointerLeave();
  }, [presence]);
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
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }
      const isUndo =
        (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z";
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
    // biome-ignore lint/a11y/noStaticElementInteractions: This div is a pointer drop target; keyboard graph interaction is owned by React Flow.
    <div
      className="relative h-full min-h-0 bg-app-canvas text-text"
      data-graph-surface
      data-project-loading={projectLoading ? "true" : "false"}
      onDragOver={handleGraphDragOver}
      onDrop={handleGraphDrop}
      onMouseMove={graph ? handleGraphPointerMove : undefined}
      onMouseLeave={graph ? handleGraphPointerLeave : undefined}
    >
      {runtimeBanner ? (
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-border bg-surface/95 px-3 py-1 text-xs text-text-muted shadow-sm"
          data-runtime-availability={runtimeAvailability.kind}
          data-testid="collaboration-runtime-availability"
        >
          {runtimeBanner}
        </div>
      ) : sharedCanvasOffline ? (
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-border bg-surface/95 px-3 py-1 text-xs text-text-muted shadow-sm"
          data-testid="shared-canvas-offline-replica"
        >
          {sharedCanvasRevision === null
            ? t("sharedCanvasOfflineReplica")
            : t("sharedCanvasOfflineRevision").replace("{revision}", String(sharedCanvasRevision))}
        </div>
      ) : null}
      {!graph ? (
        <div className="flex h-full items-center justify-center p-6">
          <GraphEmptyState
            handleOpenProject={handleOpenProject}
            projectLoading={projectLoading}
            t={t}
          />
        </div>
      ) : (
        <ReactFlow
          nodes={visibleNodes}
          edges={styledVisibleEdges}
          edgeTypes={edgeTypes}
          nodeTypes={nodeTypes}
          onlyRenderVisibleElements
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
          onNodeDoubleClick={(event, node) => {
            const target = event.target;
            const isInteractiveTarget =
              target instanceof HTMLElement &&
              target.closest(
                "button, input, textarea, select, a, [role='combobox'], [role='menuitem'], [data-graph-interaction]"
              );
            if (node.type === "task" && !isInteractiveTarget) {
              node.data.onTaskWorkspaceOpen(node.id);
            }
          }}
          onNodeMouseEnter={(_event, node) => setHoveredNodeId(node.id)}
          onNodeMouseLeave={(_event, node) =>
            setHoveredNodeId((current) => (current === node.id ? null : current))
          }
          onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
          onEdgeMouseLeave={(_event, edge) =>
            setHoveredEdgeId((current) => (current === edge.id ? null : current))
          }
          onPaneMouseEnter={() => {
            setHoveredEdgeId(null);
            setHoveredNodeId(null);
          }}
          onPaneClick={() => {
            clearPinnedResource();
          }}
          onSelectionChange={presence?.onSelectionChange}
          onNodeDragStop={(event, node) => void onNodeDragStop(event, node)}
          onInit={handleFlowInit}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
        >
          <Background color="var(--border)" gap={24} />
          <Controls />
          <MiniMap pannable zoomable />
          {presence && presence.remoteSessions.length > 0 ? (
            <CanvasPresenceOverlay
              edges={visibleEdges}
              nodes={visibleNodes}
              sessions={presence.remoteSessions}
              t={t}
            />
          ) : null}
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
          <span className="max-w-[220px] truncate border-l border-border/70 px-2 text-xs font-medium text-text-strong">
            {currentCanvasName}
          </span>
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
          {graph.sharedResourceGroups.length > 0 ? (
            <div className="flex h-full border-l border-border/70">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="pointer-events-auto h-full rounded-none border-0 px-2.5 text-xs text-text-muted shadow-none hover:bg-surface-muted hover:text-text-strong"
                    data-testid="graph-resources-legend"
                    variant="ghost"
                  >
                    {t("resources")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[220px]">
                  {graph.sharedResourceGroups.map((group) => {
                    const color = sharedResourceColor(group.name);
                    return (
                      <DropdownMenuItem
                        key={group.name}
                        data-testid="graph-resources-legend-item"
                        data-resource-name={group.name}
                        onMouseEnter={() => onResourceHover(group.name)}
                        onMouseLeave={() => onResourceHover(null)}
                        onSelect={() => onResourcePin(group.name)}
                      >
                        <span
                          aria-hidden="true"
                          className="mr-2 inline-block size-2.5 rounded-full"
                          style={{ backgroundColor: color.dot }}
                        />
                        <span className="flex-1 truncate">{group.name}</span>
                        <span className="ml-2 text-xs text-text-faint">
                          {group.memberTaskIds.length}
                          {group.activeBlockRefs.length > 0
                            ? ` · ${group.activeBlockRefs.length} ${t("inProgress")}`
                            : ""}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
      ) : null}
      {graph && pinnedResource
        ? (() => {
            const resourceGroup = graph.sharedResourceGroups.find(
              (group) => group.name === pinnedResource
            );
            if (!resourceGroup) {
              return null;
            }
            return (
              <div className="pointer-events-none absolute right-3 top-14 z-20">
                <ResourceInspector
                  graph={graph}
                  resourceGroup={resourceGroup}
                  onClose={clearPinnedResource}
                  onJumpToTask={(taskId) => onTaskPanelSelect(taskId)}
                  t={t}
                />
              </div>
            );
          })()
        : null}
      <FloatingAutoRunControl
        autoRunScopeMode={autoRunScopeMode}
        autoRunNextAction={autoRunNextAction}
        autoRunRetrospective={autoRunRetrospective}
        autoRunState={autoRunState}
        endpointScopeRunPhase={endpointScopeRunPhase}
        controlRef={autoRunControlRef}
        affectedTasks={fileSyncResult?.affectedTasks ?? []}
        diagnostics={fileSyncResult?.diagnostics ?? []}
        applyCanvasLaneLayout={applyCanvasLaneLayout}
        copyText={copyText}
        projectDiagnostics={projectDiagnostics}
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
        refreshProjectDerivedState={refreshProjectDerivedState}
        refreshedPromptCount={fileSyncResult?.refreshedPromptCount ?? 0}
        refreshConcurrency={fileSyncResult?.refreshConcurrency ?? null}
        watcherBackendKind={fileSyncResult?.watcherBackendKind}
        watcherChangedPathCount={fileSyncResult?.watcherChangedPathCount}
        watcherRefreshElapsedMs={fileSyncResult?.watcherRefreshElapsedMs}
        resetRuntimeStateClick={resetRuntimeStateClick}
        runtimeOperationsAllowed={runtimeOperationsAllowed}
        selectedBlockPresent={selectedBlockPresent}
        selectedCanvasId={selectedCanvasId}
        selectedProject={selectedProject}
        selectedTaskPanelId={selectedTaskPanelId}
        setAutoRunScopeMode={setAutoRunScopeMode}
        setError={setError}
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

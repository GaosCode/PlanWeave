import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
import type { DesktopCanvasExecutionPolicy, DesktopCanvasNodeViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { ClipboardIcon, FolderOpenIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { bridge } from "../bridge";
import { writeAgentScopePromptToClipboard } from "../agentPrompt";
import type { createTranslator } from "../i18n";
import { canvasMapEdges, canvasMapNodes, canvasNodeTypes, type DisplayCanvasEdgeData } from "../graph/canvasFlowModel";
import { useCanvasMap } from "../hooks/useCanvasMap";
import type { AppView, CanvasFlowNode } from "../types";
import { CanvasMapInspector } from "./CanvasMapInspector";

type CanvasMapViewProps = {
  handleOpenProject: () => Promise<void>;
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  onAgentPromptCopied: () => void;
  onTaskPanelSelect: (taskId: string | null) => void;
  refreshProjectDerivedState: () => Promise<void>;
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

function AgentScopeCard({
  canvas,
  onCopy,
  selectedProject,
  t
}: {
  canvas: DesktopCanvasNodeViewModel;
  onCopy: (canvas: DesktopCanvasNodeViewModel) => void;
  selectedProject: DesktopProjectSummary;
  t: ReturnType<typeof createTranslator>;
}) {
  const sourceRoot = selectedProject.sourceRoot ?? "";
  return (
    <Card className="min-w-0 max-w-full overflow-hidden" size="sm">
      <CardHeader className="min-w-0">
        <CardTitle className="min-w-0 truncate text-sm">{t("agentScope")}</CardTitle>
        <CardAction>
          <Button
            aria-label={t("copyAgentPrompt")}
            title={t("copyAgentPrompt")}
            size="icon-sm"
            variant="outline"
            onClick={() => onCopy(canvas)}
          >
            <ClipboardIcon data-icon="inline-start" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm">
        <ScopeField label={t("projectId")} value={selectedProject.projectId} />
        <ScopeField label={t("projectRoot")} value={selectedProject.rootPath} />
        <ScopeField label={t("workspaceRoot")} value={selectedProject.workspaceRoot} />
        <ScopeField label={t("canvasId")} value={canvas.canvasId} />
        <ScopeField label={t("packageDir")} value={canvas.packageDir} />
        <ScopeField label={t("sourceRoot")} value={sourceRoot} />
      </CardContent>
    </Card>
  );
}

function ScopeField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className="block max-w-full whitespace-normal break-words font-mono text-xs text-text-strong"
        style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
        title={value || "-"}
      >
        {value || "-"}
      </div>
    </div>
  );
}

export function CanvasMapView({
  handleOpenProject,
  handleOpenBlockInspector,
  loadProject,
  onAgentPromptCopied,
  onTaskPanelSelect,
  refreshProjectDerivedState,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError,
  t
}: CanvasMapViewProps) {
  const {
    canvasGraph,
    canvasMapLayout,
    loadCanvasMap,
    resetCanvasMapLayout,
    saveCanvasMapLayoutFromNodes,
    selectedCanvas,
    selectedMapCanvasId,
    setSelectedMapCanvasId
  } = useCanvasMap({ activeCanvasId: selectedCanvasId, selectedProject, setError });
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const dependencyLabel = t("canvasDependency");
  const copyAgentPromptLabel = t("copyAgentPrompt");
  const errorLabel = t("error");
  const enterCanvasLabel = t("enterCanvas");
  const warningLabel = t("warning");
  const canvasNodeLabels = useMemo(() => ({
    copyAgentPrompt: copyAgentPromptLabel,
    dependency: dependencyLabel,
    error: errorLabel,
    open: enterCanvasLabel,
    warning: warningLabel
  }), [copyAgentPromptLabel, dependencyLabel, enterCanvasLabel, errorLabel, warningLabel]);

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
  const copyAgentPrompt = useCallback(
    (canvas: DesktopCanvasNodeViewModel) => {
      if (!selectedProject) {
        return;
      }
      void writeAgentScopePromptToClipboard({
        project: selectedProject,
        canvasId: canvas.canvasId,
        packageDir: canvas.packageDir
      })
        .then(onAgentPromptCopied)
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    },
    [onAgentPromptCopied, selectedProject, setError]
  );
  const openCanvasRef = useRef(openCanvas);
  const copyAgentPromptRef = useRef(copyAgentPrompt);

  useEffect(() => {
    openCanvasRef.current = openCanvas;
    copyAgentPromptRef.current = copyAgentPrompt;
  }, [copyAgentPrompt, openCanvas]);

  const handleCanvasOpen = useCallback((canvasId: string) => {
    openCanvasRef.current(canvasId);
  }, []);
  const handleAgentPromptCopy = useCallback((canvas: DesktopCanvasNodeViewModel) => {
    copyAgentPromptRef.current(canvas);
  }, []);
  const saveExecutionPolicy = useCallback(
    async (canvasId: string, input: DesktopCanvasExecutionPolicy) => {
      if (!bridge || !selectedProject) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        await bridge.updateCanvasExecutionPolicy({ projectRoot: selectedProject.rootPath, canvasId }, input);
        await loadCanvasMap();
        await refreshProjectDerivedState();
      } catch (caught: unknown) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [loadCanvasMap, refreshProjectDerivedState, selectedProject, setError, t]
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
        canvasNodeLabels,
        selectedMapCanvasId,
        handleCanvasOpen,
        handleAgentPromptCopy,
        setSelectedMapCanvasId
      )
    );
    setEdges(canvasMapEdges(canvasGraph));
  }, [canvasGraph, canvasMapLayout, canvasNodeLabels, handleAgentPromptCopy, handleCanvasOpen, selectedMapCanvasId, setEdges, setNodes, setSelectedMapCanvasId]);

  const selectedEdgeData = canvasEdgeData(edges.find((edge) => edge.id === selectedEdgeId) ?? null);
  const agentScopeCanvasId = selectedMapCanvasId ?? selectedCanvasId ?? selectedProject?.activeCanvasId ?? canvasGraph?.canvases[0]?.canvasId ?? null;
  const agentScopeCanvas = canvasGraph?.canvases.find((canvas) => canvas.canvasId === agentScopeCanvasId) ?? canvasGraph?.canvases[0] ?? null;
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
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
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
      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border/80 bg-app-panel text-text">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-app-topbar px-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <GitBranchIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("canvasMap")}</span>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={t("resetCanvasMapLayout")} onClick={() => void resetCanvasMapLayout()}>
            <RotateCcwIcon data-icon="inline-start" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 overflow-x-hidden" viewportClassName="[&>div]:!block [&>div]:!min-w-0 [&>div]:!w-full">
          <div className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden p-3 pr-4">
            {agentScopeCanvas ? (
              <AgentScopeCard
                canvas={agentScopeCanvas}
                onCopy={copyAgentPrompt}
                selectedProject={selectedProject}
                t={t}
              />
            ) : null}
            <CanvasMapInspector
              graph={canvasGraph}
              onExecutionPolicySave={saveExecutionPolicy}
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

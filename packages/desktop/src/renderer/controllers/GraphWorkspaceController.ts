import type { Dispatch, DragEvent, MouseEvent, SetStateAction } from "react";
import type {
  Connection,
  Edge,
  Node,
  OnEdgesChange,
  OnNodesChange,
  ReactFlowInstance
} from "@xyflow/react";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopProjectExecutionPlan
} from "@planweave-ai/runtime";
import type { AppFlowNode } from "../types";
import type { AppEdgeTypes, AppNodeTypes } from "../graph/flowModel";
import type { createTranslator } from "../i18n";
import { useVisibleGraphTasks } from "../hooks/useVisibleGraphTasks";
import type { WorkspaceTabsGraphWorkspaceProps } from "../views/WorkspaceTabs";

export type GraphWorkspaceControllerInput = Omit<
  WorkspaceTabsGraphWorkspaceProps,
  "onAgentPromptCopied" | "selectedBlockPresent"
> & {
  selectedBlock: unknown | null;
  setSuccessMessage: (value: SetStateAction<string | null>) => void;
  t: ReturnType<typeof createTranslator>;
};

export type GraphWorkspaceController = WorkspaceTabsGraphWorkspaceProps;

export function createGraphWorkspaceController({
  selectedBlock,
  setSuccessMessage,
  t,
  ...props
}: GraphWorkspaceControllerInput): GraphWorkspaceController {
  return {
    ...props,
    onAgentPromptCopied: () => setSuccessMessage(t("agentPromptCopied")),
    selectedBlockPresent: Boolean(selectedBlock)
  };
}

export function useGraphWorkspaceController({
  edges,
  edgeTypes,
  executionPlan,
  graph,
  handleConnect,
  handleEdgesDelete,
  handleGraphDragOver,
  handleGraphDrop,
  handleOpenBlockInspector,
  handleOpenRunRecord,
  handleReconnectEdge,
  handleRedoGraph,
  handleTaskPanelSelect,
  handleUndoGraph,
  nodeTypes,
  nodes,
  onEdgesChange,
  onNodeDragStop,
  onNodesChange,
  searchQuery,
  selectedBlock,
  setFlowInstance,
  setSuccessMessage,
  t,
  pinnedLock,
  onLockHover,
  onLockPin,
  clearPinnedLock,
  refreshGraphLocks
}: {
  edges: Edge[];
  edgeTypes: AppEdgeTypes;
  executionPlan: DesktopProjectExecutionPlan | null;
  graph: DesktopGraphViewModel | null;
  handleConnect: (connection: Connection) => Promise<void>;
  handleEdgesDelete: (deletedEdges: Edge[]) => Promise<void>;
  handleGraphDragOver: (event: DragEvent) => void;
  handleGraphDrop: (event: DragEvent) => void;
  handleOpenBlockInspector: (ref: string, canvasId?: string | null) => Promise<void>;
  handleOpenRunRecord: (
    recordId: string | null | undefined,
    canvasId?: string | null
  ) => Promise<void>;
  handleReconnectEdge: (oldEdge: Edge, connection: Connection) => Promise<void>;
  handleRedoGraph: () => Promise<void>;
  handleTaskPanelSelect: (taskId: string | null) => void;
  handleUndoGraph: () => Promise<void>;
  nodeTypes: AppNodeTypes;
  nodes: AppFlowNode[];
  onEdgesChange: OnEdgesChange<Edge>;
  onNodeDragStop: (event: MouseEvent, node: Node) => Promise<void>;
  onNodesChange: OnNodesChange<AppFlowNode>;
  searchQuery: string;
  selectedBlock: DesktopBlockDetail | null;
  setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<AppFlowNode, Edge> | null>>;
  setSuccessMessage: (value: SetStateAction<string | null>) => void;
  t: ReturnType<typeof createTranslator>;
  pinnedLock: string | null;
  onLockHover: (name: string | null) => void;
  onLockPin: (name: string | null) => void;
  clearPinnedLock: () => void;
  refreshGraphLocks: () => Promise<void>;
}): GraphWorkspaceController {
  const { visibleTaskIds, visibleTasks } = useVisibleGraphTasks(graph, searchQuery);

  return createGraphWorkspaceController({
    edges,
    edgeTypes,
    executionPlan,
    graph,
    handleConnect,
    handleEdgesDelete,
    handleGraphDragOver,
    handleGraphDrop,
    handleOpenBlockInspector,
    handleOpenRunRecord,
    handleReconnectEdge,
    handleRedoGraph,
    handleUndoGraph,
    nodeTypes,
    nodes,
    onEdgesChange,
    onNodeDragStop,
    onNodesChange,
    onTaskPanelSelect: handleTaskPanelSelect,
    selectedBlock,
    setFlowInstance,
    setSuccessMessage,
    t,
    visibleTaskIds,
    visibleTasks,
    pinnedLock,
    onLockHover,
    onLockPin,
    clearPinnedLock,
    refreshGraphLocks
  });
}

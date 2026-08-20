import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopLayout
} from "@planweave-ai/runtime";
import {
  graphEdges,
  graphNodes,
  type GraphAssigneeUiState,
  type GraphCommentUiState,
  type GraphSharedResourceUiState
} from "../graph/flowModel";
import { taskNodeLabels } from "../graph/taskNodeLabels";
import type { createTranslator } from "../i18n";
import type { AppFlowNode, TaskNodeData } from "../types";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import { formatAgentEndpointFleetCatalogError } from "../collaboration/formatAgentEndpointFleetCatalogError";
import type { CollaborationRuntimeAvailabilityView } from "../collaboration/runtimeAvailabilityView";

type GraphFlowSource = {
  agentEndpointCatalogErrorCode?: string | null;
  agentEndpoints: AvailableAgentEndpoint[];
  selectedAgentEndpointIdForTask: (taskId: string, executorName: string) => string;
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  selectedBlock: DesktopBlockDetail | null;
  t: ReturnType<typeof createTranslator>;
  resourceUi?: GraphSharedResourceUiState;
  assigneeUi?: GraphAssigneeUiState | null;
  commentUi?: GraphCommentUiState | null;
  runtimeAvailability: CollaborationRuntimeAvailabilityView;
};

type GraphFlowDrafts = {
  promptDrafts: Record<string, string>;
  saveStates: Record<string, TaskNodeData["saveState"]>;
  titleDrafts: Record<string, string>;
};

type GraphFlowTaskActions = {
  handleDeleteBlock: TaskNodeData["onBlockDelete"];
  handleDeleteTaskNode: TaskNodeData["onTaskDelete"];
  handleOpenBlockInspector: TaskNodeData["onBlockSelect"];
  handleOpenBlockWorkspace: TaskNodeData["onBlockWorkspaceOpen"];
  handleOpenRunRecord: TaskNodeData["onOpenRunRecord"];
  handleOpenTaskInspector: TaskNodeData["onTaskOpen"];
  handleOpenTaskWorkspace: TaskNodeData["onTaskWorkspaceOpen"];
  handleCopyAgentPrompt: TaskNodeData["onAgentPromptCopy"];
  handleRevealTaskInFinder: TaskNodeData["onRevealTaskInFinder"];
  handlePromptChange: TaskNodeData["onPromptChange"];
  handlePromptHistoryRedo: TaskNodeData["onPromptHistoryRedo"];
  handlePromptHistoryUndo: TaskNodeData["onPromptHistoryUndo"];
  handlePromptSave: TaskNodeData["onPromptSave"];
  handleTaskAgentEndpointChange: TaskNodeData["onAgentEndpointChange"];
  handleTitleChange: TaskNodeData["onTitleChange"];
  handleTitleSave: TaskNodeData["onTitleSave"];
  startAutoRunWithScope: TaskNodeData["onAutoRunScopeStart"];
};

type GraphFlowBlockActions = {
  saveSelectedBlockPrompt: TaskNodeData["onBlockPromptSave"];
  saveSelectedBlockTitle: TaskNodeData["onBlockTitleSave"];
};

type GraphFlowState = {
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  setNodes: Dispatch<SetStateAction<AppFlowNode[]>>;
  setSelectedBlock: TaskNodeData["onSelectedBlockChange"];
};

type UseGraphFlowModelArgs = {
  blockActions: GraphFlowBlockActions;
  drafts: GraphFlowDrafts;
  flowState: GraphFlowState;
  source: GraphFlowSource;
  taskActions: GraphFlowTaskActions;
};

export function useGraphFlowModel({
  blockActions,
  drafts,
  flowState,
  source,
  taskActions
}: UseGraphFlowModelArgs) {
  const {
    agentEndpointCatalogErrorCode = null,
    agentEndpoints,
    selectedAgentEndpointIdForTask,
    graph,
    layout,
    selectedBlock,
    t,
    resourceUi,
    assigneeUi,
    commentUi,
    runtimeAvailability
  } = source;
  const { promptDrafts, saveStates, titleDrafts } = drafts;
  const activeResource = resourceUi?.activeResource ?? null;
  const transitionEpochByResource = resourceUi?.transitionEpochByResource;
  const onResourceHover = resourceUi?.onResourceHover;
  const onResourcePin = resourceUi?.onResourcePin;
  const onResourceOverflow = resourceUi?.onResourceOverflow;
  const {
    handleDeleteBlock,
    handleDeleteTaskNode,
    handleOpenBlockInspector,
    handleOpenBlockWorkspace,
    handleOpenRunRecord,
    handleOpenTaskInspector,
    handleOpenTaskWorkspace,
    handleCopyAgentPrompt,
    handleRevealTaskInFinder,
    handlePromptChange,
    handlePromptHistoryRedo,
    handlePromptHistoryUndo,
    handlePromptSave,
    handleTaskAgentEndpointChange,
    handleTitleChange,
    handleTitleSave,
    startAutoRunWithScope
  } = taskActions;
  const { saveSelectedBlockPrompt, saveSelectedBlockTitle } = blockActions;
  const { setEdges, setNodes, setSelectedBlock } = flowState;
  const agentEndpointFleetCatalogError = formatAgentEndpointFleetCatalogError(
    agentEndpointCatalogErrorCode,
    t
  );

  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const resolvedResourceUi: GraphSharedResourceUiState = {
      activeResource,
      transitionEpochByResource: transitionEpochByResource ?? {},
      onResourceHover: onResourceHover ?? (() => undefined),
      onResourcePin: onResourcePin ?? (() => undefined),
      onResourceOverflow: onResourceOverflow ?? (() => undefined)
    };
    setNodes(
      graphNodes(
        graph,
        layout,
        agentEndpoints,
        agentEndpointFleetCatalogError,
        selectedAgentEndpointIdForTask,
        titleDrafts,
        promptDrafts,
        saveStates,
        taskNodeLabels(t),
        selectedBlock,
        handleTitleChange,
        handleTitleSave,
        handleTaskAgentEndpointChange,
        handlePromptChange,
        handlePromptSave,
        handlePromptHistoryRedo,
        handlePromptHistoryUndo,
        handleOpenBlockInspector,
        handleOpenBlockInspector,
        handleOpenBlockWorkspace,
        handleOpenTaskInspector,
        handleOpenTaskWorkspace,
        handleCopyAgentPrompt,
        handleRevealTaskInFinder,
        startAutoRunWithScope,
        handleDeleteTaskNode,
        handleDeleteBlock,
        setSelectedBlock,
        saveSelectedBlockTitle,
        saveSelectedBlockPrompt,
        handleOpenRunRecord,
        resolvedResourceUi,
        assigneeUi ?? null,
        commentUi ?? null,
        runtimeAvailability
      )
    );
    setEdges(graphEdges(graph, { activeResource }));
  }, [
    activeResource,
    assigneeUi,
    commentUi,
    runtimeAvailability,
    transitionEpochByResource,
    onResourceHover,
    onResourcePin,
    onResourceOverflow,
    agentEndpointFleetCatalogError,
    agentEndpoints,
    selectedAgentEndpointIdForTask,
    graph,
    handleDeleteBlock,
    handleDeleteTaskNode,
    handleOpenBlockInspector,
    handleOpenBlockWorkspace,
    handleCopyAgentPrompt,
    handleRevealTaskInFinder,
    handleOpenRunRecord,
    handleOpenTaskInspector,
    handleOpenTaskWorkspace,
    handlePromptChange,
    handlePromptHistoryRedo,
    handlePromptHistoryUndo,
    handlePromptSave,
    handleTaskAgentEndpointChange,
    handleTitleChange,
    handleTitleSave,
    layout,
    promptDrafts,
    saveSelectedBlockPrompt,
    saveSelectedBlockTitle,
    saveStates,
    selectedBlock,
    setEdges,
    setNodes,
    setSelectedBlock,
    startAutoRunWithScope,
    t,
    titleDrafts
  ]);
}

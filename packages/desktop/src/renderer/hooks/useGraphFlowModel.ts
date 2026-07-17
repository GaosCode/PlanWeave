import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import type {
  DesktopAgentDetection,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopReviewAttemptSummary,
  RunnerTransport
} from "@planweave-ai/runtime";
import { graphEdges, graphNodes, type GraphSharedResourceUiState } from "../graph/flowModel";
import { taskNodeLabels } from "../graph/taskNodeLabels";
import type { createTranslator } from "../i18n";
import type { AppFlowNode, TaskNodeData } from "../types";

type GraphFlowSource = {
  agentDetections: DesktopAgentDetection[];
  agentTransport?: RunnerTransport;
  executorOptions: string[];
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  selectedBlock: DesktopBlockDetail | null;
  t: ReturnType<typeof createTranslator>;
  resourceUi?: GraphSharedResourceUiState;
};

type GraphFlowDrafts = {
  promptDrafts: Record<string, string>;
  saveStates: Record<string, TaskNodeData["saveState"]>;
  titleDrafts: Record<string, string>;
};

type GraphFlowRecords = {
  blockFeedbackRecords: DesktopFeedbackRecord[];
  blockReviewAttempts: DesktopReviewAttemptSummary[];
  blockRunRecords: DesktopBlockRunRecordSummary[];
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
  handleTaskExecutorChange: TaskNodeData["onExecutorChange"];
  handleTitleChange: TaskNodeData["onTitleChange"];
  handleTitleSave: TaskNodeData["onTitleSave"];
  startAutoRunWithScope: TaskNodeData["onAutoRunScopeStart"];
};

type GraphFlowBlockActions = {
  saveSelectedBlockExecutor: TaskNodeData["onBlockExecutorChange"];
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
  records: GraphFlowRecords;
  source: GraphFlowSource;
  taskActions: GraphFlowTaskActions;
};

export function useGraphFlowModel({
  blockActions,
  drafts,
  flowState,
  records,
  source,
  taskActions
}: UseGraphFlowModelArgs) {
  const {
    agentDetections,
    agentTransport,
    executorOptions,
    graph,
    layout,
    selectedBlock,
    t,
    resourceUi
  } = source;
  const { promptDrafts, saveStates, titleDrafts } = drafts;
  const activeResource = resourceUi?.activeResource ?? null;
  const transitionEpochByResource = resourceUi?.transitionEpochByResource;
  const onResourceHover = resourceUi?.onResourceHover;
  const onResourcePin = resourceUi?.onResourcePin;
  const onResourceOverflow = resourceUi?.onResourceOverflow;
  const { blockFeedbackRecords, blockReviewAttempts, blockRunRecords } = records;
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
    handleTaskExecutorChange,
    handleTitleChange,
    handleTitleSave,
    startAutoRunWithScope
  } = taskActions;
  const { saveSelectedBlockExecutor, saveSelectedBlockPrompt, saveSelectedBlockTitle } =
    blockActions;
  const { setEdges, setNodes, setSelectedBlock } = flowState;

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
        agentTransport ? { ...graph, agentTransport } : graph,
        layout,
        agentDetections,
        executorOptions,
        titleDrafts,
        promptDrafts,
        saveStates,
        taskNodeLabels(t),
        selectedBlock,
        blockRunRecords,
        blockReviewAttempts,
        blockFeedbackRecords,
        handleTitleChange,
        handleTitleSave,
        handleTaskExecutorChange,
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
        saveSelectedBlockExecutor,
        saveSelectedBlockPrompt,
        handleOpenRunRecord,
        resolvedResourceUi
      )
    );
    setEdges(graphEdges(graph, { activeResource }));
  }, [
    activeResource,
    transitionEpochByResource,
    onResourceHover,
    onResourcePin,
    onResourceOverflow,
    blockFeedbackRecords,
    blockReviewAttempts,
    blockRunRecords,
    agentDetections,
    agentTransport,
    executorOptions,
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
    handleTaskExecutorChange,
    handleTitleChange,
    handleTitleSave,
    layout,
    promptDrafts,
    saveSelectedBlockExecutor,
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

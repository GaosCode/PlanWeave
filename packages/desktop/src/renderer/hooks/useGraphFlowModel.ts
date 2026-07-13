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
import { graphEdges, graphNodes, type GraphLockUiState } from "../graph/flowModel";
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
  lockUi?: GraphLockUiState;
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
  handleOpenRunRecord: TaskNodeData["onOpenRunRecord"];
  handleOpenTaskInspector: TaskNodeData["onTaskOpen"];
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
    lockUi
  } = source;
  const { promptDrafts, saveStates, titleDrafts } = drafts;
  const activeLock = lockUi?.activeLock ?? null;
  const releaseEpochByLock = lockUi?.releaseEpochByLock;
  const onLockHover = lockUi?.onLockHover;
  const onLockPin = lockUi?.onLockPin;
  const onLockOverflow = lockUi?.onLockOverflow;
  const onJumpToTask = lockUi?.onJumpToTask;
  const { blockFeedbackRecords, blockReviewAttempts, blockRunRecords } = records;
  const {
    handleDeleteBlock,
    handleDeleteTaskNode,
    handleOpenBlockInspector,
    handleOpenRunRecord,
    handleOpenTaskInspector,
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
    const resolvedLockUi: GraphLockUiState = {
      activeLock,
      releaseEpochByLock: releaseEpochByLock ?? {},
      onLockHover: onLockHover ?? (() => undefined),
      onLockPin: onLockPin ?? (() => undefined),
      onLockOverflow: onLockOverflow ?? (() => undefined),
      onJumpToTask: onJumpToTask ?? (() => undefined)
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
        handleOpenTaskInspector,
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
        resolvedLockUi
      )
    );
    setEdges(graphEdges(graph, { activeLock }));
  }, [
    activeLock,
    releaseEpochByLock,
    onLockHover,
    onLockPin,
    onLockOverflow,
    onJumpToTask,
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
    handleCopyAgentPrompt,
    handleRevealTaskInFinder,
    handleOpenRunRecord,
    handleOpenTaskInspector,
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

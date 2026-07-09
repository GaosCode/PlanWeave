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
  DesktopReviewAttemptSummary
} from "@planweave-ai/runtime";
import { graphEdges, graphNodes } from "../graph/flowModel";
import { taskNodeLabels } from "../graph/taskNodeLabels";
import type { createTranslator } from "../i18n";
import type { AppFlowNode, TaskNodeData } from "../types";

type GraphFlowSource = {
  agentDetections: DesktopAgentDetection[];
  executorOptions: string[];
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  selectedBlock: DesktopBlockDetail | null;
  t: ReturnType<typeof createTranslator>;
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
  const { agentDetections, executorOptions, graph, layout, selectedBlock, t } = source;
  const { promptDrafts, saveStates, titleDrafts } = drafts;
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
    setNodes(
      graphNodes(
        graph,
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
        handleOpenRunRecord
      )
    );
    setEdges(graphEdges(graph));
  }, [
    blockFeedbackRecords,
    blockReviewAttempts,
    blockRunRecords,
    agentDetections,
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

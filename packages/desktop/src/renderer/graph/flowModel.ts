import { MarkerType, type Edge } from "@xyflow/react";
import type { DesktopBlockDetail, DesktopBlockRunRecordSummary, DesktopFeedbackRecord, DesktopGraphViewModel, DesktopLayout, DesktopReviewAttemptSummary } from "@planweave/runtime";
import type { AppFlowNode, ContextFlowNode, TaskFlowNode, TaskNodeData } from "../types";
import { TaskNodeCard } from "./TaskNodeCard";
import { ContextNodeCard } from "./ContextNodeCard";

export const nodeTypes = {
  task: TaskNodeCard,
  context: ContextNodeCard
};

export type AppNodeTypes = typeof nodeTypes;

export function graphNodes(
  graph: DesktopGraphViewModel,
  layout: DesktopLayout | null,
  executorOptions: string[],
  titleDrafts: Record<string, string>,
  promptDrafts: Record<string, string>,
  saveStates: Record<string, TaskNodeData["saveState"]>,
  labels: TaskNodeData["labels"],
  selectedBlock: DesktopBlockDetail | null,
  blockRunRecords: DesktopBlockRunRecordSummary[],
  blockReviewAttempts: DesktopReviewAttemptSummary[],
  blockFeedbackRecords: DesktopFeedbackRecord[],
  onTitleChange: TaskNodeData["onTitleChange"],
  onTitleSave: TaskNodeData["onTitleSave"],
  onExecutorChange: TaskNodeData["onExecutorChange"],
  onPromptChange: TaskNodeData["onPromptChange"],
  onPromptSave: TaskNodeData["onPromptSave"],
  onBlockSelect: TaskNodeData["onBlockSelect"],
  onOverflowBlockSelect: TaskNodeData["onOverflowBlockSelect"],
  onTaskDelete: TaskNodeData["onTaskDelete"],
  onBlockDelete: TaskNodeData["onBlockDelete"],
  onSelectedBlockChange: TaskNodeData["onSelectedBlockChange"],
  onBlockTitleSave: TaskNodeData["onBlockTitleSave"],
  onBlockExecutorChange: TaskNodeData["onBlockExecutorChange"],
  onBlockPromptSave: TaskNodeData["onBlockPromptSave"],
  onOpenRunRecord: TaskNodeData["onOpenRunRecord"],
  selectedContextNodeId: string | null
): AppFlowNode[] {
  const layoutByNode = new Map(layout?.nodes.map((node) => [node.nodeId, node]) ?? []);
  const taskNodes: TaskFlowNode[] = graph.tasks.map((task, index) => {
    const saved = layoutByNode.get(task.taskId);
    return {
      id: task.taskId,
      type: "task",
      position: saved ? { x: saved.x, y: saved.y } : { x: 80 + (index % 3) * 460, y: 80 + Math.floor(index / 3) * 480 },
      data: {
        task,
        titleDraft: titleDrafts[task.taskId] ?? task.title,
        promptDraft: promptDrafts[task.taskId] ?? task.promptMarkdown,
        saveState: saveStates[task.taskId] ?? "idle",
        executorOptions,
        labels,
        selectedBlock,
        blockRunRecords,
        blockReviewAttempts,
        blockFeedbackRecords,
        onTitleChange,
        onTitleSave,
        onExecutorChange,
        onPromptChange,
        onPromptSave,
        onBlockSelect,
        onOverflowBlockSelect,
        onTaskDelete,
        onBlockDelete,
        onSelectedBlockChange,
        onBlockTitleSave,
        onBlockExecutorChange,
        onBlockPromptSave,
        onOpenRunRecord
      }
    };
  });
  const contextNodes: ContextFlowNode[] = graph.contextNodes.map((node, index) => ({
    id: node.nodeId,
    type: "context",
    position: layoutByNode.get(node.nodeId) ?? { x: 560 + (index % 2) * 380, y: 120 + Math.floor(index / 2) * 220 },
    data: { node, selected: node.nodeId === selectedContextNodeId }
  }));
  return [...taskNodes, ...contextNodes];
}

export function graphEdges(graph: DesktopGraphViewModel): Edge[] {
  const nodeIds = new Set([...graph.tasks.map((task) => task.taskId), ...graph.contextNodes.map((node) => node.nodeId)]);
  return graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => {
      const isTaskDependency = edge.type === "depends_on";
      return {
        id: `${edge.from}-${edge.type}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        animated: false,
        type: isTaskDependency ? "smoothstep" : "default",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isTaskDependency ? "#ea580c" : "#2563eb",
          width: 18,
          height: 18
        },
        style: {
          stroke: isTaskDependency ? "#ea580c" : "#2563eb",
          strokeWidth: isTaskDependency ? 2.4 : 2,
          opacity: 0.95
        }
      } satisfies Edge;
    });
}

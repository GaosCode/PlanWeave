import { MarkerType, type Edge, type EdgeTypes } from "@xyflow/react";
import type {
  DesktopAgentDetection,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopReviewAttemptSummary
} from "@planweave-ai/runtime";
import type { AppFlowNode, TaskFlowNode, TaskNodeData } from "../types";
import { TaskNodeCard } from "./TaskNodeCard";
import { TaskDependencyEdge } from "./TaskDependencyEdge";
import {
  dependencyEdgeColorForSource,
  dependencyEdgeDefaultOpacity,
  dependencyEdgeSourceColors
} from "./dependencyEdgeVisual";
import { displayEdgeManifestData, executionFlowEndpoints } from "./dependencyEdges";

export const nodeTypes = {
  task: TaskNodeCard
};

export type GraphSharedResourceUiState = {
  activeResource: string | null;
  transitionEpochByResource: Record<string, number>;
  onResourceHover: TaskNodeData["onResourceHover"];
  onResourcePin: TaskNodeData["onResourcePin"];
  onResourceOverflow: TaskNodeData["onResourceOverflow"];
};

export type AppNodeTypes = typeof nodeTypes;

export const taskDependencyEdgeType = "taskDependency";

export const edgeTypes = {
  [taskDependencyEdgeType]: TaskDependencyEdge
} satisfies EdgeTypes;

export type AppEdgeTypes = typeof edgeTypes;

const defaultLayoutOrigin = { x: 80, y: 80 };
const defaultLayoutColumnGap = 460;
const defaultLayoutRowGap = 360;
type FlowPosition = {
  x: number;
  y: number;
};

type GraphEdgeData = ReturnType<typeof displayEdgeManifestData> & {
  sourceTaskId: string;
  targetTaskId: string;
  sourceColor: string;
};

export function defaultTaskNodePositions(graph: DesktopGraphViewModel): Map<string, FlowPosition> {
  const taskIds = graph.tasks.map((task) => task.taskId);
  const taskIdsSet = new Set(taskIds);
  const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]));
  const outgoing = new Map(taskIds.map((taskId) => [taskId, [] as string[]]));
  const incoming = new Map(taskIds.map((taskId) => [taskId, [] as string[]]));
  const indegree = new Map(taskIds.map((taskId) => [taskId, 0]));
  const edgeKeys = new Set<string>();

  for (const edge of graph.edges) {
    const endpoints = executionFlowEndpoints(edge);
    if (
      !taskIdsSet.has(endpoints.source) ||
      !taskIdsSet.has(endpoints.target) ||
      endpoints.source === endpoints.target
    ) {
      continue;
    }
    const edgeKey = `${endpoints.source}\u0000${endpoints.target}`;
    if (edgeKeys.has(edgeKey)) {
      continue;
    }
    edgeKeys.add(edgeKey);
    outgoing.get(endpoints.source)?.push(endpoints.target);
    incoming.get(endpoints.target)?.push(endpoints.source);
    indegree.set(endpoints.target, (indegree.get(endpoints.target) ?? 0) + 1);
  }

  for (const targets of outgoing.values()) {
    targets.sort((left, right) => (taskOrder.get(left) ?? 0) - (taskOrder.get(right) ?? 0));
  }

  const layerByNode = new Map(taskIds.map((taskId) => [taskId, 0]));
  const queue = taskIds.filter((taskId) => (indegree.get(taskId) ?? 0) === 0);
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    visited.add(source);
    const sourceLayer = layerByNode.get(source) ?? 0;
    for (const target of outgoing.get(source) ?? []) {
      layerByNode.set(target, Math.max(layerByNode.get(target) ?? 0, sourceLayer + 1));
      const nextIndegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(target);
      }
    }
  }

  for (const taskId of taskIds) {
    if (!visited.has(taskId)) {
      layerByNode.set(taskId, layerByNode.get(taskId) ?? 0);
    }
  }

  const layers = new Map<number, string[]>();
  for (const taskId of taskIds) {
    const layer = layerByNode.get(taskId) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), taskId]);
  }

  const rowByNode = new Map<string, number>();
  const positions = new Map<string, FlowPosition>();
  const sortedLayers = [...layers.keys()].sort((left, right) => left - right);
  for (const layer of sortedLayers) {
    const layerNodes = [...(layers.get(layer) ?? [])];
    layerNodes.sort((left, right) => {
      const leftWeight = parentRowWeight(left, incoming, rowByNode, taskOrder);
      const rightWeight = parentRowWeight(right, incoming, rowByNode, taskOrder);
      return leftWeight - rightWeight || (taskOrder.get(left) ?? 0) - (taskOrder.get(right) ?? 0);
    });
    layerNodes.forEach((taskId, row) => {
      rowByNode.set(taskId, row);
      positions.set(taskId, {
        x: defaultLayoutOrigin.x + layer * defaultLayoutColumnGap,
        y: defaultLayoutOrigin.y + row * defaultLayoutRowGap
      });
    });
  }

  return positions;
}

function parentRowWeight(
  taskId: string,
  incoming: Map<string, string[]>,
  rowByNode: Map<string, number>,
  taskOrder: Map<string, number>
): number {
  const parentRows = (incoming.get(taskId) ?? []).flatMap((parentId) => {
    const row = rowByNode.get(parentId);
    return row === undefined ? [] : [row];
  });
  if (parentRows.length === 0) {
    return taskOrder.get(taskId) ?? 0;
  }
  return parentRows.reduce((sum, row) => sum + row, 0) / parentRows.length;
}

export function graphNodes(
  graph: DesktopGraphViewModel,
  layout: DesktopLayout | null,
  agentDetections: DesktopAgentDetection[],
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
  onPromptHistoryRedo: TaskNodeData["onPromptHistoryRedo"],
  onPromptHistoryUndo: TaskNodeData["onPromptHistoryUndo"],
  onBlockSelect: TaskNodeData["onBlockSelect"],
  onOverflowBlockSelect: TaskNodeData["onOverflowBlockSelect"],
  onBlockWorkspaceOpen: TaskNodeData["onBlockWorkspaceOpen"],
  onTaskOpen: TaskNodeData["onTaskOpen"],
  onTaskWorkspaceOpen: TaskNodeData["onTaskWorkspaceOpen"],
  onAgentPromptCopy: TaskNodeData["onAgentPromptCopy"],
  onRevealTaskInFinder: TaskNodeData["onRevealTaskInFinder"],
  onAutoRunScopeStart: TaskNodeData["onAutoRunScopeStart"],
  onTaskDelete: TaskNodeData["onTaskDelete"],
  onBlockDelete: TaskNodeData["onBlockDelete"],
  onSelectedBlockChange: TaskNodeData["onSelectedBlockChange"],
  onBlockTitleSave: TaskNodeData["onBlockTitleSave"],
  onBlockExecutorChange: TaskNodeData["onBlockExecutorChange"],
  onBlockPromptSave: TaskNodeData["onBlockPromptSave"],
  onOpenRunRecord: TaskNodeData["onOpenRunRecord"],
  resourceUi: GraphSharedResourceUiState = {
    activeResource: null,
    transitionEpochByResource: {},
    onResourceHover: () => undefined,
    onResourcePin: () => undefined,
    onResourceOverflow: () => undefined
  }
): AppFlowNode[] {
  const layoutByNode = new Map(layout?.nodes.map((node) => [node.nodeId, node]) ?? []);
  const defaultPositions = defaultTaskNodePositions(graph);
  const resourceGroups = graph.sharedResourceGroups;
  const activeGroup = resourceUi.activeResource
    ? resourceGroups.find((group) => group.name === resourceUi.activeResource)
    : null;
  const activeMembers = new Set(activeGroup?.memberTaskIds ?? []);
  const activeResourceNames = new Set(
    resourceGroups
      .filter((group) => group.activeBlockRefs.length > 0)
      .map((group) => group.name)
  );
  const taskNodes: TaskFlowNode[] = graph.tasks.map((task, index) => {
    const saved = layoutByNode.get(task.taskId);
    const defaultPosition = defaultPositions.get(task.taskId) ?? {
      x: defaultLayoutOrigin.x + (index % 3) * defaultLayoutColumnGap,
      y: defaultLayoutOrigin.y + Math.floor(index / 3) * defaultLayoutRowGap
    };
    const sharedResources = task.sharedResources;
    const resourceHighlighted =
      resourceUi.activeResource != null && activeMembers.has(task.taskId);
    const dimmed = resourceUi.activeResource != null && !activeMembers.has(task.taskId);
    return {
      id: task.taskId,
      type: "task",
      position: saved ? { x: saved.x, y: saved.y } : defaultPosition,
      data: {
        task,
        titleDraft: titleDrafts[task.taskId] ?? task.title,
        promptDraft: promptDrafts[task.taskId] ?? task.promptMarkdown,
        saveState: saveStates[task.taskId] ?? "idle",
        agentDetections,
        agentTransport: graph.agentTransport,
        executorOptions,
        packageExecutorNames: graph.packageExecutorNames,
        labels,
        selectedBlock,
        blockRunRecords,
        blockReviewAttempts,
        blockFeedbackRecords,
        sharedResources,
        activeSharedResources: new Set(
          sharedResources.filter((name) => activeResourceNames.has(name))
        ),
        highlightedResource: resourceUi.activeResource,
        resourceHighlighted,
        dimmed,
        transitionEpochByResource: resourceUi.transitionEpochByResource,
        onTitleChange,
        onTitleSave,
        onExecutorChange,
        onPromptChange,
        onPromptSave,
        onPromptHistoryRedo,
        onPromptHistoryUndo,
        onBlockSelect,
        onOverflowBlockSelect,
        onBlockWorkspaceOpen,
        onTaskOpen,
        onTaskWorkspaceOpen,
        onAgentPromptCopy,
        onRevealTaskInFinder,
        onAutoRunScopeStart,
        onTaskDelete,
        onBlockDelete,
        onSelectedBlockChange,
        onBlockTitleSave,
        onBlockExecutorChange,
        onBlockPromptSave,
        onOpenRunRecord,
        onResourceHover: resourceUi.onResourceHover,
        onResourcePin: resourceUi.onResourcePin,
        onResourceOverflow: resourceUi.onResourceOverflow
      }
    };
  });
  return taskNodes;
}

export function graphEdges(
  graph: DesktopGraphViewModel,
  options: { activeResource?: string | null } = {}
): Edge[] {
  const nodeIds = new Set(graph.tasks.map((task) => task.taskId));
  const dependencyLinks = graph.edges
    .map(executionFlowEndpoints)
    .filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target));
  const sourceColors = dependencyEdgeSourceColors(
    graph.tasks.map((task) => task.taskId),
    dependencyLinks
  );
  const resourceGroups = graph.sharedResourceGroups;
  const activeGroup = options.activeResource
    ? resourceGroups.find((group) => group.name === options.activeResource)
    : null;
  const activeMembers = new Set(activeGroup?.memberTaskIds ?? []);
  const dimEdges = options.activeResource != null;
  return graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => {
      const isTaskDependency = edge.type === "depends_on";
      const endpoints = executionFlowEndpoints(edge);
      const edgeId = `${edge.from}-${edge.type}-${edge.to}`;
      const color =
        sourceColors.get(endpoints.source) ?? dependencyEdgeColorForSource(endpoints.source);
      const edgeTouchesGroup =
        activeMembers.has(endpoints.source) && activeMembers.has(endpoints.target);
      const opacity = dimEdges && !edgeTouchesGroup ? 0.4 : dependencyEdgeDefaultOpacity;
      return {
        id: edgeId,
        source: endpoints.source,
        target: endpoints.target,
        data: {
          ...displayEdgeManifestData(edge),
          sourceTaskId: endpoints.source,
          targetTaskId: endpoints.target,
          sourceColor: color,
          dimmed: dimEdges && !edgeTouchesGroup
        } satisfies GraphEdgeData & { dimmed: boolean },
        animated: false,
        type: isTaskDependency ? taskDependencyEdgeType : "default",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 18,
          height: 18
        },
        style: {
          stroke: color,
          strokeWidth: isTaskDependency ? 2.2 : 1.9,
          opacity,
          transition: "opacity 120ms ease, stroke-width 120ms ease"
        }
      } satisfies Edge;
    });
}

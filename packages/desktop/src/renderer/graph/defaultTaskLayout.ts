import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { executionFlowEndpoints } from "./dependencyEdges";

const defaultLayoutOrigin = { x: 80, y: 80 };
const taskNodeMinimumSize = { width: 320, height: 220 };
const taskNodeGap = 140;
const defaultLayoutColumnGap = 460;
const defaultLayoutRowGap = 360;
type FlowPosition = {
  x: number;
  y: number;
};

export type TaskLayoutNode = {
  id: string;
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
};

export function defaultTaskNodePositions(
  graph: DesktopGraphViewModel,
  nodes: readonly TaskLayoutNode[] = []
): Map<string, FlowPosition> {
  const sizeByNode = new Map(
    nodes.map((node) => [
      node.id,
      {
        width: Math.max(
          taskNodeMinimumSize.width,
          node.measured?.width ?? node.width ?? taskNodeMinimumSize.width
        ),
        height: Math.max(
          taskNodeMinimumSize.height,
          node.measured?.height ?? node.height ?? taskNodeMinimumSize.height
        )
      }
    ])
  );
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
  let x = defaultLayoutOrigin.x;
  for (const layer of sortedLayers) {
    const layerNodes = [...(layers.get(layer) ?? [])];
    layerNodes.sort((left, right) => {
      const leftWeight = parentRowWeight(left, incoming, rowByNode, taskOrder);
      const rightWeight = parentRowWeight(right, incoming, rowByNode, taskOrder);
      return leftWeight - rightWeight || (taskOrder.get(left) ?? 0) - (taskOrder.get(right) ?? 0);
    });
    let y = defaultLayoutOrigin.y;
    let columnStep = defaultLayoutColumnGap;
    layerNodes.forEach((taskId, row) => {
      rowByNode.set(taskId, row);
      const size = sizeByNode.get(taskId) ?? taskNodeMinimumSize;
      positions.set(taskId, { x, y });
      y += Math.max(defaultLayoutRowGap, size.height + taskNodeGap);
      columnStep = Math.max(columnStep, size.width + taskNodeGap);
    });
    x += columnStep;
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

import { BaseEdge, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";

export type TaskDependencyEdgeData = Record<string, unknown> & {
  sourceLaneOffset: number;
  targetLaneOffset: number;
};

export type TaskDependencyFlowEdge = Edge<TaskDependencyEdgeData, "taskDependency">;

export function TaskDependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
  interactionWidth
}: EdgeProps<TaskDependencyFlowEdge>) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY: sourceY + laneOffset(data?.sourceLaneOffset),
    targetX,
    targetY: targetY + laneOffset(data?.targetLaneOffset),
    sourcePosition,
    targetPosition
  });

  return <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth ?? 28} />;
}

function laneOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

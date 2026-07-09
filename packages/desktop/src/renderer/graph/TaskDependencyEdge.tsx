import { BaseEdge, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";

export type TaskDependencyEdgeData = Record<string, unknown>;

export type TaskDependencyFlowEdge = Edge<TaskDependencyEdgeData, "taskDependency">;

export function TaskDependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  interactionWidth
}: EdgeProps<TaskDependencyFlowEdge>) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth ?? 32}
    />
  );
}

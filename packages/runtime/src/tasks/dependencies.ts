import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import type { CompiledExecutionGraph, PlanPackageManifest } from "../types.js";

export function dependencyIds(
  manifest: PlanPackageManifest,
  taskId: string,
  graph: CompiledExecutionGraph = compileTaskGraph(manifest)
): string[] {
  return graph.taskDependenciesByTask.get(taskId) ?? [];
}

export function hasDependencyPath(
  manifest: PlanPackageManifest,
  fromTaskId: string,
  toTaskId: string,
  graph: CompiledExecutionGraph = compileTaskGraph(manifest)
): boolean {
  return graph.taskReachable(fromTaskId, toTaskId);
}

export function tasksHaveDependencyRelationship(
  manifest: PlanPackageManifest,
  left: string,
  right: string,
  graph: CompiledExecutionGraph = compileTaskGraph(manifest)
): boolean {
  return (
    hasDependencyPath(manifest, left, right, graph) ||
    hasDependencyPath(manifest, right, left, graph)
  );
}

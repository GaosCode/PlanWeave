import { isAbsolute, relative } from "node:path";
import type {
  CompiledExecutionGraph,
  ExecutionGraphSession,
  PackageFileChange
} from "../../types.js";
import { requireMapValue } from "../requireMapValue.js";

export function promptPathToRefs(graph: CompiledExecutionGraph, path: string): string[] {
  const refs: string[] = [];
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = requireMapValue(graph.tasksById, taskId, "tasksById");
    if (task.prompt === path) {
      refs.push(...requireMapValue(graph.blocksByTask, taskId, "blocksByTask"));
    }
    for (const block of task.blocks) {
      if (block.prompt === path) {
        refs.push(`${taskId}#${block.id}`);
      }
    }
  }
  return refs;
}

export function dedupeFileChanges(changes: PackageFileChange[]): PackageFileChange[] {
  return [...new Map(changes.map((change) => [change.path, change])).values()];
}

export function normalizePackagePath(session: ExecutionGraphSession, path: string): string {
  return isAbsolute(path) ? relative(session.packageRoot, path) : path;
}

import { isAbsolute, relative } from "node:path";
import type { CompiledExecutionGraph, ExecutionGraphSession, PackageFileChange } from "../../types.js";

export function promptPathToRefs(graph: CompiledExecutionGraph, path: string): string[] {
  const refs: string[] = [];
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = graph.tasksById.get(taskId);
    if (!task) {
      continue;
    }
    if (task.prompt === path) {
      refs.push(...(graph.blocksByTask.get(taskId) ?? []));
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

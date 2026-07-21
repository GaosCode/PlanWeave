import { isAbsolute, relative } from "node:path";
import { toPackagePosixPath } from "../../package/packagePosixPath.js";
import type {
  CompiledExecutionGraph,
  ExecutionGraphSession,
  PackageFileChange
} from "../../types.js";
import { requireMapValue } from "../requireMapValue.js";

export function promptPathToRefs(graph: CompiledExecutionGraph, path: string): string[] {
  const normalizedPath = toPackagePosixPath(path);
  const refs: string[] = [];
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = requireMapValue(graph.tasksById, taskId, "tasksById");
    if (toPackagePosixPath(task.prompt) === normalizedPath) {
      refs.push(...requireMapValue(graph.blocksByTask, taskId, "blocksByTask"));
    }
    for (const block of task.blocks) {
      if (toPackagePosixPath(block.prompt) === normalizedPath) {
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
  const relativePath = isAbsolute(path) ? relative(session.packageRoot, path) : path;
  return toPackagePosixPath(relativePath);
}

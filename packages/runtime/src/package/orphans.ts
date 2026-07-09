import { join } from "node:path";
import { optionalReaddir } from "../fs/optionalFile.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import type {
  OrphanResultSummary,
  OrphanStateSummary,
  PlanPackageManifest,
  ProjectWorkspace,
  RuntimeState
} from "../types.js";

const canvasResultDirectoryNames = new Set(["auto-runs", "feedback-runs", "run-sessions"]);

export function manifestTaskIds(manifest: PlanPackageManifest): Set<string> {
  const graph = compileTaskGraph(manifest);
  return new Set(graph.taskNodesInManifestOrder);
}

export function manifestBlockRefs(manifest: PlanPackageManifest): Set<string> {
  const graph = compileTaskGraph(manifest);
  return new Set(graph.blockRefsInManifestOrder);
}

export function findOrphanState(
  manifest: PlanPackageManifest,
  state: RuntimeState
): OrphanStateSummary[] {
  const taskIds = manifestTaskIds(manifest);
  const blockRefs = manifestBlockRefs(manifest);
  return [
    ...Object.entries(state.tasks ?? {})
      .filter(([taskId]) => !taskIds.has(taskId))
      .map(([taskId, task]) => ({ taskId, status: task.status })),
    ...Object.entries(state.blocks ?? {})
      .filter(([ref]) => !blockRefs.has(ref))
      .map(([ref, block]) => ({ ref, status: block.status, lastRunId: block.lastRunId ?? null }))
  ];
}

export async function findOrphanResults(
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest
): Promise<OrphanResultSummary[]> {
  const taskIds = manifestTaskIds(manifest);
  const entries = await optionalReaddir(workspace.resultsDir, { withFileTypes: true });
  if (!entries) {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !canvasResultDirectoryNames.has(entry.name) &&
        !taskIds.has(entry.name)
    )
    .map((entry) => ({ taskId: entry.name, path: join(workspace.resultsDir, entry.name) }));
}

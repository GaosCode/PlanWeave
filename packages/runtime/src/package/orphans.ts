import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type {
  OrphanResultSummary,
  OrphanStateSummary,
  PlanPackageManifest,
  ProjectWorkspace,
  RuntimeState
} from "../types.js";

export function manifestTaskIds(manifest: PlanPackageManifest): Set<string> {
  return new Set(manifest.nodes.filter((node) => node.type === "task").map((node) => node.id));
}

export function findOrphanState(manifest: PlanPackageManifest, state: RuntimeState): OrphanStateSummary[] {
  const taskIds = manifestTaskIds(manifest);
  return Object.entries(state.tasks)
    .filter(([taskId]) => !taskIds.has(taskId))
    .map(([taskId, task]) => ({ taskId, status: task.status, lastRunId: task.lastRunId }));
}

export async function findOrphanResults(
  workspace: ProjectWorkspace,
  manifest: PlanPackageManifest
): Promise<OrphanResultSummary[]> {
  const taskIds = manifestTaskIds(manifest);
  try {
    await access(workspace.resultsDir, constants.R_OK);
  } catch {
    return [];
  }

  const entries = await readdir(workspace.resultsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !taskIds.has(entry.name))
    .map((entry) => ({ taskId: entry.name, path: join(workspace.resultsDir, entry.name) }));
}

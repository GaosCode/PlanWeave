import { loadPackage } from "../package/loadPackage.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { findOrphanResults, findOrphanState } from "../package/orphans.js";
import { ensureStateForManifest, readState, taskNodes, writeState } from "../state.js";
import { taskStatuses, type PlanStatus, type TaskReasonSummary } from "../types.js";

function summarizeNoClaimReason(status: Pick<PlanStatus, "taskTotal" | "counts" | "nextClaimable">): PlanStatus["noClaimReason"] {
  if (status.nextClaimable.length > 0) {
    return "has_claimable";
  }
  if (status.taskTotal === 0) {
    return "no_tasks";
  }
  if (status.counts.blocked > 0) {
    return "blocked";
  }
  if (status.counts.diverged > 0) {
    return "diverged";
  }
  if (status.counts.planned > 0) {
    return "dependency_blocked";
  }
  return "all_done";
}

export async function getStatus(options: { projectRoot: string }): Promise<PlanStatus> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const rawState = await readState(workspace.stateFile);
  const orphanState = findOrphanState(manifest, rawState);
  const orphanResults = await findOrphanResults(workspace, manifest);
  const state = ensureStateForManifest(manifest, rawState);
  await writeState(workspace.stateFile, state);
  const graph = compileTaskGraph(manifest);
  const counts = Object.fromEntries(taskStatuses.map((status) => [status, 0])) as PlanStatus["counts"];
  const inProgress: string[] = [];
  const blockedTasks: TaskReasonSummary[] = [];
  const needsChangesTasks: string[] = [];
  const divergedTasks: TaskReasonSummary[] = [];
  for (const task of taskNodes(manifest)) {
    const status = state.tasks[task.id]?.status ?? "planned";
    counts[status] += 1;
    if (status === "in_progress") {
      inProgress.push(task.id);
    } else if (status === "blocked") {
      blockedTasks.push({ taskId: task.id, reason: state.tasks[task.id]?.blockage?.reason ?? null });
    } else if (status === "needs_changes") {
      needsChangesTasks.push(task.id);
    } else if (status === "diverged") {
      divergedTasks.push({ taskId: task.id, reason: state.tasks[task.id]?.divergence?.reason ?? null });
    }
  }
  const buckets = graph.claimBuckets(state);
  const nextClaimable = [...buckets.needsChanges, ...buckets.ready].map((task) => task.id);
  const noClaimReason = summarizeNoClaimReason({ taskTotal: taskNodes(manifest).length, counts, nextClaimable });
  return {
    projectId: workspace.id,
    projectRoot: workspace.rootPath,
    taskTotal: taskNodes(manifest).length,
    counts,
    currentTaskId: state.currentTaskId,
    inProgress,
    nextClaimable,
    blockedTasks,
    needsChangesTasks,
    divergedTasks,
    orphanState,
    orphanResults,
    noClaimReason,
    needsChanges: counts.needs_changes,
    diverged: counts.diverged
  };
}

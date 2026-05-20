import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { ensureStateForManifest, readState, writeState } from "../state.js";
import { appendTaskEvent } from "../results/events.js";
import { readResultIndex, writeResultIndex } from "../results/indexFile.js";
import { orderedClaimableTasks } from "./claimNext.js";
import { canShareParallelBatch } from "./parallelSafety.js";
import type { ManifestTaskNode, ParallelClaimResult } from "../types.js";

export async function claimNextParallel(options: { projectRoot: string; force?: boolean }): Promise<ParallelClaimResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  const graph = compileTaskGraph(manifest);

  if (!manifest.execution.parallel.enabled) {
    await writeState(workspace.stateFile, state);
    return { taskIds: [], status: "disabled" };
  }

  const current = Object.entries(state.tasks)
    .filter(([, task]) => task.status === "in_progress")
    .map(([taskId]) => taskId);
  if (current.length > 0 && !options.force) {
    await writeState(workspace.stateFile, state);
    return { taskIds: current, status: "current" };
  }

  const selected: ManifestTaskNode[] = [];
  for (const candidate of orderedClaimableTasks(manifest, state, graph)) {
    if (selected.length >= manifest.execution.parallel.maxConcurrent) {
      break;
    }
    if (canShareParallelBatch(manifest, selected, candidate, graph)) {
      selected.push(candidate);
    }
  }

  for (const task of selected) {
    state.tasks[task.id] = {
      ...state.tasks[task.id],
      status: "in_progress",
      claimedBy: "agent",
      blockedBy: []
    };
  }
  state.currentTaskId = selected[0]?.id ?? state.currentTaskId;
  await writeState(workspace.stateFile, state);

  const claimedAt = new Date().toISOString();
  for (const task of selected) {
    const indexPath = join(workspace.resultsDir, task.id, "index.json");
    const previous = await readResultIndex(indexPath);
    await writeResultIndex(indexPath, {
      taskId: task.id,
      status: "in_progress",
      latestRunId: previous?.latestRunId ?? null,
      runCount: previous?.runCount ?? 0,
      ...(previous?.review ? { review: previous.review } : {}),
      ...(previous?.reviewHistory ? { reviewHistory: previous.reviewHistory } : {}),
      ...(previous?.divergence ? { divergence: previous.divergence } : {}),
      ...(previous?.verification ? { verification: previous.verification } : {}),
      ...(previous?.blockage ? { blockage: previous.blockage } : {}),
      events: appendTaskEvent(previous, { type: "claimed", taskId: task.id, at: claimedAt, source: "agent" })
    });
  }

  return {
    taskIds: selected.map((task) => task.id),
    status: selected.length > 0 ? "claimed" : "none"
  };
}

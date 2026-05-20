import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { ensureStateForManifest, readState, writeState } from "../state.js";
import { appendTaskEvent } from "../results/events.js";
import { readResultIndex, writeResultIndex } from "../results/indexFile.js";
import type { ClaimResult, CompiledTaskGraph, ManifestTaskNode, PlanPackageManifest, RuntimeState } from "../types.js";

function existingInProgress(state: RuntimeState): string | null {
  return Object.entries(state.tasks).find(([, task]) => task.status === "in_progress")?.[0] ?? null;
}

function claimableTasks(state: RuntimeState, graph: CompiledTaskGraph): ManifestTaskNode[] {
  const buckets = graph.claimBuckets(state);
  return [...buckets.needsChanges, ...buckets.ready];
}

function compareCandidatePriority(state: RuntimeState, left: ManifestTaskNode, right: ManifestTaskNode): number {
  const leftPriority = state.tasks[left.id]?.status === "needs_changes" ? 0 : 1;
  const rightPriority = state.tasks[right.id]?.status === "needs_changes" ? 0 : 1;
  return leftPriority - rightPriority;
}

export function orderedClaimableTasks(
  _manifest: PlanPackageManifest,
  state: RuntimeState,
  graph: CompiledTaskGraph = compileTaskGraph(_manifest)
): ManifestTaskNode[] {
  return claimableTasks(state, graph).sort((left, right) => compareCandidatePriority(state, left, right));
}

export async function claimNextTask(options: { projectRoot: string; force?: boolean }): Promise<ClaimResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  const graph = compileTaskGraph(manifest);
  const current = existingInProgress(state);
  if (current && !options.force) {
    await writeState(workspace.stateFile, state);
    return { taskId: current, status: "current", task: state.tasks[current] };
  }

  const next = orderedClaimableTasks(manifest, state, graph)[0];
  if (!next) {
    await writeState(workspace.stateFile, state);
    return { taskId: null, status: "none" };
  }

  state.tasks[next.id] = {
    ...state.tasks[next.id],
    status: "in_progress",
    claimedBy: "agent",
    blockedBy: []
  };
  state.currentTaskId = next.id;
  await writeState(workspace.stateFile, state);

  const indexPath = join(workspace.resultsDir, next.id, "index.json");
  const previous = await readResultIndex(indexPath);
  await writeResultIndex(indexPath, {
    taskId: next.id,
    status: "in_progress",
    latestRunId: previous?.latestRunId ?? null,
    runCount: previous?.runCount ?? 0,
    ...(previous?.review ? { review: previous.review } : {}),
    ...(previous?.reviewHistory ? { reviewHistory: previous.reviewHistory } : {}),
    ...(previous?.divergence ? { divergence: previous.divergence } : {}),
    ...(previous?.verification ? { verification: previous.verification } : {}),
    ...(previous?.blockage ? { blockage: previous.blockage } : {}),
    events: appendTaskEvent(previous, { type: "claimed", taskId: next.id, at: new Date().toISOString(), source: "agent" })
  });

  return { taskId: next.id, status: "claimed", task: state.tasks[next.id] };
}

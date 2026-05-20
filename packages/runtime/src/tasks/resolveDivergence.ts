import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { appendTaskEvent } from "../results/events.js";
import { readResultIndex, writeResultIndex } from "../results/indexFile.js";
import { ensureStateForManifest, readState, taskNodes, writeState } from "../state.js";
import { recoverTaskStatus } from "./recovery.js";
import type { ResolveDivergenceResult, ResultIndex } from "../types.js";

export async function resolveDivergence(options: {
  projectRoot: string;
  taskId: string;
  reason: string;
}): Promise<ResolveDivergenceResult> {
  const reason = options.reason.trim();
  if (!reason) {
    throw new Error("resolve-divergence requires a non-empty reason.");
  }
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  if (!taskNodes(manifest).some((task) => task.id === options.taskId)) {
    throw new Error(`Task '${options.taskId}' does not exist.`);
  }

  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  if (state.tasks[options.taskId]?.status !== "diverged") {
    throw new Error(`Task '${options.taskId}' is not diverged.`);
  }

  const indexPath = join(workspace.resultsDir, options.taskId, "index.json");
  const previous = await readResultIndex(indexPath);
  const recovered = recoverTaskStatus({ manifest, state, taskId: options.taskId, resultIndex: previous });
  state.tasks[options.taskId] = {
    ...state.tasks[options.taskId],
    status: recovered.status,
    claimedBy: null,
    blockedBy: recovered.blockedBy,
    divergence: undefined
  };
  await writeState(workspace.stateFile, state);

  const index: ResultIndex = {
    taskId: options.taskId,
    status: recovered.status,
    latestRunId: previous?.latestRunId ?? null,
    runCount: previous?.runCount ?? 0,
    ...(previous?.review ? { review: previous.review } : {}),
    ...(previous?.reviewHistory ? { reviewHistory: previous.reviewHistory } : {}),
    ...(previous?.verification ? { verification: previous.verification } : {}),
    ...(previous?.blockage ? { blockage: previous.blockage } : {}),
    events: appendTaskEvent(previous, {
      type: "divergence_resolved",
      taskId: options.taskId,
      reason,
      at: new Date().toISOString()
    })
  };
  await writeResultIndex(indexPath, index);

  return { taskId: options.taskId, status: recovered.status, reason };
}

import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { appendTaskEvent } from "../results/events.js";
import { readResultIndex, writeResultIndex } from "../results/indexFile.js";
import { ensureStateForManifest, readState, taskNodes, writeState } from "../state.js";
import type { MarkBlockedResult, ResultIndex } from "../types.js";

export async function markBlocked(options: {
  projectRoot: string;
  taskId: string;
  reason: string;
}): Promise<MarkBlockedResult> {
  if (!options.reason.trim()) {
    throw new Error("mark-blocked requires a non-empty reason.");
  }
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  if (!taskNodes(manifest).some((task) => task.id === options.taskId)) {
    throw new Error(`Task '${options.taskId}' does not exist.`);
  }

  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  if (state.tasks[options.taskId]?.status === "verified") {
    throw new Error("A verified task cannot be marked as blocked.");
  }
  const blockage = { reason: options.reason.trim(), recordedAt: new Date().toISOString() };
  state.tasks[options.taskId] = {
    ...state.tasks[options.taskId],
    status: "blocked",
    claimedBy: null,
    blockage
  };
  state.currentTaskId = state.currentTaskId === options.taskId ? null : state.currentTaskId;
  await writeState(workspace.stateFile, state);

  const indexPath = join(workspace.resultsDir, options.taskId, "index.json");
  const previous = await readResultIndex(indexPath);
  const index: ResultIndex = {
    taskId: options.taskId,
    status: "blocked",
    latestRunId: previous?.latestRunId ?? null,
    runCount: previous?.runCount ?? 0,
    ...(previous?.review ? { review: previous.review } : {}),
    ...(previous?.reviewHistory ? { reviewHistory: previous.reviewHistory } : {}),
    ...(previous?.divergence ? { divergence: previous.divergence } : {}),
    blockage,
    events: appendTaskEvent(previous, {
      type: "blocked",
      taskId: options.taskId,
      reason: blockage.reason,
      at: blockage.recordedAt
    })
  };
  await writeResultIndex(indexPath, index);

  return { taskId: options.taskId, status: "blocked", reason: blockage.reason };
}

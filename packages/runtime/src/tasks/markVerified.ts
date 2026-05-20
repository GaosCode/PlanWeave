import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { ensureStateForManifest, readState, taskNodes, writeState } from "../state.js";
import { appendTaskEvent } from "../results/events.js";
import { readResultIndex, writeResultIndex } from "../results/indexFile.js";
import type { MarkVerifiedResult, ResultIndex } from "../types.js";

export async function markVerified(options: { projectRoot: string; taskId: string }): Promise<MarkVerifiedResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  if (!taskNodes(manifest).some((task) => task.id === options.taskId)) {
    throw new Error(`Task '${options.taskId}' does not exist.`);
  }

  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  state.tasks[options.taskId] = {
    ...state.tasks[options.taskId],
    status: "verified",
    claimedBy: null
  };
  state.currentTaskId = state.currentTaskId === options.taskId ? null : state.currentTaskId;
  await writeState(workspace.stateFile, state);

  const indexPath = join(workspace.resultsDir, options.taskId, "index.json");
  const previous = await readResultIndex(indexPath);
  const verifiedAt = new Date().toISOString();
  const index: ResultIndex = {
    taskId: options.taskId,
    status: "verified",
    latestRunId: previous?.latestRunId ?? null,
    runCount: previous?.runCount ?? 0,
    ...(previous?.review ? { review: previous.review } : {}),
    ...(previous?.reviewHistory ? { reviewHistory: previous.reviewHistory } : {}),
    verification: { source: "manual", verifiedAt },
    events: appendTaskEvent(previous, { type: "verified", taskId: options.taskId, source: "manual", at: verifiedAt })
  };
  await writeResultIndex(indexPath, index);

  return { taskId: options.taskId, status: "verified" };
}

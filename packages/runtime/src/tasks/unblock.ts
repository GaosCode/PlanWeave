import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { appendTaskEvent } from "../results/events.js";
import { readResultIndex, writeResultIndex } from "../results/indexFile.js";
import { ensureStateForManifest, readState, taskNodes, writeState } from "../state.js";
import { recoverTaskStatus } from "./recovery.js";
import type { ResultIndex, UnblockResult } from "../types.js";

export async function unblockTask(options: { projectRoot: string; taskId: string }): Promise<UnblockResult> {
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  if (!taskNodes(manifest).some((task) => task.id === options.taskId)) {
    throw new Error(`Task '${options.taskId}' does not exist.`);
  }

  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  const current = state.tasks[options.taskId];
  if (current?.status !== "blocked") {
    throw new Error(`Task '${options.taskId}' is not blocked.`);
  }

  const indexPath = join(workspace.resultsDir, options.taskId, "index.json");
  const previous = await readResultIndex(indexPath);
  const recovered = recoverTaskStatus({ manifest, state, taskId: options.taskId, resultIndex: previous });
  state.tasks[options.taskId] = {
    ...current,
    status: recovered.status,
    blockedBy: recovered.blockedBy,
    blockage: undefined
  };
  await writeState(workspace.stateFile, state);

  const index: ResultIndex = {
    taskId: options.taskId,
    status: recovered.status,
    latestRunId: previous?.latestRunId ?? null,
    runCount: previous?.runCount ?? 0,
    ...(previous?.review ? { review: previous.review } : {}),
    ...(previous?.reviewHistory ? { reviewHistory: previous.reviewHistory } : {}),
    ...(previous?.divergence ? { divergence: previous.divergence } : {}),
    ...(previous?.verification ? { verification: previous.verification } : {}),
    events: appendTaskEvent(previous, { type: "unblocked", taskId: options.taskId, at: new Date().toISOString() })
  };
  await writeResultIndex(indexPath, index);

  return { taskId: options.taskId, status: recovered.status };
}

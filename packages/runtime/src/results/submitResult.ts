import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { ensureStateForManifest, readState, taskNodes, writeState } from "../state.js";
import { writeJsonFile } from "../json.js";
import { appendTaskEvent } from "./events.js";
import { readResultIndex, writeResultIndex } from "./indexFile.js";
import { nextRunId } from "./runId.js";
import { runSubmitStatuses, type ResultIndex, type RunSubmitStatus, type SubmitResult } from "../types.js";

function assertTaskExists(taskIds: string[], taskId: string): void {
  if (!taskIds.includes(taskId)) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
}

function assertRunSubmitStatus(status: string): asserts status is RunSubmitStatus {
  if (!(runSubmitStatuses as readonly string[]).includes(status)) {
    throw new Error(`Unsupported submit-result status '${status}'. Expected one of: ${runSubmitStatuses.join(", ")}.`);
  }
}

export async function submitRunResult(options: {
  projectRoot: string;
  taskId: string;
  reportPath: string;
  status?: RunSubmitStatus;
  reason?: string;
}): Promise<SubmitResult> {
  const status = options.status ?? "implemented";
  assertRunSubmitStatus(status);
  if ((status === "blocked" || status === "diverged") && !options.reason?.trim()) {
    throw new Error(`submit-result --status ${status} requires --reason.`);
  }
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  assertTaskExists(
    taskNodes(manifest).map((task) => task.id),
    options.taskId
  );
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  await writeState(workspace.stateFile, state);
  if (state.tasks[options.taskId]?.status !== "in_progress") {
    throw new Error(`Task '${options.taskId}' must be in_progress before submit-result.`);
  }

  const taskResultDir = join(workspace.resultsDir, options.taskId);
  const previous = await readResultIndex(join(taskResultDir, "index.json"));
  const runId = nextRunId(previous?.runCount ?? 0);
  const submittedAt = new Date().toISOString();
  const runDir = join(taskResultDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await copyFile(options.reportPath, join(runDir, "implementation.md"));
  await writeJsonFile(join(runDir, "metadata.json"), {
    taskId: options.taskId,
    runId,
    status,
    submittedAt,
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    sourceReportPath: options.reportPath
  });

  const divergence = status === "diverged" ? { reason: options.reason?.trim() ?? "", recordedAt: submittedAt } : previous?.divergence;
  const blockage = status === "blocked" ? { reason: options.reason?.trim() ?? "", recordedAt: submittedAt } : undefined;
  const index: ResultIndex = {
    taskId: options.taskId,
    status,
    latestRunId: runId,
    runCount: (previous?.runCount ?? 0) + 1,
    ...(previous?.review ? { review: previous.review } : {}),
    ...(previous?.reviewHistory ? { reviewHistory: previous.reviewHistory } : {}),
    ...(divergence ? { divergence } : {}),
    ...(blockage ? { blockage } : {}),
    events: appendTaskEvent(previous, { type: "run_submitted", taskId: options.taskId, runId, status, at: submittedAt })
  };
  await writeResultIndex(join(taskResultDir, "index.json"), index);

  state.tasks[options.taskId] = {
    ...state.tasks[options.taskId],
    status,
    lastRunId: runId,
    claimedBy: null,
    ...(divergence ? { divergence } : { divergence: undefined }),
    ...(blockage ? { blockage } : { blockage: undefined })
  };
  state.currentTaskId = state.currentTaskId === options.taskId ? null : state.currentTaskId;
  await writeState(workspace.stateFile, state);

  return { taskId: options.taskId, runId, status, index };
}

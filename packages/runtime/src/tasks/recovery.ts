import { createDefaultTaskState } from "../state.js";
import type { PlanPackageManifest, ResultIndex, RuntimeState, TaskStatus } from "../types.js";

export function recoverTaskStatus(options: {
  manifest: PlanPackageManifest;
  state: RuntimeState;
  taskId: string;
  resultIndex: ResultIndex | null;
}): { status: Extract<TaskStatus, "planned" | "ready" | "needs_changes">; blockedBy: string[] } {
  const defaultState = createDefaultTaskState(options.manifest, options.state, options.taskId);
  if (defaultState.status === "planned") {
    return { status: "planned", blockedBy: defaultState.blockedBy };
  }

  const latestReviewStatus = options.resultIndex?.review?.status ?? options.resultIndex?.reviewHistory?.at(-1)?.status;
  if (latestReviewStatus === "needs_changes") {
    return { status: "needs_changes", blockedBy: defaultState.blockedBy };
  }

  return { status: "ready", blockedBy: defaultState.blockedBy };
}

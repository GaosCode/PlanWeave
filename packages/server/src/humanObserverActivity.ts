import type { ActivityRecord } from "./comments/schemas.js";
import type { HumanObserverJournalEventInput } from "./humanObserverJournal.js";

export function observerEventForDispatchProgress(input: {
  dispatchId: string;
  canvasId: string;
  blockRef: string;
}): HumanObserverJournalEventInput {
  return {
    kind: "remote_run",
    remoteRunStatus: "progress",
    dispatchId: input.dispatchId,
    workItem: {
      kind: "block",
      canvasId: input.canvasId,
      blockRef: input.blockRef
    }
  };
}

export function observerEventsForActivity(
  record: ActivityRecord
): HumanObserverJournalEventInput[] {
  const common = {
    ...(record.workItem ? { workItem: record.workItem } : {}),
    ...(record.summary.commentId ? { commentId: record.summary.commentId } : {}),
    activityId: record.activityId,
    ...(record.summary.humanPrincipalId
      ? { humanPrincipalId: record.summary.humanPrincipalId }
      : {}),
    ...(record.summary.dispatchId ? { dispatchId: record.summary.dispatchId } : {})
  };
  const domain: HumanObserverJournalEventInput =
    record.source.kind === "remote_run"
      ? {
          ...common,
          kind: "remote_run",
          remoteRunStatus:
            record.type === "remote_run_started"
              ? "started"
              : record.type === "remote_run_succeeded"
                ? "succeeded"
                : record.type === "remote_run_interrupted"
                  ? "interrupted"
                  : "failed"
        }
      : { ...common, kind: record.source.kind };
  return [domain, { ...common, kind: "activity" }];
}

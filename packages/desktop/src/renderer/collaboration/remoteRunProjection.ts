import type { ActivityRecord } from "@planweave-ai/collaboration-protocol/activity/comments";
import type { HumanObserverEvent } from "@planweave-ai/collaboration-protocol/activity/observer";
import type {
  CollaborationRemoteRunProjection,
  CollaborationRemoteRunStatus
} from "../../shared/collaborationReadModels.js";
import { selectRemoteRunProjection } from "./remoteProjectionMerge.js";

function remoteStatusFromActivityType(type: string): CollaborationRemoteRunStatus | null {
  switch (type) {
    case "remote_run_started":
      return "started";
    case "remote_run_succeeded":
      return "succeeded";
    case "remote_run_failed":
      return "failed";
    case "remote_run_interrupted":
      return "interrupted";
    default:
      return null;
  }
}

export function applyObserverRemoteRun(input: {
  remoteRuns: Map<string, CollaborationRemoteRunProjection>;
  projectId: string | null;
  event: HumanObserverEvent;
}): boolean {
  const { event } = input;
  if (!event.dispatchId || !event.remoteRunStatus) return false;
  const existing = input.remoteRuns.get(event.dispatchId);
  const projectId = input.projectId ?? existing?.projectId;
  if (!projectId) return false;
  const incoming: CollaborationRemoteRunProjection = {
    dispatchId: event.dispatchId,
    projectId,
    workItem: event.workItem ?? existing?.workItem,
    hostId: existing?.hostId,
    status: event.remoteRunStatus,
    lastActivityId: existing?.lastActivityId,
    observerCursor: event.cursor,
    updatedAt: event.occurredAt
  };
  input.remoteRuns.set(
    event.dispatchId,
    selectRemoteRunProjection({ current: existing ?? null, incoming })
  );
  return true;
}

export function ingestActivityRemoteRun(
  remoteRuns: Map<string, CollaborationRemoteRunProjection>,
  record: ActivityRecord
): void {
  const status = remoteStatusFromActivityType(record.type);
  if (!status) return;
  const dispatchId = record.summary.dispatchId ?? record.source.sourceId;
  if (!dispatchId) return;
  const incoming: CollaborationRemoteRunProjection = {
    dispatchId,
    projectId: record.projectId,
    workItem: record.workItem ?? record.summary.workItem,
    hostId: record.summary.hostId,
    status,
    lastActivityId: record.activityId,
    updatedAt: record.occurredAt
  };
  const existing = remoteRuns.get(dispatchId);
  remoteRuns.set(dispatchId, selectRemoteRunProjection({ current: existing ?? null, incoming }));
}

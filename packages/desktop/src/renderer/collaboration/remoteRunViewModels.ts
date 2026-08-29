import {
  remoteHumanExecutionActionCommandSchema,
  type RemoteAttemptStatus,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionView,
  type RemoteOperationObservation,
  type RemoteOperationState
} from "@planweave-ai/collaboration-protocol/remote-run";
import { type AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type {
  ProjectedRemoteAcpEvent,
  RemoteAcpReplayDiagnostic,
  RemoteBlockExecutionReadModel
} from "@planweave-ai/runtime";

import type { CollaborationRemoteRunProjection } from "../../shared/collaborationReadModels.js";

/**
 * Local Auto Run and remote Server dispatch are separate authorities.
 * This view model never merges their status machines into one enum.
 */
export type RunAuthorityKind = "local_auto_run" | "remote_dispatch";

export type RemoteRunLifecyclePhase =
  | "idle"
  | "dispatchable"
  | "preparing"
  | "running"
  | "action_required"
  | "interrupted"
  | "terminal_success"
  | "terminal_failure"
  | "terminal_cancelled"
  | "stale"
  | "unavailable";

export type RemoteRunAuthorizedActionKind =
  | "dispatch"
  | "answer_interaction"
  | "cancel"
  | "resume_same_session"
  | "fail_interruption"
  | "retry_new_attempt";

export type RemoteRunActionAvailability =
  | { kind: RemoteRunAuthorizedActionKind; available: true; requiresConfirm: boolean }
  | {
      kind: RemoteRunAuthorizedActionKind;
      available: false;
      reason:
        | "not_authorized"
        | "wrong_lifecycle"
        | "missing_identity"
        | "missing_lease"
        | "not_resumable"
        | "no_pending_interaction"
        | "offline"
        | "local_run_active"
        | "assignment_ineligible";
    };

export type RemoteRunIdentitySummary = {
  operationId: string;
  dispatchId: string;
  executionAttemptId: string;
  attemptVersion: number;
  hostId: string | null;
  agentEndpoint: { displayName: string; hostDisplayName: string } | null;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  acpSessionId: string | null;
  /** Authoritative interruption recovery id from Server observation (never UI-minted). */
  recoveryId: string | null;
  blockRef: string;
  canvasId: string;
  projectId: string;
};

/** True when the selected Block has an unfinished local run record (local Auto Run active). */
export function isLocalAutoRunActiveFromBlockRecords(
  records: readonly { finishedAt: string | null | undefined }[]
): boolean {
  return records.some((record) => record.finishedAt == null);
}

export type RemoteRunPanelViewModel = {
  authority: RunAuthorityKind;
  phase: RemoteRunLifecyclePhase;
  /** Server operation lifecycle — not local Auto Run status. */
  operationState: RemoteOperationState | null;
  attemptStatus: RemoteAttemptStatus | null;
  identity: RemoteRunIdentitySummary | null;
  /** Runtime projection (local package authority). */
  runtime: RemoteBlockExecutionReadModel | null;
  runtimeBindingSummary: string | null;
  assignment: AssignmentDisplayProjection | null;
  assignmentEligibleForDispatch: boolean;
  hostOnline: boolean | null;
  observerStatus: CollaborationRemoteRunProjection["status"] | null;
  pendingInteractions: RemoteInteractionView[];
  eventProtocolVersion: 1 | 2 | null;
  events: ProjectedRemoteAcpEvent[];
  replayDiagnostics: RemoteAcpReplayDiagnostic[];
  eventCursor: number;
  eventsHasMore: boolean;
  actions: RemoteRunActionAvailability[];
  actionRequired: boolean;
  interruptionResumable: boolean;
  localAutoRunCoexisting: boolean;
  diagnostics: string[];
};

export type RemoteRunActionStateRow = {
  operationState: RemoteOperationState | "none";
  attemptStatus: RemoteAttemptStatus | "none";
  dispatch: boolean;
  answer: boolean;
  cancel: boolean;
  resume: boolean;
  fail: boolean;
  retry: boolean;
};

/** Explicit action/state table used by UI + tests (do not infer from free text). */
export const REMOTE_RUN_ACTION_STATE_TABLE: readonly RemoteRunActionStateRow[] = [
  {
    operationState: "none",
    attemptStatus: "none",
    dispatch: true,
    answer: false,
    cancel: false,
    resume: false,
    fail: false,
    retry: false
  },
  {
    operationState: "preparing",
    attemptStatus: "prepared",
    dispatch: false,
    answer: false,
    cancel: true,
    resume: false,
    fail: false,
    retry: false
  },
  {
    operationState: "running",
    attemptStatus: "running",
    dispatch: false,
    answer: true,
    cancel: true,
    resume: false,
    fail: false,
    retry: false
  },
  {
    operationState: "action_required",
    attemptStatus: "action_required",
    dispatch: false,
    answer: true,
    cancel: true,
    resume: false,
    fail: true,
    retry: false
  },
  {
    operationState: "interrupted",
    attemptStatus: "interrupted",
    dispatch: false,
    answer: false,
    cancel: false,
    resume: true,
    fail: true,
    retry: true
  },
  {
    operationState: "completed",
    attemptStatus: "completed",
    dispatch: true,
    answer: false,
    cancel: false,
    resume: false,
    fail: false,
    retry: true
  },
  {
    operationState: "failed",
    attemptStatus: "failed",
    dispatch: true,
    answer: false,
    cancel: false,
    resume: false,
    fail: false,
    retry: true
  },
  {
    operationState: "cancelled",
    attemptStatus: "cancelled",
    dispatch: true,
    answer: false,
    cancel: false,
    resume: false,
    fail: false,
    retry: true
  }
] as const;

function tableRowFor(
  state: RemoteOperationState | null,
  attempt: RemoteAttemptStatus | null
): RemoteRunActionStateRow | null {
  if (!state || !attempt) {
    return (
      REMOTE_RUN_ACTION_STATE_TABLE.find(
        (row) => row.operationState === "none" && row.attemptStatus === "none"
      ) ?? null
    );
  }
  return (
    REMOTE_RUN_ACTION_STATE_TABLE.find(
      (row) => row.operationState === state && row.attemptStatus === attempt
    ) ?? null
  );
}

export function projectRemoteLifecyclePhase(input: {
  observation: RemoteOperationObservation | null;
  runtime: RemoteBlockExecutionReadModel | null;
  canDispatch: boolean;
}): RemoteRunLifecyclePhase {
  const { observation, runtime, canDispatch } = input;
  if (!observation) {
    if (runtime?.status === "interrupted" || runtime?.actionRequired) return "action_required";
    if (runtime?.phase === "preparing") return "preparing";
    if (runtime?.phase === "active") return "running";
    if (runtime?.phase === "terminal" && runtime.status === "completed") return "terminal_success";
    if (runtime?.phase === "terminal" && runtime.status === "failed") return "terminal_failure";
    if (runtime?.status === "source_drift") return "stale";
    return canDispatch ? "dispatchable" : "idle";
  }
  switch (observation.state) {
    case "preparing":
    case "claimed":
    case "reserved":
    case "activated":
      return "preparing";
    case "running":
    case "awaiting_writeback":
      return "running";
    case "action_required":
      return "action_required";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "terminal_success";
    case "failed":
      return "terminal_failure";
    case "cancelled":
      return "terminal_cancelled";
    default:
      return "unavailable";
  }
}

export function projectRemoteRunIdentity(
  observation: RemoteOperationObservation
): RemoteRunIdentitySummary {
  const recovery = observation.runtime.interruption?.recovery;
  return {
    operationId: observation.operationId,
    dispatchId: observation.dispatchId,
    executionAttemptId: observation.executionAttemptId,
    attemptVersion: observation.attempt.stateVersion,
    hostId: observation.attempt.hostId ?? null,
    agentEndpoint: observation.agentEndpoint
      ? {
          displayName: observation.agentEndpoint.displayName,
          hostDisplayName: observation.agentEndpoint.hostDisplayName
        }
      : null,
    leaseId: observation.attempt.leaseId ?? null,
    leaseExpiresAt: observation.attempt.leaseExpiresAt ?? null,
    acpSessionId: recovery?.acpSessionId ?? null,
    recoveryId: recovery?.recoveryId ?? null,
    blockRef: observation.blockRef,
    canvasId: observation.canvasId,
    projectId: observation.projectId
  };
}

/**
 * Adapt Server normalized ACP events into the same cursor/kind surface as local projection.
 * Does not parse free-text logs.
 */
export function adaptRemoteAcpEvents(
  events: readonly ProjectedRemoteAcpEvent[],
  options?: { afterCursor?: number }
): ProjectedRemoteAcpEvent[] {
  const after = options?.afterCursor ?? 0;
  const byCursor = new Map<number, ProjectedRemoteAcpEvent>();
  for (const event of events) {
    if (event.cursor <= after) continue;
    const existing = byCursor.get(event.cursor);
    // Last write wins for duplicate cursor; out-of-order is sorted below.
    if (!existing) {
      byCursor.set(event.cursor, event);
    } else {
      byCursor.set(event.cursor, event);
    }
  }
  return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
}

export function projectRemoteRunActions(input: {
  observation: RemoteOperationObservation | null;
  pendingInteractions: readonly RemoteInteractionView[];
  authorized: boolean;
  offline: boolean;
  localAutoRunActive: boolean;
  assignmentEligible: boolean;
  interruptionResumable: boolean;
}): RemoteRunActionAvailability[] {
  const kinds: RemoteRunAuthorizedActionKind[] = [
    "dispatch",
    "answer_interaction",
    "cancel",
    "resume_same_session",
    "fail_interruption",
    "retry_new_attempt"
  ];

  if (input.offline) {
    return kinds.map((kind) => ({
      kind,
      available: false as const,
      reason: "offline" as const
    }));
  }
  if (!input.authorized) {
    return kinds.map((kind) => ({
      kind,
      available: false as const,
      reason: "not_authorized" as const
    }));
  }

  const row = tableRowFor(
    input.observation?.state ?? null,
    input.observation?.attempt.status ?? null
  );
  const leasePresent = Boolean(input.observation?.attempt.leaseId);
  const hasPending = input.pendingInteractions.some((item) => item.status === "pending");

  return kinds.map((kind) => {
    if (kind === "dispatch") {
      if (input.localAutoRunActive) {
        return { kind, available: false as const, reason: "local_run_active" as const };
      }
      if (!input.assignmentEligible) {
        return { kind, available: false as const, reason: "assignment_ineligible" as const };
      }
      if (row?.dispatch) {
        return { kind, available: true as const, requiresConfirm: false };
      }
      return { kind, available: false as const, reason: "wrong_lifecycle" as const };
    }

    if (!input.observation) {
      return { kind, available: false as const, reason: "missing_identity" as const };
    }

    if (kind === "answer_interaction") {
      if (!row?.answer || !hasPending) {
        return {
          kind,
          available: false as const,
          reason: hasPending ? "wrong_lifecycle" : "no_pending_interaction"
        };
      }
      return { kind, available: true as const, requiresConfirm: false };
    }

    if (kind === "cancel") {
      if (!row?.cancel) {
        return { kind, available: false as const, reason: "wrong_lifecycle" as const };
      }
      if (!leasePresent) {
        return { kind, available: false as const, reason: "missing_lease" as const };
      }
      return { kind, available: true as const, requiresConfirm: true };
    }

    if (kind === "resume_same_session") {
      if (!row?.resume) {
        return { kind, available: false as const, reason: "wrong_lifecycle" as const };
      }
      if (!input.interruptionResumable) {
        return { kind, available: false as const, reason: "not_resumable" as const };
      }
      if (!leasePresent) {
        return { kind, available: false as const, reason: "missing_lease" as const };
      }
      return { kind, available: true as const, requiresConfirm: false };
    }

    if (kind === "fail_interruption") {
      if (!row?.fail) {
        return { kind, available: false as const, reason: "wrong_lifecycle" as const };
      }
      if (!leasePresent) {
        return { kind, available: false as const, reason: "missing_lease" as const };
      }
      return { kind, available: true as const, requiresConfirm: true };
    }

    // retry_new_attempt
    if (!row?.retry) {
      return { kind, available: false as const, reason: "wrong_lifecycle" as const };
    }
    if (!leasePresent && input.observation.state === "interrupted") {
      return { kind, available: false as const, reason: "missing_lease" as const };
    }
    return { kind, available: true as const, requiresConfirm: true };
  });
}

export function projectRemoteRunPanelViewModel(input: {
  observation: RemoteOperationObservation | null;
  runtime: RemoteBlockExecutionReadModel | null;
  assignment: AssignmentDisplayProjection | null;
  observerRun: CollaborationRemoteRunProjection | null;
  pendingInteractions: readonly RemoteInteractionView[];
  eventProtocolVersion: 1 | 2 | null;
  events: readonly ProjectedRemoteAcpEvent[];
  replayDiagnostics: readonly RemoteAcpReplayDiagnostic[];
  eventCursor: number;
  eventsHasMore: boolean;
  authorized: boolean;
  offline: boolean;
  localAutoRunActive: boolean;
  hostOnline?: boolean | null;
  endpointDispatchAvailable: boolean;
}): RemoteRunPanelViewModel {
  const assignmentEligible = input.endpointDispatchAvailable;
  const interruptionResumable = Boolean(
    input.observation?.runtime.interruption?.resumable ||
      (input.observation?.state === "interrupted" &&
        input.observation.runtime.interruption?.recovery)
  );
  const phase = projectRemoteLifecyclePhase({
    observation: input.observation,
    runtime: input.runtime,
    canDispatch: assignmentEligible && !input.localAutoRunActive && !input.offline
  });
  const actions = projectRemoteRunActions({
    observation: input.observation,
    pendingInteractions: input.pendingInteractions,
    authorized: input.authorized,
    offline: input.offline,
    localAutoRunActive: input.localAutoRunActive,
    assignmentEligible,
    interruptionResumable
  });
  const adaptedEvents = adaptRemoteAcpEvents(input.events);
  const diagnostics: string[] = [];
  if (input.localAutoRunActive) {
    diagnostics.push("local_auto_run_coexisting");
  }
  if (input.runtime?.status === "source_drift") {
    diagnostics.push("runtime_source_drift");
  }
  if (input.observation && input.runtime?.identity.operationId) {
    if (input.observation.operationId !== input.runtime.identity.operationId) {
      diagnostics.push("operation_runtime_identity_mismatch");
    }
  }
  diagnostics.push(...input.replayDiagnostics.map((diagnostic) => diagnostic.code));

  return {
    authority: "remote_dispatch",
    phase,
    operationState: input.observation?.state ?? null,
    attemptStatus: input.observation?.attempt.status ?? null,
    identity: input.observation ? projectRemoteRunIdentity(input.observation) : null,
    runtime: input.runtime,
    runtimeBindingSummary: input.observation
      ? `${input.observation.runtime.status}${
          input.observation.runtime.blockedReason
            ? `:${input.observation.runtime.blockedReason}`
            : ""
        }`
      : input.runtime
        ? `${input.runtime.phase}/${input.runtime.status}`
        : null,
    assignment: input.assignment,
    assignmentEligibleForDispatch: assignmentEligible,
    hostOnline: input.hostOnline ?? input.assignment?.host?.online ?? null,
    observerStatus: input.observerRun?.status ?? null,
    pendingInteractions: [...input.pendingInteractions],
    eventProtocolVersion: input.eventProtocolVersion,
    events: adaptedEvents,
    replayDiagnostics: [...input.replayDiagnostics],
    eventCursor: input.eventCursor,
    eventsHasMore: input.eventsHasMore,
    actions,
    actionRequired:
      phase === "action_required" ||
      phase === "interrupted" ||
      Boolean(input.runtime?.actionRequired),
    interruptionResumable,
    localAutoRunCoexisting: input.localAutoRunActive,
    diagnostics
  };
}

export function buildRemoteActionIdentity(input: {
  observation: RemoteOperationObservation;
  kind: RemoteHumanExecutionActionCommand["kind"];
  actionId: string;
  reason: string;
  newDispatchId?: string;
  newExecutionAttemptId?: string;
  failure?: { code: string; message: string; retryable: boolean };
}): RemoteHumanExecutionActionCommand {
  const base = {
    actionId: input.actionId,
    operationId: input.observation.operationId,
    dispatchId: input.observation.dispatchId,
    executionAttemptId: input.observation.executionAttemptId,
    expectedAttemptVersion: input.observation.attempt.stateVersion,
    reason: input.reason
  };
  const priorLease =
    input.observation.attempt.leaseId ??
    (() => {
      throw new Error("remote_action_missing_lease");
    })();

  switch (input.kind) {
    case "cancel":
      return remoteHumanExecutionActionCommandSchema.parse({
        ...base,
        kind: "cancel",
        leaseId: priorLease
      });
    case "fail":
      return remoteHumanExecutionActionCommandSchema.parse({
        ...base,
        kind: "fail",
        leaseId: priorLease,
        failure: input.failure ?? {
          code: "remote_execution_failed",
          message: "Operator marked the remote attempt failed.",
          retryable: false
        }
      });
    case "block":
      return remoteHumanExecutionActionCommandSchema.parse({
        ...base,
        kind: "block",
        leaseId: priorLease
      });
    case "resume_same_session": {
      return remoteHumanExecutionActionCommandSchema.parse({
        ...base,
        kind: "resume_same_session",
        priorLeaseId: priorLease
      });
    }
    case "retry_new_attempt": {
      if (!input.newDispatchId || !input.newExecutionAttemptId) {
        throw new Error("remote_retry_requires_new_identities");
      }
      return remoteHumanExecutionActionCommandSchema.parse({
        ...base,
        kind: "retry_new_attempt",
        priorLeaseId: priorLease,
        newDispatchId: input.newDispatchId,
        newExecutionAttemptId: input.newExecutionAttemptId
      });
    }
  }
}

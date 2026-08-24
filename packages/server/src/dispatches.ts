import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import { z } from "zod";
import type { HostReadinessObservation } from "@planweave-ai/agent-host-protocol";
import { AgentHostRepository } from "./hosts.js";
import { HostEventInbox } from "./hostEvents.js";
import {
  acpRecoveryIdentitySchema,
  capabilitiesSchema,
  dispatchFailureSchema,
  dispatchIdSchema,
  dispatchResultSchema,
  executionAttemptIdSchema,
  interruptionReasonSchema,
  leaseIdSchema,
  type HostEvent,
  type ProtocolDispatchFailure,
  type ProtocolDispatchResult
} from "./protocol.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import { remoteExecutionActionRequestSchema } from "./remoteExecutionLifecycle.js";

export const dispatchStatusSchema = z.enum([
  "leased",
  "running",
  "interrupted",
  "cancelling",
  "awaiting_writeback",
  "completed",
  "failed",
  "cancelled"
]);

export type DispatchStatus = z.infer<typeof dispatchStatusSchema>;

export type DispatchResult = ProtocolDispatchResult;
export type DispatchFailure = ProtocolDispatchFailure;
export type DispatchInterruption = Pick<
  Extract<HostEvent, { type: "dispatch.interrupted" }>,
  "reason" | "resumable" | "recovery"
>;

export type DispatchRecord = {
  id: string;
  workspaceId: string;
  projectId: string;
  blockRef: string;
  hostId: string;
  requiredCapabilities: string[];
  status: DispatchStatus;
  leaseId: string;
  executionAttemptId: string;
  leaseExpiresAt: string;
  createdAt: string;
  acceptedAt?: string;
  finishedAt?: string;
  result?: DispatchResult;
  failure?: DispatchFailure;
  interruption?: DispatchInterruption;
};

type RecordedTerminalDispatch = {
  dispatch: DispatchRecord | undefined;
  writebackRequired: boolean;
};

export type DispatchWriteback = {
  complete(input: {
    dispatchId: string;
    hostId: string;
    leaseId: string;
    executionAttemptId: string;
    projectId: string;
    blockRef: string;
    result: DispatchResult;
  }): Promise<void>;
  fail(input: {
    dispatchId: string;
    hostId: string;
    leaseId: string;
    executionAttemptId: string;
    projectId: string;
    blockRef: string;
    failure: DispatchFailure;
  }): Promise<void>;
};

export type DispatchServiceOptions = {
  leaseDurationMs: number;
  hostOfflineAfterMs: number;
  writeback: DispatchWriteback;
  onActivityTransitionInTransaction?: (input: {
    type:
      | "remote_run_started"
      | "remote_run_succeeded"
      | "remote_run_failed"
      | "remote_run_interrupted";
    dispatch: DispatchRecord;
    occurredAt: string;
  }) => void;
};

type DispatchRow = Record<string, unknown> & {
  id: string;
  workspace_id: string;
  project_id: string;
  block_ref: string;
  host_id: string;
  required_capabilities_json: string;
  status: DispatchStatus;
  lease_id: string;
  execution_attempt_id: string;
  lease_expires_at: string;
  created_at: string;
  accepted_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  failure_json: string | null;
  interruption_reason: DispatchInterruption["reason"] | null;
  interruption_resumable: number | null;
  interruption_recovery_json: string | null;
};

function toDispatch(row: DispatchRow): DispatchRecord {
  return {
    id: dispatchIdSchema.parse(row.id),
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    blockRef: row.block_ref,
    hostId: row.host_id,
    requiredCapabilities: capabilitiesSchema.parse(JSON.parse(row.required_capabilities_json)),
    status: row.status,
    leaseId: leaseIdSchema.parse(row.lease_id),
    executionAttemptId: executionAttemptIdSchema.parse(row.execution_attempt_id),
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    result: row.result_json ? dispatchResultSchema.parse(JSON.parse(row.result_json)) : undefined,
    failure: row.failure_json
      ? dispatchFailureSchema.parse(JSON.parse(row.failure_json))
      : undefined,
    interruption: row.interruption_reason
      ? {
          reason: interruptionReasonSchema.parse(row.interruption_reason),
          resumable: row.interruption_resumable === 1,
          recovery: row.interruption_recovery_json
            ? acpRecoveryIdentitySchema.parse(JSON.parse(row.interruption_recovery_json))
            : undefined
        }
      : undefined
  };
}

/** Soft-drop reasons keep the Host WS healthy; they are expected races after reconnect / expiry. */
export type DispatchEventDropReason =
  | "dispatch_not_found"
  | "lease_mismatch"
  | "lease_expired"
  | "dispatch_not_awaiting_acceptance"
  | "dispatch_not_running";

type LeaseResolution =
  | { ok: true; dispatch: DispatchRecord }
  | { ok: false; reason: "dispatch_not_found" | "lease_mismatch" | "lease_expired" };

function logDispatchEventDropped(input: {
  hostId: string;
  messageId: string;
  eventType: string;
  reason: DispatchEventDropReason;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
}): void {
  console.warn(
    JSON.stringify({
      scope: "agent-host-ws",
      event: "dispatch_event_dropped",
      reason: input.reason,
      eventType: input.eventType,
      hostId: input.hostId,
      messageId: input.messageId,
      dispatchId: input.dispatchId,
      leaseId: input.leaseId,
      executionAttemptId: input.executionAttemptId
    })
  );
}

export class DispatchService {
  private readonly inbox: HostEventInbox;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly hosts: AgentHostRepository,
    private readonly artifactAuthorization: ArtifactAuthorizationRepository,
    private readonly options: DispatchServiceOptions
  ) {
    if (!Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs < 1000) {
      throw new Error("leaseDurationMs must be an integer of at least 1000.");
    }
    if (!Number.isInteger(options.hostOfflineAfterMs) || options.hostOfflineAfterMs < 1000) {
      throw new Error("hostOfflineAfterMs must be an integer of at least 1000.");
    }
    this.inbox = new HostEventInbox(database);
  }

  get(dispatchId: string): DispatchRecord | undefined {
    const row = this.database.prepare("SELECT * FROM dispatches WHERE id=?").get(dispatchId) as
      | DispatchRow
      | undefined;
    return row ? toDispatch(row) : undefined;
  }

  getRequired(dispatchId: string): DispatchRecord {
    const dispatch = this.get(dispatchId);
    if (!dispatch) throw new Error("dispatch_not_found");
    return dispatch;
  }

  accept(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string
  ): DispatchRecord | undefined {
    let dropReason: DispatchEventDropReason | undefined;
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.accepted",
      { dispatchId, leaseId, executionAttemptId },
      () => {
        const resolved = this.resolveCurrentLease(hostId, dispatchId, leaseId, executionAttemptId);
        if (!resolved.ok) {
          dropReason = resolved.reason;
          return;
        }
        const dispatch = resolved.dispatch;
        if (dispatch.status !== "leased") {
          if (dispatch.status === "running") return;
          dropReason = "dispatch_not_awaiting_acceptance";
          return;
        }
        const acceptedAt = new Date().toISOString();
        this.database
          .prepare("UPDATE dispatches SET status='running',accepted_at=? WHERE id=?")
          .run(acceptedAt, dispatchId);
        this.appendEvent(dispatchId, "dispatch.accepted", { hostId, leaseId });
        this.options.onActivityTransitionInTransaction?.({
          type: "remote_run_started",
          dispatch: this.getRequired(dispatchId),
          occurredAt: acceptedAt
        });
      }
    );
    if (dropReason) {
      logDispatchEventDropped({
        hostId,
        messageId,
        eventType: "dispatch.accepted",
        reason: dropReason,
        dispatchId,
        leaseId,
        executionAttemptId
      });
    }
    return this.get(dispatchId);
  }

  heartbeat(
    hostId: string,
    messageId: string,
    activeLeases: ReadonlyArray<{
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    }>,
    readiness?: HostReadinessObservation
  ): Array<{
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
    leaseExpiresAt: string;
  }> {
    const payload = readiness === undefined ? { activeLeases } : { activeLeases, readiness };
    this.inbox.process(hostId, messageId, "host.heartbeat", payload, () => {
      const now = new Date();
      this.hosts.touch(hostId, now, readiness);
      for (const lease of activeLeases) {
        this.renewCurrentLease(hostId, lease, now);
      }
    });
    return activeLeases.flatMap((lease) => {
      const dispatch = this.get(lease.dispatchId);
      return dispatch &&
        dispatch.hostId === hostId &&
        dispatch.leaseId === lease.leaseId &&
        dispatch.executionAttemptId === lease.executionAttemptId &&
        ["leased", "running", "cancelling"].includes(dispatch.status)
        ? [
            {
              dispatchId: dispatch.id,
              leaseId: dispatch.leaseId,
              executionAttemptId: dispatch.executionAttemptId,
              leaseExpiresAt: dispatch.leaseExpiresAt
            }
          ]
        : [];
    });
  }

  renewLeaseForActivity(
    hostId: string,
    identity: { dispatchId: string; leaseId: string; executionAttemptId: string },
    now = new Date()
  ):
    | { dispatchId: string; leaseId: string; executionAttemptId: string; leaseExpiresAt: string }
    | undefined {
    return this.renewCurrentLease(hostId, identity, now);
  }

  private renewCurrentLease(
    hostId: string,
    identity: { dispatchId: string; leaseId: string; executionAttemptId: string },
    now: Date
  ):
    | { dispatchId: string; leaseId: string; executionAttemptId: string; leaseExpiresAt: string }
    | undefined {
    const dispatch = this.get(identity.dispatchId);
    if (
      !dispatch ||
      dispatch.hostId !== hostId ||
      dispatch.leaseId !== identity.leaseId ||
      dispatch.executionAttemptId !== identity.executionAttemptId ||
      !["leased", "running", "cancelling"].includes(dispatch.status) ||
      new Date(dispatch.leaseExpiresAt).getTime() <= now.getTime()
    ) {
      return undefined;
    }
    const remainingLeaseMs = new Date(dispatch.leaseExpiresAt).getTime() - now.getTime();
    if (remainingLeaseMs > this.options.leaseDurationMs / 2) return undefined;
    const leaseExpiresAt = new Date(now.getTime() + this.options.leaseDurationMs).toISOString();
    this.database
      .prepare("UPDATE dispatches SET lease_expires_at=? WHERE id=? AND lease_id=?")
      .run(leaseExpiresAt, dispatch.id, dispatch.leaseId);
    this.appendEvent(dispatch.id, "lease.renewed", { leaseExpiresAt });
    return {
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      leaseExpiresAt
    };
  }

  recordProgress(
    hostId: string,
    messageId: string,
    input: {
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
      percent?: number;
      message?: string;
    }
  ): void {
    let dropReason: DispatchEventDropReason | undefined;
    this.inbox.process(hostId, messageId, "dispatch.progress", input, () => {
      const resolved = this.resolveCurrentLease(
        hostId,
        input.dispatchId,
        input.leaseId,
        input.executionAttemptId
      );
      if (!resolved.ok) {
        dropReason = resolved.reason;
        return;
      }
      const dispatch = resolved.dispatch;
      if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
        dropReason = "dispatch_not_running";
        return;
      }
      this.appendEvent(dispatch.id, "dispatch.progress", {
        percent: input.percent,
        message: input.message
      });
    });
    if (dropReason) {
      logDispatchEventDropped({
        hostId,
        messageId,
        eventType: "dispatch.progress",
        reason: dropReason,
        dispatchId: input.dispatchId,
        leaseId: input.leaseId,
        executionAttemptId: input.executionAttemptId
      });
    }
  }

  interrupt(
    hostId: string,
    messageId: string,
    event: Extract<HostEvent, { type: "dispatch.interrupted" }>
  ): DispatchRecord | undefined {
    let dropReason: DispatchEventDropReason | undefined;
    this.inbox.process(hostId, messageId, event.type, event, () => {
      const resolved = this.resolveCurrentLease(
        hostId,
        event.dispatchId,
        event.leaseId,
        event.executionAttemptId
      );
      if (!resolved.ok) {
        dropReason = resolved.reason;
        return;
      }
      const dispatch = resolved.dispatch;
      if (dispatch.status === "interrupted") return;
      if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
        dropReason = "dispatch_not_running";
        return;
      }
      this.database
        .prepare(
          `UPDATE dispatches
           SET status='interrupted',interruption_reason=?,interruption_resumable=?,
               interruption_recovery_json=?
           WHERE id=?`
        )
        .run(
          event.reason,
          event.resumable ? 1 : 0,
          event.recovery ? JSON.stringify(event.recovery) : null,
          dispatch.id
        );
      const occurredAt = new Date().toISOString();
      this.appendEvent(dispatch.id, event.type, {
        reason: event.reason,
        resumable: event.resumable,
        recovery: event.recovery
      });
      this.options.onActivityTransitionInTransaction?.({
        type: "remote_run_interrupted",
        dispatch: this.getRequired(dispatch.id),
        occurredAt
      });
    });
    if (dropReason) {
      logDispatchEventDropped({
        hostId,
        messageId,
        eventType: "dispatch.interrupted",
        reason: dropReason,
        dispatchId: event.dispatchId,
        leaseId: event.leaseId,
        executionAttemptId: event.executionAttemptId
      });
    }
    return this.get(event.dispatchId);
  }

  recordCompleted(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    result: DispatchResult
  ): RecordedTerminalDispatch {
    const parsedResult = dispatchResultSchema.parse(result);
    let dropReason: DispatchEventDropReason | undefined;
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.completed",
      { dispatchId, leaseId, executionAttemptId, result: parsedResult },
      () => {
        const resolved = this.resolveCurrentLease(hostId, dispatchId, leaseId, executionAttemptId, {
          allowExpired: true
        });
        if (!resolved.ok) {
          dropReason = resolved.reason;
          return;
        }
        const dispatch = resolved.dispatch;
        if (dispatch.status === "completed" || dispatch.status === "awaiting_writeback") return;
        if (!this.canAcceptTerminalHostResult(dispatch)) {
          dropReason = "dispatch_not_running";
          return;
        }
        this.artifactAuthorization.requireResultProvenance(
          {
            workspaceId: dispatch.workspaceId,
            projectId: dispatch.projectId,
            hostId,
            dispatchId,
            leaseId,
            executionAttemptId
          },
          parsedResult
        );
        this.database
          .prepare(
            "UPDATE dispatches SET status='awaiting_writeback',result_json=?,failure_json=NULL,interruption_reason=NULL,interruption_resumable=NULL,interruption_recovery_json=NULL WHERE id=?"
          )
          .run(JSON.stringify(parsedResult), dispatchId);
        this.appendEvent(dispatchId, "dispatch.awaiting_writeback", { outcome: "completed" });
      }
    );
    if (dropReason) {
      logDispatchEventDropped({
        hostId,
        messageId,
        eventType: "dispatch.completed",
        reason: dropReason,
        dispatchId,
        leaseId,
        executionAttemptId
      });
      return { dispatch: this.get(dispatchId), writebackRequired: false };
    }
    return { dispatch: this.get(dispatchId), writebackRequired: true };
  }

  async complete(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    result: DispatchResult
  ): Promise<DispatchRecord | undefined> {
    const recorded = this.recordCompleted(
      hostId,
      messageId,
      dispatchId,
      leaseId,
      executionAttemptId,
      result
    );
    return recorded.writebackRequired && recorded.dispatch
      ? this.continuePendingWriteback(recorded.dispatch.id)
      : recorded.dispatch;
  }

  private hasPendingCancellation(dispatch: DispatchRecord): boolean {
    return this.database
      .prepare(
        `SELECT request_json FROM remote_execution_actions
         WHERE dispatch_id=? AND execution_attempt_id=? AND kind='cancel'
           AND state IN ('recorded','delivered','acknowledged')
         ORDER BY created_at,action_id`
      )
      .all(dispatch.id, dispatch.executionAttemptId)
      .some((row) => {
        const action = remoteExecutionActionRequestSchema.parse(
          JSON.parse(String(row.request_json))
        );
        return action.kind === "cancel" && action.leaseId === dispatch.leaseId;
      });
  }

  recordFailed(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    failure: DispatchFailure
  ): RecordedTerminalDispatch {
    const parsedFailure = dispatchFailureSchema.parse(failure);
    let dropReason: DispatchEventDropReason | undefined;
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.failed",
      { dispatchId, leaseId, executionAttemptId, failure: parsedFailure },
      () => {
        const resolved = this.resolveCurrentLease(hostId, dispatchId, leaseId, executionAttemptId, {
          allowExpired: true
        });
        if (!resolved.ok) {
          dropReason = resolved.reason;
          return;
        }
        const dispatch = resolved.dispatch;
        if (["failed", "cancelled", "awaiting_writeback"].includes(dispatch.status)) return;
        const interruptedCancellation =
          dispatch.status === "interrupted" &&
          parsedFailure.code === "execution_cancelled" &&
          this.hasPendingCancellation(dispatch);
        if (!this.canAcceptTerminalHostResult(dispatch) && !interruptedCancellation) {
          dropReason = "dispatch_not_running";
          return;
        }
        this.database
          .prepare(
            "UPDATE dispatches SET status='awaiting_writeback',failure_json=?,result_json=NULL,interruption_reason=NULL,interruption_resumable=NULL,interruption_recovery_json=NULL WHERE id=?"
          )
          .run(JSON.stringify(parsedFailure), dispatchId);
        this.appendEvent(dispatchId, "dispatch.awaiting_writeback", { outcome: "failed" });
      }
    );
    if (dropReason) {
      logDispatchEventDropped({
        hostId,
        messageId,
        eventType: "dispatch.failed",
        reason: dropReason,
        dispatchId,
        leaseId,
        executionAttemptId
      });
      return { dispatch: this.get(dispatchId), writebackRequired: false };
    }
    return { dispatch: this.get(dispatchId), writebackRequired: true };
  }

  async fail(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    failure: DispatchFailure
  ): Promise<DispatchRecord | undefined> {
    const recorded = this.recordFailed(
      hostId,
      messageId,
      dispatchId,
      leaseId,
      executionAttemptId,
      failure
    );
    return recorded.writebackRequired && recorded.dispatch
      ? this.continuePendingWriteback(recorded.dispatch.id)
      : recorded.dispatch;
  }

  continuePendingWriteback(dispatchId: string): Promise<DispatchRecord> {
    return this.writeBack(dispatchId);
  }

  async retryPendingWritebacks(): Promise<DispatchRecord[]> {
    const rows = this.database
      .prepare(
        "SELECT id FROM dispatches WHERE status='awaiting_writeback' ORDER BY created_at ASC"
      )
      .all();
    const results: DispatchRecord[] = [];
    for (const row of rows) results.push(await this.writeBack(String(row.id)));
    return results;
  }

  async recoverExpiredLeases(now = new Date()): Promise<DispatchRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT id FROM dispatches
         WHERE status IN ('leased','running','cancelling') AND lease_expires_at<=?
         ORDER BY lease_expires_at ASC`
      )
      .all(now.toISOString());
    const recovered: DispatchRecord[] = [];
    for (const row of rows) {
      const dispatchId = String(row.id);
      inWriteTransaction(this.database, () => {
        const dispatch = this.getRequired(dispatchId);
        if (
          !["leased", "running", "cancelling"].includes(dispatch.status) ||
          new Date(dispatch.leaseExpiresAt).getTime() > now.getTime()
        ) {
          return;
        }
        this.database
          .prepare(
            `UPDATE dispatches
             SET status='interrupted',interruption_reason='lease_lost',
               interruption_resumable=0,interruption_recovery_json=NULL,
               failure_json=NULL,result_json=NULL
             WHERE id=?`
          )
          .run(dispatchId);
        const occurredAt = now.toISOString();
        this.appendEvent(dispatchId, "dispatch.interrupted", {
          reason: "lease_lost",
          resumable: false,
          source: "lease_expiry"
        });
        this.options.onActivityTransitionInTransaction?.({
          type: "remote_run_interrupted",
          dispatch: this.getRequired(dispatchId),
          occurredAt
        });
      });
      recovered.push(this.getRequired(dispatchId));
    }
    return recovered;
  }

  private resolveCurrentLease(
    hostId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    options: { allowExpired?: boolean } = {}
  ): LeaseResolution {
    const dispatch = this.get(dispatchId);
    if (!dispatch) return { ok: false, reason: "dispatch_not_found" };
    if (
      dispatch.hostId !== hostId ||
      dispatch.leaseId !== leaseId ||
      dispatch.executionAttemptId !== executionAttemptId
    ) {
      return { ok: false, reason: "lease_mismatch" };
    }
    // Terminal complete/fail may arrive after wall-clock expiry; still accept identity match.
    // Soft-dropping those caused false lease_lost materializations while work already finished.
    if (!options.allowExpired && new Date(dispatch.leaseExpiresAt).getTime() <= Date.now()) {
      return { ok: false, reason: "lease_expired" };
    }
    return { ok: true, dispatch };
  }

  /** Whether a Host may still report terminal complete/fail for this dispatch. */
  private canAcceptTerminalHostResult(dispatch: DispatchRecord): boolean {
    if (dispatch.status === "running" || dispatch.status === "cancelling") return true;
    // Late terminal after Server-side lease recovery interrupted the dispatch.
    return dispatch.status === "interrupted" && dispatch.interruption?.reason === "lease_lost";
  }

  private async writeBack(dispatchId: string): Promise<DispatchRecord> {
    const dispatch = this.getRequired(dispatchId);
    if (dispatch.status !== "awaiting_writeback") return dispatch;
    if (dispatch.result) {
      await this.options.writeback.complete({
        dispatchId: dispatch.id,
        hostId: dispatch.hostId,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        projectId: dispatch.projectId,
        blockRef: dispatch.blockRef,
        result: dispatch.result
      });
      const afterComplete = this.getRequired(dispatchId);
      if (afterComplete.status === "failed" || afterComplete.status === "cancelled") {
        return afterComplete;
      }
      this.finishWriteback(dispatch, "completed");
    } else if (dispatch.failure) {
      await this.options.writeback.fail({
        dispatchId: dispatch.id,
        hostId: dispatch.hostId,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        projectId: dispatch.projectId,
        blockRef: dispatch.blockRef,
        failure: dispatch.failure
      });
      this.finishWriteback(
        dispatch,
        dispatch.failure.code === "execution_cancelled" ? "cancelled" : "failed"
      );
    } else {
      throw new Error("dispatch_writeback_payload_missing");
    }
    return this.getRequired(dispatchId);
  }

  private finishWriteback(dispatch: DispatchRecord, status: "completed" | "failed" | "cancelled") {
    inWriteTransaction(this.database, () => {
      const current = this.getRequired(dispatch.id);
      if (current.status === status) return;
      if (current.status !== "awaiting_writeback") {
        throw new Error("dispatch_writeback_state_changed");
      }
      const finishedAt = new Date().toISOString();
      const updated = this.database
        .prepare(
          "UPDATE dispatches SET status=?,finished_at=? WHERE id=? AND status='awaiting_writeback' AND lease_id=?"
        )
        .run(status, finishedAt, dispatch.id, dispatch.leaseId);
      if (updated.changes !== 1) throw new Error("dispatch_writeback_state_changed");
      this.appendEvent(dispatch.id, `dispatch.${status}`, {});
      if (status !== "cancelled") {
        this.options.onActivityTransitionInTransaction?.({
          type: status === "completed" ? "remote_run_succeeded" : "remote_run_failed",
          dispatch: this.getRequired(dispatch.id),
          occurredAt: finishedAt
        });
      }
    });
  }

  private appendEvent(dispatchId: string, type: string, payload: Record<string, unknown>): void {
    this.database
      .prepare(
        "INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at) VALUES (?,?,?,?)"
      )
      .run(dispatchId, type, JSON.stringify(payload), new Date().toISOString());
  }
}

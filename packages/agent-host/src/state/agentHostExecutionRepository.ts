import { z } from "zod";
import { acpCapabilitySnapshotSchema } from "@planweave-ai/runtime";
import type { DispatchResult, NormalizedFailure } from "../protocol.js";
import type { SqliteDatabase } from "./sqliteDatabase.js";
import { digestJson } from "./agentHostStateMigrations.js";
import {
  agentHostExecutionStatusSchema,
  toExecution,
  toExecutionEvidence,
  type AgentHostExecution,
  type AgentHostExecutionEvidence,
  type AgentHostExecutionStatus,
  type ExecuteBlockCommand
} from "./agentHostStateRecords.js";

const executionSelect = `
SELECT i.sequence,i.message_id,i.command_json,e.lease_id,e.lease_expires_at,e.status,e.received_at,e.started_at,
       e.interrupted_at,e.finished_at
FROM agent_host_executions e
JOIN agent_host_inbox i ON i.sequence=e.inbox_sequence`;

const evidenceSelect = `
SELECT inbox_sequence,dispatch_id,lease_id,execution_attempt_id,protocol_version,
       envelope_digest,envelope_version,workspace_id,agent_profile_id,source_revision,
       status,acp_session_id,acp_capabilities_json,recovery_id,event_cursor,action_cursor,
       cancellation_intent_json,recovery_intent_json,terminal_kind,terminal_payload_digest,
       terminal_event_message_id,terminal_acknowledged_at
FROM agent_host_executions`;

const terminalStatuses = new Set<AgentHostExecutionStatus>(["completed", "failed", "cancelled"]);
const transitions: Readonly<
  Record<AgentHostExecutionStatus, ReadonlySet<AgentHostExecutionStatus>>
> = {
  accepted: new Set(["preparing", "interrupted", "failed", "cancelled"]),
  preparing: new Set(["running", "interrupted", "failed", "cancelled"]),
  running: new Set(["interaction_wait", "interrupted", "completed", "failed", "cancelled"]),
  interaction_wait: new Set(["running", "interrupted", "completed", "failed", "cancelled"]),
  interrupted: new Set(["preparing", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

const sessionEvidenceSchema = z
  .object({
    sessionId: z.string().min(1).max(1_024),
    capabilitySnapshot: acpCapabilitySnapshotSchema,
    recoveryId: z.string().min(1).max(128).optional()
  })
  .strict();

const actionEvidenceSchema = z
  .object({
    leaseId: z.string().min(1),
    sessionId: z.string().min(1).max(1_024),
    actionId: z.string().min(1).max(128),
    kind: z.enum(["permission", "elicitation", "authentication"]),
    deadline: z.string().datetime(),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    afterCursor: z.number().int().nonnegative(),
    cursor: z.number().int().positive()
  })
  .strict();

const artifactEvidenceSchema = z
  .object({
    operationId: z.string().min(1).max(256),
    direction: z.enum(["input", "report", "output"]),
    artifactRef: z.string().regex(/^artifact:sha256:[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative().safe(),
    mediaType: z.string().min(1).max(512)
  })
  .strict()
  .superRefine((input, context) => {
    if (input.artifactRef !== `artifact:sha256:${input.sha256}`) {
      context.addIssue({ code: "custom", path: ["artifactRef"], message: "digest mismatch" });
    }
  });

const resumeIntentSchema = z
  .object({
    kind: z.literal("resume_same_session"),
    leaseId: z.string().min(1),
    leaseExpiresAt: z.string().datetime(),
    priorLeaseId: z.string().min(1),
    priorRecovery: z
      .object({ acpSessionId: z.string().min(1), recoveryId: z.string().min(1) })
      .strict()
  })
  .strict();

const failedResumeIntentSchema = z
  .object({
    kind: z.literal("session_load_failed"),
    leaseId: z.string().min(1),
    priorRecovery: z
      .object({ acpSessionId: z.string().min(1), recoveryId: z.string().min(1) })
      .strict()
  })
  .strict();

type RepositoryLimits = {
  maxCapabilitiesBytes: number;
  maxActionsPerExecution: number;
  maxArtifactsPerExecution: number;
};

function safeLateSettlement(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const value = response as Record<string, unknown>;
  return (
    (value.type === "interaction.permission_response" && value.decision === "deny") ||
    (value.type === "interaction.elicitation_response" && value.outcome === "cancelled") ||
    (value.type === "interaction.authentication_action" && value.action === "cancel")
  );
}

function expectedActionKind(response: unknown): "permission" | "elicitation" | "authentication" {
  if (typeof response !== "object" || response === null) {
    throw new Error("execution_action_response_invalid");
  }
  switch ((response as Record<string, unknown>).type) {
    case "interaction.permission_response":
      return "permission";
    case "interaction.elicitation_response":
      return "elicitation";
    case "interaction.authentication_action":
      return "authentication";
    default:
      throw new Error("execution_action_response_invalid");
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export class AgentHostExecutionRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly limits: RepositoryLimits
  ) {}

  insert(sequence: number, command: ExecuteBlockCommand, receivedAt: string): boolean {
    const existing = this.database
      .prepare(
        `SELECT e.*,i.command_digest FROM agent_host_executions e
         JOIN agent_host_inbox i ON i.sequence=e.inbox_sequence
         WHERE e.dispatch_id=? AND e.execution_attempt_id=?`
      )
      .get(command.dispatchId, command.executionAttemptId);
    if (existing) {
      const evidence = toExecutionEvidence(existing);
      const immutable = {
        leaseId: command.leaseId,
        protocolVersion: command.protocolVersion,
        envelopeDigest: command.envelopeDigest,
        envelopeVersion: command.envelope.protocolVersion,
        workspaceId: command.envelope.workspaceId,
        agentProfileId: command.envelope.agentProfileId,
        sourceRevision: command.envelope.sourceRevision
      };
      if (
        String(existing.command_digest) !== digestJson(command) ||
        evidence.leaseId !== immutable.leaseId ||
        evidence.protocolVersion !== immutable.protocolVersion ||
        evidence.envelopeDigest !== immutable.envelopeDigest ||
        evidence.envelopeVersion !== immutable.envelopeVersion ||
        evidence.workspaceId !== immutable.workspaceId ||
        evidence.agentProfileId !== immutable.agentProfileId ||
        evidence.sourceRevision !== immutable.sourceRevision
      ) {
        throw new Error("execution_identity_conflict");
      }
      return false;
    }
    this.database
      .prepare(
        `INSERT INTO agent_host_executions(
          inbox_sequence,dispatch_id,lease_id,execution_attempt_id,protocol_version,
          envelope_digest,envelope_version,workspace_id,agent_profile_id,source_revision,
          status,lease_expires_at,received_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        sequence,
        command.dispatchId,
        command.leaseId,
        command.executionAttemptId,
        command.protocolVersion,
        command.envelopeDigest,
        command.envelope.protocolVersion,
        command.envelope.workspaceId,
        command.envelope.agentProfileId,
        command.envelope.sourceRevision,
        "accepted",
        command.leaseExpiresAt,
        receivedAt
      );
    this.recordTransition(sequence, null, "accepted", "mailbox_command_durable", receivedAt);
    return true;
  }

  get(sequence: number): AgentHostExecution | undefined {
    const row = this.database.prepare(`${executionSelect} WHERE i.sequence=?`).get(sequence);
    return row ? toExecution(row) : undefined;
  }

  findByIdentity(identity: {
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
  }): AgentHostExecution | undefined {
    const row = this.database
      .prepare(
        `${executionSelect}
         WHERE e.dispatch_id=? AND e.lease_id=? AND e.execution_attempt_id=?`
      )
      .get(identity.dispatchId, identity.leaseId, identity.executionAttemptId);
    return row ? toExecution(row) : undefined;
  }

  findByAttempt(dispatchId: string, executionAttemptId: string): AgentHostExecution | undefined {
    const row = this.database
      .prepare(`${executionSelect} WHERE e.dispatch_id=? AND e.execution_attempt_id=?`)
      .get(dispatchId, executionAttemptId);
    return row ? toExecution(row) : undefined;
  }

  evidence(sequence: number): AgentHostExecutionEvidence | undefined {
    const row = this.database.prepare(`${evidenceSelect} WHERE inbox_sequence=?`).get(sequence);
    return row ? toExecutionEvidence(row) : undefined;
  }

  list(statuses: readonly AgentHostExecutionStatus[], limit?: number): AgentHostExecution[] {
    if (statuses.length === 0) return [];
    for (const status of statuses) agentHostExecutionStatusSchema.parse(status);
    const placeholders = statuses.map(() => "?").join(",");
    const limitSql = limit === undefined ? "" : " LIMIT ?";
    const values = limit === undefined ? statuses : [...statuses, limit];
    return this.database
      .prepare(
        `${executionSelect} WHERE e.status IN (${placeholders}) ORDER BY i.sequence${limitSql}`
      )
      .all(...values)
      .map(toExecution);
  }

  transition(
    sequence: number,
    to: AgentHostExecutionStatus,
    evidenceKind: string,
    occurredAt = new Date().toISOString()
  ): AgentHostExecution {
    const current = this.require(sequence);
    if (current.status === to) return current;
    if (!transitions[current.status].has(to)) {
      throw new Error(`execution_transition_invalid:${current.status}:${to}`);
    }
    const timestamps =
      to === "running"
        ? ",started_at=COALESCE(started_at,?)"
        : to === "interrupted"
          ? ",interrupted_at=?"
          : terminalStatuses.has(to)
            ? ",finished_at=?"
            : "";
    const values = timestamps
      ? [to, occurredAt, sequence, current.status]
      : [to, sequence, current.status];
    const updated = this.database
      .prepare(
        `UPDATE agent_host_executions SET status=?${timestamps}
         WHERE inbox_sequence=? AND status=?`
      )
      .run(...values);
    if (updated.changes !== 1) throw new Error("execution_transition_raced");
    this.recordTransition(sequence, current.status, to, evidenceKind, occurredAt);
    return this.require(sequence);
  }

  recordSession(sequence: number, input: unknown): AgentHostExecutionEvidence {
    const parsed = sessionEvidenceSchema.parse(input);
    const capabilitySnapshotJson = JSON.stringify(parsed.capabilitySnapshot);
    if (byteLength(capabilitySnapshotJson) > this.limits.maxCapabilitiesBytes) {
      throw new Error("execution_capabilities_too_large");
    }
    const current = this.requireEvidence(sequence);
    if (current.acpSessionId) {
      if (
        current.acpSessionId !== parsed.sessionId ||
        JSON.stringify(current.acpCapabilitySnapshot) !== capabilitySnapshotJson ||
        current.recoveryId !== parsed.recoveryId
      ) {
        throw new Error("execution_session_identity_conflict");
      }
      return current;
    }
    if (!new Set(["preparing", "running", "interaction_wait"]).has(current.status)) {
      throw new Error("execution_session_state_invalid");
    }
    this.database
      .prepare(
        `UPDATE agent_host_executions
         SET acp_session_id=?,acp_capabilities_json=?,recovery_id=?
         WHERE inbox_sequence=? AND acp_session_id IS NULL`
      )
      .run(parsed.sessionId, capabilitySnapshotJson, parsed.recoveryId ?? null, sequence);
    return this.requireEvidence(sequence);
  }

  advanceEventCursor(sequence: number, afterCursor: number, cursor: number): number {
    z.number().int().nonnegative().parse(afterCursor);
    z.number().int().positive().parse(cursor);
    if (cursor <= afterCursor) throw new Error("execution_event_cursor_invalid");
    const updated = this.database
      .prepare(
        `UPDATE agent_host_executions SET event_cursor=?
         WHERE inbox_sequence=? AND event_cursor=?`
      )
      .run(cursor, sequence, afterCursor);
    if (updated.changes !== 1) throw new Error("execution_event_cursor_conflict");
    return cursor;
  }

  recordAction(sequence: number, input: unknown, createdAt = new Date().toISOString()): boolean {
    const parsed = actionEvidenceSchema.parse(input);
    const current = this.requireEvidence(sequence);
    if (current.leaseId !== parsed.leaseId) throw new Error("execution_action_stale_lease");
    if (current.acpSessionId !== parsed.sessionId)
      throw new Error("execution_action_stale_session");
    const existing = this.database
      .prepare(
        `SELECT lease_id,action_kind,deadline,request_digest FROM agent_host_execution_actions
         WHERE inbox_sequence=? AND session_id=? AND action_id=?`
      )
      .get(sequence, parsed.sessionId, parsed.actionId);
    if (existing) {
      if (
        String(existing.lease_id) !== parsed.leaseId ||
        String(existing.action_kind) !== parsed.kind ||
        String(existing.deadline) !== parsed.deadline ||
        String(existing.request_digest) !== parsed.requestDigest
      ) {
        throw new Error("execution_action_identity_conflict");
      }
      return false;
    }
    if (current.actionCursor !== parsed.afterCursor || parsed.cursor !== parsed.afterCursor + 1) {
      throw new Error("execution_action_cursor_conflict");
    }
    if (
      this.count("agent_host_execution_actions", sequence) >= this.limits.maxActionsPerExecution
    ) {
      throw new Error("execution_action_retention_limit_exceeded");
    }
    this.database
      .prepare(
        `INSERT INTO agent_host_execution_actions(
          inbox_sequence,lease_id,session_id,action_id,action_kind,deadline,
          request_digest,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        sequence,
        parsed.leaseId,
        parsed.sessionId,
        parsed.actionId,
        parsed.kind,
        parsed.deadline,
        parsed.requestDigest,
        createdAt
      );
    this.database
      .prepare("UPDATE agent_host_executions SET action_cursor=? WHERE inbox_sequence=?")
      .run(parsed.cursor, sequence);
    return true;
  }

  settleAction(
    sequence: number,
    input: { leaseId: string; sessionId: string; actionId: string; response: unknown },
    settledAt = new Date().toISOString(),
    allowExpired = false
  ): boolean {
    const response = z.json().parse(input.response);
    const responseJson = JSON.stringify(response);
    const responseDigest = digestJson(response);
    const current = this.requireEvidence(sequence);
    if (current.leaseId !== input.leaseId) throw new Error("execution_action_stale_lease");
    if (current.acpSessionId !== input.sessionId) throw new Error("execution_action_stale_session");
    const row = this.database
      .prepare(
        `SELECT action_kind,deadline,response_digest,response_json FROM agent_host_execution_actions
         WHERE inbox_sequence=? AND session_id=? AND action_id=?`
      )
      .get(sequence, input.sessionId, input.actionId);
    if (!row) throw new Error("execution_action_not_found");
    if (String(row.action_kind) !== expectedActionKind(response)) {
      throw new Error("execution_action_response_type_mismatch");
    }
    if (row.response_digest) {
      if (
        String(row.response_digest) !== responseDigest ||
        String(row.response_json) !== responseJson
      ) {
        throw new Error("execution_action_response_conflict");
      }
      return false;
    }
    if (
      Date.parse(settledAt) > Date.parse(String(row.deadline)) &&
      !safeLateSettlement(response) &&
      !allowExpired
    ) {
      throw new Error("execution_action_expired");
    }
    this.database
      .prepare(
        `UPDATE agent_host_execution_actions SET response_digest=?,response_json=?,settled_at=?
         WHERE inbox_sequence=? AND session_id=? AND action_id=? AND response_digest IS NULL`
      )
      .run(responseDigest, responseJson, settledAt, sequence, input.sessionId, input.actionId);
    return true;
  }

  actionSettlement(sequence: number, sessionId: string, actionId: string): unknown | undefined {
    const row = this.database
      .prepare(
        `SELECT response_json FROM agent_host_execution_actions
         WHERE inbox_sequence=? AND session_id=? AND action_id=?`
      )
      .get(sequence, sessionId, actionId);
    if (!row?.response_json) return undefined;
    return z.json().parse(JSON.parse(String(row.response_json)));
  }

  recordArtifact(sequence: number, input: unknown, at = new Date().toISOString()): boolean {
    const parsed = artifactEvidenceSchema.parse(input);
    const existing = this.database
      .prepare(
        `SELECT direction,artifact_ref,sha256,size_bytes,media_type
         FROM agent_host_execution_artifacts WHERE inbox_sequence=? AND operation_id=?`
      )
      .get(sequence, parsed.operationId);
    if (existing) {
      if (
        String(existing.direction) !== parsed.direction ||
        String(existing.artifact_ref) !== parsed.artifactRef ||
        String(existing.sha256) !== parsed.sha256 ||
        Number(existing.size_bytes) !== parsed.sizeBytes ||
        String(existing.media_type) !== parsed.mediaType
      ) {
        throw new Error("execution_artifact_identity_conflict");
      }
      return false;
    }
    if (
      this.count("agent_host_execution_artifacts", sequence) >= this.limits.maxArtifactsPerExecution
    ) {
      throw new Error("execution_artifact_retention_limit_exceeded");
    }
    this.database
      .prepare(
        `INSERT INTO agent_host_execution_artifacts(
          inbox_sequence,operation_id,direction,artifact_ref,sha256,size_bytes,media_type,transferred_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        sequence,
        parsed.operationId,
        parsed.direction,
        parsed.artifactRef,
        parsed.sha256,
        parsed.sizeBytes,
        parsed.mediaType,
        at
      );
    return true;
  }

  setIntent(
    sequence: number,
    kind: "cancellation" | "recovery",
    intent: unknown
  ): AgentHostExecutionEvidence {
    const serialized = JSON.stringify(z.json().parse(intent));
    const column = kind === "cancellation" ? "cancellation_intent_json" : "recovery_intent_json";
    const current = this.requireEvidence(sequence);
    const existing = kind === "cancellation" ? current.cancellationIntent : current.recoveryIntent;
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== serialized)
        throw new Error(`execution_${kind}_intent_conflict`);
      return current;
    }
    this.database
      .prepare(`UPDATE agent_host_executions SET ${column}=? WHERE inbox_sequence=?`)
      .run(serialized, sequence);
    return this.requireEvidence(sequence);
  }

  replaceRecoveryIntent(sequence: number, intent: unknown): AgentHostExecutionEvidence {
    const serialized = JSON.stringify(z.json().parse(intent));
    this.database
      .prepare("UPDATE agent_host_executions SET recovery_intent_json=? WHERE inbox_sequence=?")
      .run(serialized, sequence);
    return this.requireEvidence(sequence);
  }

  finish(
    sequence: number,
    status: "completed" | "failed" | "cancelled",
    payload: DispatchResult | NormalizedFailure,
    eventMessageId: string,
    at = new Date().toISOString()
  ): AgentHostExecution {
    const digest = digestJson(payload);
    const current = this.requireEvidence(sequence);
    if (terminalStatuses.has(current.status)) {
      if (
        current.status !== status ||
        current.terminalPayloadDigest !== digest ||
        current.terminalEventMessageId !== eventMessageId
      ) {
        throw new Error("execution_terminal_identity_conflict");
      }
      return this.require(sequence);
    }
    this.transition(sequence, status, `terminal_${status}`, at);
    this.database
      .prepare(
        `UPDATE agent_host_executions
         SET terminal_kind=?,terminal_payload_digest=?,terminal_event_message_id=?
         WHERE inbox_sequence=?`
      )
      .run(status, digest, eventMessageId, sequence);
    return this.require(sequence);
  }

  acknowledgeTerminalEvent(messageId: string, at: string): void {
    this.database
      .prepare(
        `UPDATE agent_host_executions SET terminal_acknowledged_at=COALESCE(terminal_acknowledged_at,?)
         WHERE terminal_event_message_id=?`
      )
      .run(at, messageId);
  }

  renewLease(sequence: number, leaseExpiresAt: string): void {
    this.database
      .prepare("UPDATE agent_host_executions SET lease_expires_at=? WHERE inbox_sequence=?")
      .run(leaseExpiresAt, sequence);
  }

  authorizeResume(
    sequence: number,
    input: {
      leaseId: string;
      leaseExpiresAt: string;
      priorRecovery: { acpSessionId: string; recoveryId: string };
    },
    at = new Date().toISOString()
  ): { execution: AgentHostExecution; newlyAuthorized: boolean } {
    const current = this.requireEvidence(sequence);
    const parsedResumeIntent = resumeIntentSchema.safeParse(current.recoveryIntent);
    const parsedFailedIntent = failedResumeIntentSchema.safeParse(current.recoveryIntent);
    if (parsedFailedIntent.success) {
      throw new Error("execution_resume_non_resumable");
    }
    if (parsedResumeIntent.success && parsedResumeIntent.data.leaseId === input.leaseId) {
      if (
        parsedResumeIntent.data.leaseExpiresAt === input.leaseExpiresAt &&
        current.acpSessionId === input.priorRecovery.acpSessionId &&
        current.recoveryId === input.priorRecovery.recoveryId
      ) {
        return { execution: this.require(sequence), newlyAuthorized: false };
      }
      throw new Error("execution_resume_conflict");
    }
    if (current.status !== "interrupted") throw new Error("execution_resume_state_invalid");
    if (
      current.acpSessionId !== input.priorRecovery.acpSessionId ||
      current.recoveryId !== input.priorRecovery.recoveryId
    ) {
      throw new Error("execution_resume_recovery_identity_mismatch");
    }
    if (current.acpCapabilitySnapshot?.negotiated.includes("history-load") !== true) {
      throw new Error("execution_resume_session_load_unsupported");
    }
    if (current.leaseId === input.leaseId) throw new Error("execution_resume_fresh_lease_required");
    const intent = {
      kind: "resume_same_session" as const,
      leaseId: input.leaseId,
      leaseExpiresAt: input.leaseExpiresAt,
      priorLeaseId: current.leaseId,
      priorRecovery: input.priorRecovery
    };
    const updated = this.database
      .prepare(
        `UPDATE agent_host_executions
         SET lease_id=?,lease_expires_at=?,recovery_intent_json=?,status='preparing'
         WHERE inbox_sequence=? AND status='interrupted' AND lease_id=?`
      )
      .run(input.leaseId, input.leaseExpiresAt, JSON.stringify(intent), sequence, current.leaseId);
    if (updated.changes !== 1) throw new Error("execution_resume_raced");
    this.recordTransition(sequence, "interrupted", "preparing", "resume_authorized", at);
    return { execution: this.require(sequence), newlyAuthorized: true };
  }

  markResumeFailed(sequence: number, at = new Date().toISOString()): AgentHostExecution {
    const current = this.requireEvidence(sequence);
    if (current.status === "interrupted") {
      const existing = failedResumeIntentSchema.safeParse(current.recoveryIntent);
      if (existing.success) return this.require(sequence);
      throw new Error("execution_resume_failure_state_invalid");
    }
    const intent = resumeIntentSchema.parse(current.recoveryIntent);
    if (current.status !== "preparing" && current.status !== "running") {
      throw new Error("execution_resume_failure_state_invalid");
    }
    const updated = this.database
      .prepare(
        `UPDATE agent_host_executions
         SET status='interrupted',interrupted_at=?,recovery_intent_json=?
         WHERE inbox_sequence=? AND status=? AND lease_id=?`
      )
      .run(
        at,
        JSON.stringify({
          kind: "session_load_failed",
          leaseId: intent.leaseId,
          priorRecovery: intent.priorRecovery
        }),
        sequence,
        current.status,
        intent.leaseId
      );
    if (updated.changes !== 1) throw new Error("execution_resume_failure_raced");
    this.recordTransition(sequence, current.status, "interrupted", "session_load_failed", at);
    return this.require(sequence);
  }

  private require(sequence: number): AgentHostExecution {
    const execution = this.get(sequence);
    if (!execution) throw new Error("execution_not_found");
    return execution;
  }

  private requireEvidence(sequence: number): AgentHostExecutionEvidence {
    const evidence = this.evidence(sequence);
    if (!evidence) throw new Error("execution_not_found");
    return evidence;
  }

  private recordTransition(
    sequence: number,
    from: AgentHostExecutionStatus | null,
    to: AgentHostExecutionStatus,
    evidenceKind: string,
    occurredAt: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO agent_host_execution_transitions(
          inbox_sequence,from_status,to_status,evidence_kind,occurred_at
        ) VALUES(?,?,?,?,?)`
      )
      .run(sequence, from, to, evidenceKind, occurredAt);
  }

  private count(table: string, sequence: number): number {
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE inbox_sequence=?`)
      .get(sequence);
    return Number(row?.count ?? 0);
  }
}

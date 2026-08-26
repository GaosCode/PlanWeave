import {
  dispatchIdSchema,
  executionAttemptIdSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { capabilitiesSchema } from "./protocol.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import {
  dispatchHostSelectionSnapshotSchema,
  type DispatchHostSelectionSnapshot
} from "./work/dispatchIntegration.js";
import {
  endpointSelectionSnapshotSchema,
  persistEndpointSelectionSnapshot,
  readEndpointSelectionSnapshot,
  type EndpointSelectionSnapshot
} from "./endpointSelection.js";
import {
  persistedRemoteAgentAccessSnapshotSchema,
  type PersistedRemoteAgentAccessSnapshot
} from "./remoteAgent/schema.js";

const boundedKeySchema = z
  .string()
  .min(1)
  .max(256)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: persisted keys reject C0 controls and DEL.
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const blockRefSchema = z
  .string()
  .min(3)
  .max(257)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*#[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.iso.datetime();
const remoteOperationScopeSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema
  })
  .strict();
const remoteOperationIdScopeSchema = remoteOperationScopeSchema.extend({
  operationId: opaqueIdentifierSchema
});

export const remoteOperationStateSchema = z.enum([
  "preparing",
  "claimed",
  "reserved",
  "activated",
  "running",
  "interrupted",
  "action_required",
  "awaiting_writeback",
  "completed",
  "failed",
  "cancelled"
]);

export const remoteAttemptStatusSchema = z.enum([
  "prepared",
  "reserved",
  "activated",
  "running",
  "interrupted",
  "action_required",
  "awaiting_writeback",
  "superseded",
  "completed",
  "failed",
  "cancelled"
]);

export const remotePersistenceEventTypeSchema = z.enum([
  "remote.operation.created",
  "remote.operation.claimed",
  "remote.operation.envelope_recorded",
  "remote.attempt.reserved",
  "remote.attempt.activated",
  "remote.attempt.running",
  "remote.attempt.interrupted",
  "remote.attempt.action_required",
  "remote.attempt.awaiting_writeback",
  "remote.attempt.superseded",
  "remote.attempt.retry_created",
  "remote.attempt.completed",
  "remote.attempt.failed",
  "remote.attempt.cancelled",
  "remote.reservation.released",
  "remote.reservation.expired",
  "remote.reservation.cancelled"
]);

export const createRemoteOperationInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    ownershipGeneration: opaqueIdentifierSchema,
    idempotencyKey: boundedKeySchema,
    sourceFingerprint: opaqueIdentifierSchema,
    requiredCapabilities: capabilitiesSchema,
    /**
     * Authorized Host selection at dispatch begin. Optional when no assignment gate is wired.
     * When present, persisted with the operation and never re-derived from a later assignment.
     */
    hostSelection: dispatchHostSelectionSnapshotSchema.optional(),
    endpointSelection: endpointSelectionSnapshotSchema.optional(),
    agentAccess: persistedRemoteAgentAccessSnapshotSchema.optional()
  })
  .strict();

const operationRowSchema = z
  .object({
    id: opaqueIdentifierSchema,
    workspace_id: workspaceIdSchema,
    project_id: opaqueIdentifierSchema,
    canvas_id: opaqueIdentifierSchema,
    block_ref: blockRefSchema,
    ownership_generation: opaqueIdentifierSchema,
    idempotency_key: boundedKeySchema,
    request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    source_fingerprint: opaqueIdentifierSchema,
    required_capabilities_json: z.string(),
    state: remoteOperationStateSchema,
    dispatch_id: dispatchIdSchema,
    execution_attempt_id: executionAttemptIdSchema,
    envelope_digest: z
      .string()
      .regex(/^envelope:sha256:[a-f0-9]{64}$/)
      .nullable(),
    envelope_reference: boundedKeySchema.nullable(),
    host_selection_json: z.string().nullable(),
    endpoint_selection_json: z.string().nullable(),
    agent_access_json: z.string().nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    terminal_at: timestampSchema.nullable()
  })
  .strict();

const attemptRowSchema = z
  .object({
    execution_attempt_id: executionAttemptIdSchema,
    operation_id: opaqueIdentifierSchema,
    dispatch_id: dispatchIdSchema,
    workspace_id: workspaceIdSchema,
    project_id: opaqueIdentifierSchema,
    canvas_id: opaqueIdentifierSchema,
    block_ref: blockRefSchema,
    ownership_generation: opaqueIdentifierSchema,
    status: remoteAttemptStatusSchema,
    host_id: opaqueIdentifierSchema.nullable(),
    lease_id: opaqueIdentifierSchema.nullable(),
    lease_fencing_token: z.number().int().nonnegative(),
    lease_expires_at: timestampSchema.nullable(),
    state_version: z.number().int().nonnegative(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    terminal_at: timestampSchema.nullable()
  })
  .strict();

export type CreateRemoteOperationInput = z.infer<typeof createRemoteOperationInputSchema>;
export type RemoteOperationState = z.infer<typeof remoteOperationStateSchema>;
export type RemoteAttemptStatus = z.infer<typeof remoteAttemptStatusSchema>;
export type RemotePersistenceEventType = z.infer<typeof remotePersistenceEventTypeSchema>;

export type RemoteExecutionAttempt = {
  executionAttemptId: string;
  operationId: string;
  dispatchId: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  blockRef: string;
  ownershipGeneration: string;
  status: RemoteAttemptStatus;
  hostId?: string;
  leaseId?: string;
  leaseFencingToken: number;
  leaseExpiresAt?: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
};

export type RemoteOperation = {
  id: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  blockRef: string;
  ownershipGeneration: string;
  idempotencyKey: string;
  requestFingerprint: string;
  sourceFingerprint: string;
  requiredCapabilities: string[];
  state: RemoteOperationState;
  dispatchId: string;
  executionAttemptId: string;
  envelopeDigest?: string;
  envelopeReference?: string;
  /** Durable Host selection authorized at dispatch begin (restart-safe). */
  hostSelection?: DispatchHostSelectionSnapshot;
  /** Durable exact Endpoint route for v3; internal hostId is never human-projected. */
  endpointSelection?: EndpointSelectionSnapshot;
  /** Durable Remote Agent access snapshot; reentry keeps it, retry_new_attempt re-runs authorize. */
  agentAccess?: PersistedRemoteAgentAccessSnapshot;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  attempt: RemoteExecutionAttempt;
};

const operationColumns = `
  id,workspace_id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,request_fingerprint,
  source_fingerprint,required_capabilities_json,state,dispatch_id,execution_attempt_id,
  envelope_digest,envelope_reference,host_selection_json,endpoint_selection_json,
  agent_access_json,created_at,updated_at,terminal_at
`;

const attemptColumns = `
  execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,block_ref,
  ownership_generation,status,host_id,lease_id,lease_fencing_token,lease_expires_at,
  state_version,created_at,updated_at,terminal_at
`;

function requestFingerprint(input: CreateRemoteOperationInput): string {
  // Host selection is v2 authority evidence; Endpoint identity is caller-selected in v3.
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId,
        blockRef: input.blockRef,
        ownershipGeneration: input.ownershipGeneration,
        idempotencyKey: input.idempotencyKey,
        sourceFingerprint: input.sourceFingerprint,
        requiredCapabilities: input.requiredCapabilities,
        agentEndpointId: input.endpointSelection?.endpointId
      })
    )
    .digest("hex");
}

function parseHostSelection(raw: string | null): DispatchHostSelectionSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  return dispatchHostSelectionSnapshotSchema.parse(JSON.parse(raw));
}

function parseEndpointSelection(
  raw: string | null,
  workspaceId: string
): EndpointSelectionSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  return readEndpointSelectionSnapshot(JSON.parse(raw), workspaceId);
}

function parseAgentAccess(raw: string | null): PersistedRemoteAgentAccessSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  return persistedRemoteAgentAccessSnapshotSchema.parse(JSON.parse(raw));
}

function parseAttempt(row: Record<string, unknown>): RemoteExecutionAttempt {
  const parsed = attemptRowSchema.parse(row);
  return {
    executionAttemptId: parsed.execution_attempt_id,
    operationId: parsed.operation_id,
    dispatchId: parsed.dispatch_id,
    workspaceId: parsed.workspace_id,
    projectId: parsed.project_id,
    canvasId: parsed.canvas_id,
    blockRef: parsed.block_ref,
    ownershipGeneration: parsed.ownership_generation,
    status: parsed.status,
    hostId: parsed.host_id ?? undefined,
    leaseId: parsed.lease_id ?? undefined,
    leaseFencingToken: parsed.lease_fencing_token,
    leaseExpiresAt: parsed.lease_expires_at ?? undefined,
    stateVersion: parsed.state_version,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    terminalAt: parsed.terminal_at ?? undefined
  };
}

export class RemoteOperationRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  create(rawInput: CreateRemoteOperationInput): RemoteOperation {
    const input = createRemoteOperationInputSchema.parse(rawInput);
    const fingerprint = requestFingerprint(input);
    return inWriteTransaction(this.database, () => {
      const existing = this.findByKey(input);
      if (existing) {
        if (
          existing.requestFingerprint !== fingerprint ||
          existing.projectId !== input.projectId ||
          existing.canvasId !== input.canvasId ||
          existing.blockRef !== input.blockRef ||
          existing.ownershipGeneration !== input.ownershipGeneration ||
          existing.idempotencyKey !== input.idempotencyKey ||
          existing.sourceFingerprint !== input.sourceFingerprint ||
          existing.requiredCapabilities.length !== input.requiredCapabilities.length ||
          existing.requiredCapabilities.some(
            (capability, index) => capability !== input.requiredCapabilities[index]
          ) ||
          existing.endpointSelection?.endpointId !== input.endpointSelection?.endpointId
        ) {
          throw new Error("remote_operation_idempotency_conflict");
        }
        return existing;
      }
      const operationId = opaqueIdentifierSchema.parse(`operation-${randomUUID()}`);
      const dispatchId = dispatchIdSchema.parse(`dispatch-${randomUUID()}`);
      const executionAttemptId = executionAttemptIdSchema.parse(`attempt-${randomUUID()}`);
      const now = this.clock().toISOString();
      const hostSelectionJson = input.hostSelection
        ? JSON.stringify(dispatchHostSelectionSnapshotSchema.parse(input.hostSelection))
        : null;
      const endpointSelectionJson = input.endpointSelection
        ? JSON.stringify(
            persistEndpointSelectionSnapshot(input.endpointSelection, input.workspaceId)
          )
        : null;
      const agentAccessJson = input.agentAccess
        ? JSON.stringify(persistedRemoteAgentAccessSnapshotSchema.parse(input.agentAccess))
        : null;
      this.database
        .prepare(
          `INSERT INTO remote_operations(
            id,workspace_id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,
            request_fingerprint,source_fingerprint,required_capabilities_json,state,
            dispatch_id,execution_attempt_id,host_selection_json,endpoint_selection_json,
            agent_access_json,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,'preparing',?,?,?,?,?,?,?)`
        )
        .run(
          operationId,
          input.workspaceId,
          input.projectId,
          input.canvasId,
          input.blockRef,
          input.ownershipGeneration,
          input.idempotencyKey,
          fingerprint,
          input.sourceFingerprint,
          JSON.stringify(input.requiredCapabilities),
          dispatchId,
          executionAttemptId,
          hostSelectionJson,
          endpointSelectionJson,
          agentAccessJson,
          now,
          now
        );
      this.database
        .prepare(
          `INSERT INTO remote_execution_attempts(
            execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,block_ref,
            ownership_generation,status,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,'prepared',?,?)`
        )
        .run(
          executionAttemptId,
          operationId,
          dispatchId,
          input.workspaceId,
          input.projectId,
          input.canvasId,
          input.blockRef,
          input.ownershipGeneration,
          now,
          now
        );
      this.appendEvent(operationId, executionAttemptId, "remote.operation.created", now);
      return this.getRequired(operationId);
    });
  }

  markClaimed(operationId: string): RemoteOperation {
    return inWriteTransaction(this.database, () => {
      const operation = this.getRequired(operationId);
      if (operation.state === "claimed") return operation;
      if (operation.state !== "preparing") throw new Error("remote_operation_not_preparing");
      const now = this.clock().toISOString();
      this.database
        .prepare("UPDATE remote_operations SET state='claimed',updated_at=? WHERE id=?")
        .run(now, operation.id);
      this.appendEvent(operation.id, operation.executionAttemptId, "remote.operation.claimed", now);
      return this.getRequired(operation.id);
    });
  }

  cancelClaimedAfterRuntimeReset(input: {
    operationId: string;
    executionAttemptId: string;
  }): RemoteOperation {
    const operationId = opaqueIdentifierSchema.parse(input.operationId);
    const executionAttemptId = executionAttemptIdSchema.parse(input.executionAttemptId);
    return inWriteTransaction(this.database, () => {
      const operation = this.getRequired(operationId);
      if (
        operation.state !== "claimed" ||
        operation.executionAttemptId !== executionAttemptId ||
        operation.attempt.status !== "prepared" ||
        operation.attempt.hostId !== undefined ||
        operation.attempt.leaseId !== undefined ||
        operation.attempt.leaseExpiresAt !== undefined ||
        operation.attempt.leaseFencingToken !== 0 ||
        operation.attempt.stateVersion !== 0 ||
        operation.attempt.terminalAt !== undefined
      ) {
        throw new Error("remote_runtime_reset_recovery_conflict");
      }

      const now = this.clock().toISOString();
      const attemptUpdate = this.database
        .prepare(
          `UPDATE remote_execution_attempts
           SET status='cancelled',state_version=state_version+1,updated_at=?,terminal_at=?
           WHERE execution_attempt_id=? AND operation_id=? AND status='prepared'
             AND host_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL
             AND lease_fencing_token=0 AND state_version=0 AND terminal_at IS NULL`
        )
        .run(now, now, executionAttemptId, operationId);
      if (attemptUpdate.changes !== 1) {
        throw new Error("remote_runtime_reset_recovery_conflict");
      }

      const operationUpdate = this.database
        .prepare(
          `UPDATE remote_operations
           SET state='cancelled',diagnostic_code='runtime_binding_reset',
             diagnostic_message='Runtime reset removed remote ownership before Host dispatch.',
             updated_at=?,terminal_at=?
           WHERE id=? AND state='claimed' AND execution_attempt_id=? AND terminal_at IS NULL`
        )
        .run(now, now, operationId, executionAttemptId);
      if (operationUpdate.changes !== 1) {
        throw new Error("remote_runtime_reset_recovery_conflict");
      }

      this.appendEvent(operationId, executionAttemptId, "remote.attempt.cancelled", now);
      return this.getRequired(operationId);
    });
  }

  recordEnvelope(input: {
    operationId: string;
    digest: string;
    reference?: string;
  }): RemoteOperation {
    const digest = z
      .string()
      .regex(/^envelope:sha256:[a-f0-9]{64}$/)
      .parse(input.digest);
    const reference =
      input.reference === undefined ? undefined : boundedKeySchema.parse(input.reference);
    return inWriteTransaction(this.database, () => {
      const operation = this.getRequired(input.operationId);
      if (operation.envelopeDigest) {
        if (operation.envelopeDigest !== digest || operation.envelopeReference !== reference) {
          throw new Error("remote_operation_envelope_conflict");
        }
        return operation;
      }
      if (operation.state !== "preparing" && operation.state !== "claimed") {
        throw new Error("remote_operation_envelope_too_late");
      }
      const now = this.clock().toISOString();
      this.database
        .prepare(
          "UPDATE remote_operations SET envelope_digest=?,envelope_reference=?,updated_at=? WHERE id=?"
        )
        .run(digest, reference ?? null, now, operation.id);
      this.appendEvent(
        operation.id,
        operation.executionAttemptId,
        "remote.operation.envelope_recorded",
        now
      );
      return this.getRequired(operation.id);
    });
  }

  appendEvent(
    operationId: string,
    executionAttemptId: string | undefined,
    type: RemotePersistenceEventType,
    occurredAt = this.clock().toISOString()
  ): void {
    this.database
      .prepare(
        `INSERT INTO remote_operation_events(operation_id,execution_attempt_id,type,occurred_at)
         VALUES (?,?,?,?)`
      )
      .run(
        opaqueIdentifierSchema.parse(operationId),
        executionAttemptId ? executionAttemptIdSchema.parse(executionAttemptId) : null,
        remotePersistenceEventTypeSchema.parse(type),
        timestampSchema.parse(occurredAt)
      );
  }

  get(operationId: string): RemoteOperation | undefined {
    const row = this.database
      .prepare(`SELECT ${operationColumns} FROM remote_operations WHERE id=?`)
      .get(operationId);
    if (!row) return undefined;
    try {
      const parsed = operationRowSchema.parse(row);
      const requiredCapabilities = capabilitiesSchema.parse(
        JSON.parse(parsed.required_capabilities_json)
      );
      const attemptRow = this.database
        .prepare(
          `SELECT ${attemptColumns} FROM remote_execution_attempts
           WHERE operation_id=? AND execution_attempt_id=?`
        )
        .get(parsed.id, parsed.execution_attempt_id);
      if (!attemptRow) throw new Error("remote_execution_attempt_missing");
      const attempt = parseAttempt(attemptRow);
      if (
        attempt.executionAttemptId !== parsed.execution_attempt_id ||
        attempt.dispatchId !== parsed.dispatch_id ||
        attempt.workspaceId !== parsed.workspace_id ||
        attempt.projectId !== parsed.project_id ||
        attempt.canvasId !== parsed.canvas_id ||
        attempt.blockRef !== parsed.block_ref ||
        attempt.ownershipGeneration !== parsed.ownership_generation
      ) {
        throw new Error("remote_operation_attempt_identity_mismatch");
      }
      return {
        id: parsed.id,
        workspaceId: parsed.workspace_id,
        projectId: parsed.project_id,
        canvasId: parsed.canvas_id,
        blockRef: parsed.block_ref,
        ownershipGeneration: parsed.ownership_generation,
        idempotencyKey: parsed.idempotency_key,
        requestFingerprint: parsed.request_fingerprint,
        sourceFingerprint: parsed.source_fingerprint,
        requiredCapabilities,
        state: parsed.state,
        dispatchId: parsed.dispatch_id,
        executionAttemptId: parsed.execution_attempt_id,
        envelopeDigest: parsed.envelope_digest ?? undefined,
        envelopeReference: parsed.envelope_reference ?? undefined,
        hostSelection: parseHostSelection(parsed.host_selection_json),
        endpointSelection: parseEndpointSelection(
          parsed.endpoint_selection_json,
          parsed.workspace_id
        ),
        agentAccess: parseAgentAccess(parsed.agent_access_json),
        createdAt: parsed.created_at,
        updatedAt: parsed.updated_at,
        terminalAt: parsed.terminal_at ?? undefined,
        attempt
      };
    } catch (error) {
      throw new Error("remote_operation_row_invalid", { cause: error });
    }
  }

  getRequired(operationId: string): RemoteOperation {
    const operation = this.get(operationId);
    if (!operation) throw new Error("remote_operation_not_found");
    return operation;
  }

  observationRevision(operationId: string): number {
    const row = this.database
      .prepare("SELECT MAX(sequence) AS revision FROM remote_operation_events WHERE operation_id=?")
      .get(opaqueIdentifierSchema.parse(operationId));
    return z.number().int().positive().parse(row?.revision);
  }

  getInWorkspace(workspaceId: string, operationId: string): RemoteOperation | undefined {
    const row = this.database
      .prepare(`SELECT id FROM remote_operations WHERE workspace_id=? AND id=?`)
      .get(workspaceIdSchema.parse(workspaceId), opaqueIdentifierSchema.parse(operationId));
    return typeof row?.id === "string" ? this.getRequired(row.id) : undefined;
  }

  getRequiredInWorkspace(workspaceId: string, operationId: string): RemoteOperation {
    const operation = this.getInWorkspace(workspaceId, operationId);
    if (!operation) throw new Error("remote_operation_not_found");
    return operation;
  }

  findLatestByScope(rawScope: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    blockRef: string;
  }): RemoteOperation | undefined {
    const scope = remoteOperationScopeSchema.parse(rawScope);
    const row = this.database
      .prepare(
        `SELECT id FROM remote_operations
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=?
         ORDER BY created_at DESC,rowid DESC LIMIT 1`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, scope.blockRef);
    return typeof row?.id === "string" ? this.getRequired(row.id) : undefined;
  }

  findByOperationIdInScope(rawScope: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    blockRef: string;
    operationId: string;
  }): RemoteOperation | undefined {
    const scope = remoteOperationIdScopeSchema.parse(rawScope);
    const row = this.database
      .prepare(
        `SELECT id FROM remote_operations
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=? AND id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, scope.blockRef, scope.operationId);
    return typeof row?.id === "string" ? this.getRequired(row.id) : undefined;
  }

  getByDispatchId(dispatchId: string): RemoteOperation | undefined {
    const row = this.database
      .prepare("SELECT id FROM remote_operations WHERE dispatch_id=?")
      .get(dispatchId);
    return typeof row?.id === "string" ? this.getRequired(row.id) : undefined;
  }

  findByCallerIdentity(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    blockRef: string;
    idempotencyKey: string;
  }): RemoteOperation | undefined {
    const rows = this.database
      .prepare(
        `SELECT id FROM remote_operations
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=? AND idempotency_key=?
         ORDER BY created_at DESC,id DESC LIMIT 2`
      )
      .all(
        input.workspaceId,
        input.projectId,
        input.canvasId,
        input.blockRef,
        input.idempotencyKey
      );
    if (rows.length > 1) throw new Error("remote_operation_generation_ambiguous");
    const id = rows[0]?.id;
    return typeof id === "string" ? this.getRequired(id) : undefined;
  }

  listNonTerminal(): RemoteOperation[] {
    return this.database
      .prepare(
        `SELECT id FROM remote_operations
         WHERE state NOT IN ('completed','failed','cancelled') ORDER BY created_at,id`
      )
      .all()
      .map((row) => {
        if (typeof row.id !== "string") throw new Error("remote_operation_row_invalid");
        return this.getRequired(row.id);
      });
  }

  retryAttempt(input: {
    operationId: string;
    priorExecutionAttemptId: string;
    newDispatchId: string;
    newExecutionAttemptId: string;
    expectedAttemptVersion: number;
    /**
     * Revalidated Host selection for the new attempt. When provided, replaces the prior
     * attempt's host_selection_json so retry does not pin a stale assignment snapshot.
     * Omitted only when no assignment gate is wired.
     */
    hostSelection?: DispatchHostSelectionSnapshot;
    agentAccess?: PersistedRemoteAgentAccessSnapshot;
  }): RemoteOperation {
    const priorExecutionAttemptId = executionAttemptIdSchema.parse(input.priorExecutionAttemptId);
    const newDispatchId = dispatchIdSchema.parse(input.newDispatchId);
    const newExecutionAttemptId = executionAttemptIdSchema.parse(input.newExecutionAttemptId);
    const hostSelectionJson =
      input.hostSelection === undefined
        ? undefined
        : JSON.stringify(dispatchHostSelectionSnapshotSchema.parse(input.hostSelection));
    const agentAccessJson =
      input.agentAccess === undefined
        ? undefined
        : JSON.stringify(persistedRemoteAgentAccessSnapshotSchema.parse(input.agentAccess));
    if (priorExecutionAttemptId === newExecutionAttemptId) {
      throw new Error("remote_retry_attempt_identity_reused");
    }
    return inWriteTransaction(this.database, () => {
      const operation = this.getRequired(input.operationId);
      if (
        operation.dispatchId === newDispatchId &&
        operation.executionAttemptId === newExecutionAttemptId &&
        operation.attempt.status === "prepared"
      ) {
        const prior = this.database
          .prepare(
            "SELECT dispatch_id,status,state_version FROM remote_execution_attempts WHERE operation_id=? AND execution_attempt_id=?"
          )
          .get(operation.id, priorExecutionAttemptId);
        if (
          prior?.status === "superseded" &&
          prior.state_version === input.expectedAttemptVersion + 1
        ) {
          return operation;
        }
        throw new Error("remote_retry_attempt_version_conflict");
      }
      if (
        operation.executionAttemptId !== priorExecutionAttemptId ||
        operation.attempt.stateVersion !== input.expectedAttemptVersion
      ) {
        throw new Error("remote_retry_attempt_version_conflict");
      }
      if (
        operation.attempt.status !== "interrupted" &&
        operation.attempt.status !== "action_required"
      ) {
        throw new Error("remote_retry_attempt_not_interrupted");
      }
      if (!operation.attempt.leaseId) throw new Error("remote_retry_attempt_lease_missing");
      const reservation = this.database
        .prepare("SELECT status FROM host_capacity_reservations WHERE lease_id=?")
        .get(operation.attempt.leaseId);
      if (!reservation || reservation.status === "active") {
        throw new Error("remote_retry_attempt_not_fenced");
      }
      if (
        this.database
          .prepare("SELECT 1 FROM remote_execution_attempts WHERE execution_attempt_id=?")
          .get(newExecutionAttemptId)
      ) {
        throw new Error("remote_retry_attempt_identity_conflict");
      }
      const now = this.clock().toISOString();
      const superseded = this.database
        .prepare(
          `UPDATE remote_execution_attempts
           SET status='superseded',state_version=state_version+1,updated_at=?,terminal_at=?
           WHERE execution_attempt_id=? AND operation_id=? AND state_version=?
             AND status IN ('interrupted','action_required')`
        )
        .run(now, now, priorExecutionAttemptId, operation.id, input.expectedAttemptVersion);
      if (superseded.changes !== 1) throw new Error("remote_retry_attempt_version_conflict");
      this.database
        .prepare(
          `INSERT INTO remote_execution_attempts(
            execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,
            block_ref,ownership_generation,status,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,'prepared',?,?)`
        )
        .run(
          newExecutionAttemptId,
          operation.id,
          newDispatchId,
          operation.workspaceId,
          operation.projectId,
          operation.canvasId,
          operation.blockRef,
          operation.ownershipGeneration,
          now,
          now
        );
      if (hostSelectionJson !== undefined && agentAccessJson !== undefined) {
        this.database
          .prepare(
            `UPDATE remote_operations
             SET state='claimed',dispatch_id=?,execution_attempt_id=?,envelope_digest=NULL,
               envelope_reference=NULL,host_selection_json=?,agent_access_json=?,updated_at=?
             WHERE id=?`
          )
          .run(
            newDispatchId,
            newExecutionAttemptId,
            hostSelectionJson,
            agentAccessJson,
            now,
            operation.id
          );
      } else if (hostSelectionJson !== undefined) {
        this.database
          .prepare(
            `UPDATE remote_operations
             SET state='claimed',dispatch_id=?,execution_attempt_id=?,envelope_digest=NULL,
               envelope_reference=NULL,host_selection_json=?,updated_at=? WHERE id=?`
          )
          .run(newDispatchId, newExecutionAttemptId, hostSelectionJson, now, operation.id);
      } else if (agentAccessJson !== undefined) {
        this.database
          .prepare(
            `UPDATE remote_operations
             SET state='claimed',dispatch_id=?,execution_attempt_id=?,envelope_digest=NULL,
               envelope_reference=NULL,agent_access_json=?,updated_at=? WHERE id=?`
          )
          .run(newDispatchId, newExecutionAttemptId, agentAccessJson, now, operation.id);
      } else {
        this.database
          .prepare(
            `UPDATE remote_operations
             SET state='claimed',dispatch_id=?,execution_attempt_id=?,envelope_digest=NULL,
               envelope_reference=NULL,updated_at=? WHERE id=?`
          )
          .run(newDispatchId, newExecutionAttemptId, now, operation.id);
      }
      this.appendEvent(operation.id, priorExecutionAttemptId, "remote.attempt.superseded", now);
      this.appendEvent(operation.id, newExecutionAttemptId, "remote.attempt.retry_created", now);
      return this.getRequired(operation.id);
    });
  }

  /**
   * Persist (or replace) the Host selection fingerprint for a non-terminal operation.
   * Used by legacy pre-v18 recovery when host_selection_json is NULL, and by callers that
   * must not leave a configured gate without durable authorization evidence.
   */
  persistHostSelection(
    operationId: string,
    hostSelection: DispatchHostSelectionSnapshot
  ): RemoteOperation {
    const json = JSON.stringify(dispatchHostSelectionSnapshotSchema.parse(hostSelection));
    return inWriteTransaction(this.database, () => {
      const operation = this.getRequired(operationId);
      if (["completed", "failed", "cancelled"].includes(operation.state)) {
        throw new Error("remote_operation_not_actionable");
      }
      if (operation.hostSelection) {
        // Already durable — do not overwrite during same-attempt reenter recovery.
        // Explicit retry writes via retryAttempt instead.
        return operation;
      }
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE remote_operations SET host_selection_json=?,updated_at=?
           WHERE id=? AND host_selection_json IS NULL
             AND state NOT IN ('completed','failed','cancelled')`
        )
        .run(json, now, operation.id);
      if (updated.changes !== 1) {
        // Concurrent fill won — reload.
        return this.getRequired(operation.id);
      }
      return this.getRequired(operation.id);
    });
  }

  isRetryApplied(input: {
    operationId: string;
    priorExecutionAttemptId: string;
    newDispatchId: string;
    newExecutionAttemptId: string;
    expectedAttemptVersion: number;
  }): boolean {
    const operation = this.getRequired(input.operationId);
    if (
      operation.dispatchId !== input.newDispatchId ||
      operation.executionAttemptId !== input.newExecutionAttemptId
    ) {
      return false;
    }
    const prior = this.database
      .prepare(
        "SELECT status,state_version FROM remote_execution_attempts WHERE operation_id=? AND execution_attempt_id=?"
      )
      .get(operation.id, input.priorExecutionAttemptId);
    return (
      prior?.status === "superseded" && prior.state_version === input.expectedAttemptVersion + 1
    );
  }

  markActionRequired(input: {
    operationId: string;
    executionAttemptId: string;
    expectedAttemptVersion: number;
  }): RemoteOperation {
    return inWriteTransaction(this.database, () => {
      const operation = this.getRequired(input.operationId);
      if (
        operation.executionAttemptId !== input.executionAttemptId ||
        operation.attempt.status !== "interrupted" ||
        operation.attempt.stateVersion !== input.expectedAttemptVersion
      ) {
        throw new Error("remote_action_required_attempt_conflict");
      }
      const reservation = operation.attempt.leaseId
        ? this.database
            .prepare("SELECT status FROM host_capacity_reservations WHERE lease_id=?")
            .get(operation.attempt.leaseId)
        : undefined;
      if (!reservation || reservation.status === "active") {
        throw new Error("remote_action_required_attempt_not_fenced");
      }
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_attempts
           SET status='action_required',state_version=state_version+1,updated_at=?
           WHERE execution_attempt_id=? AND status='interrupted' AND state_version=?`
        )
        .run(now, operation.executionAttemptId, input.expectedAttemptVersion);
      if (updated.changes !== 1) throw new Error("remote_action_required_attempt_conflict");
      this.database
        .prepare("UPDATE remote_operations SET state='action_required',updated_at=? WHERE id=?")
        .run(now, operation.id);
      this.appendEvent(
        operation.id,
        operation.executionAttemptId,
        "remote.attempt.action_required",
        now
      );
      return this.getRequired(operation.id);
    });
  }

  recordDiagnostic(operationId: string, code: string, message: string): void {
    const parsedCode = opaqueIdentifierSchema.parse(code);
    const parsedMessage = z.string().min(1).max(4_096).parse(message);
    const updated = this.database
      .prepare(
        `UPDATE remote_operations SET diagnostic_code=?,diagnostic_message=?,updated_at=?
         WHERE id=? AND state NOT IN ('completed','failed','cancelled')`
      )
      .run(parsedCode, parsedMessage, this.clock().toISOString(), operationId);
    if (updated.changes !== 1) throw new Error("remote_operation_not_actionable");
  }

  clearDiagnostic(operationId: string): void {
    const updated = this.database
      .prepare(
        `UPDATE remote_operations SET diagnostic_code=NULL,diagnostic_message=NULL,updated_at=?
         WHERE id=? AND state NOT IN ('completed','failed','cancelled')`
      )
      .run(this.clock().toISOString(), operationId);
    if (updated.changes !== 1) throw new Error("remote_operation_not_actionable");
  }

  private findByKey(input: CreateRemoteOperationInput): RemoteOperation | undefined {
    const row = this.database
      .prepare(
        `SELECT id FROM remote_operations
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=? AND ownership_generation=?
           AND idempotency_key=?`
      )
      .get(
        input.workspaceId,
        input.projectId,
        input.canvasId,
        input.blockRef,
        input.ownershipGeneration,
        input.idempotencyKey
      );
    return row ? this.getRequired(String(row.id)) : undefined;
  }
}

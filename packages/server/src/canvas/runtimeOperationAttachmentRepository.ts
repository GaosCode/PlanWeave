import { leaseIdSchema, opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import type { AgentHostRepository } from "../hosts.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import type { RuntimeContentTargetAuthorityPort } from "./runtimeContentTargetPort.js";

const attachmentInputSchema = canvasScopeRefSchema.extend({
  operationId: opaqueIdentifierSchema,
  executionAttemptId: opaqueIdentifierSchema,
  hostId: opaqueIdentifierSchema,
  reservationLeaseId: leaseIdSchema,
  contentRevision: z.number().int().nonnegative(),
  graphFingerprint: z.string().trim().min(1)
});

export type CanvasRuntimeOperationAttachmentInput = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
  operationId: string;
  executionAttemptId: string;
  hostId: string;
  reservationLeaseId: string;
  contentRevision: number;
  graphFingerprint: string;
};

export type CanvasRuntimeOperationAttachment = CanvasRuntimeOperationAttachmentInput & {
  hostGeneration: string;
  attachedAt: string;
};

type AttachmentRow = {
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  operation_id: string;
  execution_attempt_id: string;
  host_id: string;
  host_generation: string;
  content_revision: number;
  graph_fingerprint: string;
  reservation_lease_id: string;
  attached_at: string;
};

const selectColumns = `workspace_id,project_id,canvas_id,operation_id,execution_attempt_id,
  host_id,host_generation,content_revision,graph_fingerprint,reservation_lease_id,attached_at`;

function toAttachment(row: AttachmentRow): CanvasRuntimeOperationAttachment {
  return {
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    operationId: row.operation_id,
    executionAttemptId: row.execution_attempt_id,
    hostId: row.host_id,
    hostGeneration: row.host_generation,
    contentRevision: Number(row.content_revision),
    graphFingerprint: row.graph_fingerprint,
    reservationLeaseId: row.reservation_lease_id,
    attachedAt: row.attached_at
  };
}

type AttemptAuthorityRow = {
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  operation_id: string;
  current_execution_attempt_id: string;
  execution_attempt_id: string;
  attempt_host_id: string;
  attempt_lease_id: string;
  source_fingerprint: string;
  reservation_host_id: string;
  reservation_status: string;
  reservation_lease_expires_at: string;
};

export class CanvasRuntimeOperationAttachmentRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly hosts: AgentHostRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly contentTargets?: RuntimeContentTargetAuthorityPort
  ) {}

  record(rawInput: CanvasRuntimeOperationAttachmentInput): CanvasRuntimeOperationAttachment {
    const input = attachmentInputSchema.parse(rawInput);
    return inWriteTransaction(this.database, () => {
      const authority = this.database
        .prepare(
          `SELECT operation.workspace_id,operation.project_id,operation.canvas_id,
             operation.id AS operation_id,
             operation.execution_attempt_id AS current_execution_attempt_id,
             attempt.execution_attempt_id,attempt.host_id AS attempt_host_id,
             attempt.lease_id AS attempt_lease_id,operation.source_fingerprint,
             reservation.host_id AS reservation_host_id,
             reservation.status AS reservation_status,
             reservation.lease_expires_at AS reservation_lease_expires_at
           FROM remote_execution_attempts attempt
           JOIN remote_operations operation ON operation.id=attempt.operation_id
           JOIN host_capacity_reservations reservation
             ON reservation.execution_attempt_id=attempt.execution_attempt_id
            AND reservation.lease_id=attempt.lease_id
           WHERE attempt.execution_attempt_id=?`
        )
        .get(input.executionAttemptId) as AttemptAuthorityRow | undefined;
      if (
        !authority ||
        authority.operation_id !== input.operationId ||
        authority.current_execution_attempt_id !== input.executionAttemptId ||
        authority.workspace_id !== input.workspaceId ||
        authority.project_id !== input.projectId ||
        authority.canvas_id !== input.canvasId ||
        authority.attempt_host_id !== input.hostId ||
        authority.reservation_host_id !== input.hostId ||
        authority.attempt_lease_id !== input.reservationLeaseId
      ) {
        throw new Error("canvas_runtime_attachment_attempt_scope_conflict");
      }
      if (authority.reservation_status !== "active") {
        throw new Error("canvas_runtime_attachment_reservation_inactive");
      }
      if (authority.reservation_lease_expires_at <= this.clock().toISOString()) {
        throw new Error("canvas_runtime_attachment_reservation_expired");
      }
      if (authority.source_fingerprint !== input.graphFingerprint) {
        throw new Error("canvas_runtime_attachment_graph_fingerprint_conflict");
      }
      const currentTarget = this.contentTargets?.read(input);
      if (!currentTarget) throw new Error("runtime_content_target_port_missing");
      if (
        currentTarget.revision !== input.contentRevision ||
        currentTarget.graphFingerprint !== input.graphFingerprint
      ) {
        throw new Error("canvas_runtime_attachment_content_target_changed");
      }
      const host = this.hosts.getRequired(input.hostId);
      if (host.revokedAt !== undefined) throw new Error("canvas_runtime_attachment_host_revoked");
      const hostGeneration = host.id;
      const attachedAt = this.clock().toISOString();
      const existing = this.database
        .prepare(
          `SELECT ${selectColumns} FROM canvas_runtime_operation_attachments
           WHERE operation_id=? AND execution_attempt_id=?`
        )
        .get(input.operationId, input.executionAttemptId) as AttachmentRow | undefined;
      if (existing) {
        const attachment = toAttachment(existing);
        if (
          attachment.workspaceId !== input.workspaceId ||
          attachment.projectId !== input.projectId ||
          attachment.canvasId !== input.canvasId ||
          attachment.hostId !== input.hostId ||
          attachment.hostGeneration !== hostGeneration ||
          attachment.contentRevision !== input.contentRevision ||
          attachment.graphFingerprint !== input.graphFingerprint ||
          attachment.reservationLeaseId !== input.reservationLeaseId
        ) {
          throw new Error("canvas_runtime_attachment_idempotency_conflict");
        }
        return attachment;
      }
      this.database
        .prepare(
          `INSERT INTO canvas_runtime_operation_attachments(
             workspace_id,project_id,canvas_id,operation_id,execution_attempt_id,
             host_id,host_generation,content_revision,graph_fingerprint,
             reservation_lease_id,attached_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          input.workspaceId,
          input.projectId,
          input.canvasId,
          input.operationId,
          input.executionAttemptId,
          input.hostId,
          hostGeneration,
          input.contentRevision,
          input.graphFingerprint,
          input.reservationLeaseId,
          attachedAt
        );
      const row = this.database
        .prepare(
          `SELECT ${selectColumns} FROM canvas_runtime_operation_attachments
           WHERE operation_id=? AND execution_attempt_id=?`
        )
        .get(input.operationId, input.executionAttemptId) as AttachmentRow | undefined;
      if (!row) throw new Error("canvas_runtime_attachment_missing_after_write");
      return toAttachment(row);
    });
  }

  get(
    operationIdInput: string,
    executionAttemptIdInput: string
  ): CanvasRuntimeOperationAttachment | undefined {
    const operationId = opaqueIdentifierSchema.parse(operationIdInput);
    const executionAttemptId = opaqueIdentifierSchema.parse(executionAttemptIdInput);
    const row = this.database
      .prepare(
        `SELECT ${selectColumns} FROM canvas_runtime_operation_attachments
         WHERE operation_id=? AND execution_attempt_id=?`
      )
      .get(operationId, executionAttemptId) as AttachmentRow | undefined;
    return row ? toAttachment(row) : undefined;
  }

  listForOperation(operationIdInput: string): CanvasRuntimeOperationAttachment[] {
    const operationId = opaqueIdentifierSchema.parse(operationIdInput);
    return (
      this.database
        .prepare(
          `SELECT ${selectColumns} FROM canvas_runtime_operation_attachments
           WHERE operation_id=? ORDER BY attached_at,execution_attempt_id`
        )
        .all(operationId) as AttachmentRow[]
    ).map(toAttachment);
  }

  listProject(input: {
    workspaceId: string;
    projectId: string;
  }): CanvasRuntimeOperationAttachment[] {
    const workspaceId = opaqueIdentifierSchema.parse(input.workspaceId);
    const projectId = opaqueIdentifierSchema.parse(input.projectId);
    return (
      this.database
        .prepare(
          `SELECT ${selectColumns} FROM canvas_runtime_operation_attachments
           WHERE workspace_id=? AND project_id=?
           ORDER BY attached_at,canvas_id,operation_id,execution_attempt_id`
        )
        .all(workspaceId, projectId) as AttachmentRow[]
    ).map(toAttachment);
  }
}

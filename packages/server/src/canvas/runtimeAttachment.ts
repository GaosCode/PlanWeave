import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  canvasScopeRefSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { SqliteDatabase } from "../sqlite.js";
import type { RuntimeCanvasScope } from "./executionRuntimePort.js";
import type { CanvasRuntimeOperationAttachmentRepository } from "./runtimeOperationAttachmentRepository.js";

/** Distinct from Reset: an active Runtime or capacity lease fences Host attachment. */
export class CanvasRuntimeAttachmentConflictError extends Error {
  constructor(readonly code: "active_lease") {
    super(`canvas_runtime_attachment_${code}`);
    this.name = "CanvasRuntimeAttachmentConflictError";
  }
}

export type RuntimeAttachmentRequest = RuntimeCanvasScope & {
  hostId: string;
  operationId: string;
  executionAttemptId: string;
  reservationLeaseId: string;
  contentRevision: number;
  graphFingerprint: string;
};

export type RuntimeAttachmentOrchestratorOptions = {
  attachments: CanvasRuntimeOperationAttachmentRepository;
  database: SqliteDatabase;
  clock?: () => Date;
};

function conflictingLeaseHostId(
  database: SqliteDatabase,
  scope: RuntimeCanvasScope,
  reservedHostId: string,
  operationId: string,
  nowIso: string
): string | undefined {
  const runtimeLease = database
    .prepare(
      `SELECT host_id FROM canvas_runtime_leases
       WHERE workspace_id=? AND project_id=?
         AND status='active' AND expires_at>? AND host_id!=?
       LIMIT 1`
    )
    .get(scope.workspaceId, scope.projectId, nowIso, reservedHostId) as
    | { host_id: string }
    | undefined;
  if (runtimeLease) return runtimeLease.host_id;

  const reservation = database
    .prepare(
      `SELECT r.host_id AS host_id
       FROM host_capacity_reservations r
       JOIN remote_execution_attempts a
         ON a.execution_attempt_id=r.execution_attempt_id
       JOIN remote_operations o ON o.id=a.operation_id
       WHERE o.workspace_id=? AND o.project_id=?
         AND r.status='active' AND r.host_id!=?
         AND o.id!=?
       LIMIT 1`
    )
    .get(scope.workspaceId, scope.projectId, reservedHostId, operationId) as
    | { host_id: string }
    | undefined;
  return reservation?.host_id;
}

/**
 * Server-internal Canvas Runtime routing after an authorized operation is accepted.
 * Not Agent grant and not a user-facing Host binding product.
 */
export function ensureRuntimeAttachmentForOperation(
  options: RuntimeAttachmentOrchestratorOptions,
  request: RuntimeAttachmentRequest
): void {
  const scope = canvasScopeRefSchema.parse({
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    canvasId: request.canvasId
  });
  const hostId = opaqueIdentifierSchema.parse(request.hostId);
  workspaceIdSchema.parse(scope.workspaceId);
  const nowIso = (options.clock ?? (() => new Date()))().toISOString();
  const conflictHostId = conflictingLeaseHostId(
    options.database,
    scope,
    hostId,
    request.operationId,
    nowIso
  );
  if (conflictHostId) {
    throw new CanvasRuntimeAttachmentConflictError("active_lease");
  }
  options.attachments.record({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    canvasId: scope.canvasId,
    hostId,
    operationId: request.operationId,
    executionAttemptId: request.executionAttemptId,
    reservationLeaseId: request.reservationLeaseId,
    contentRevision: request.contentRevision,
    graphFingerprint: request.graphFingerprint
  });
}

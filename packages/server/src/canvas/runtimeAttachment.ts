import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import {
  canvasScopeRefSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { SqliteDatabase } from "../sqlite.js";
import type { CanvasRuntimeHostBindingRepository } from "./runtimeHostLocator.js";
import type { RuntimeCanvasScope } from "./executionRuntimePort.js";

/** Distinct from Reset: an active Runtime or capacity lease fences Host attachment. */
export class CanvasRuntimeAttachmentConflictError extends Error {
  constructor(readonly code: "active_lease") {
    super(`canvas_runtime_attachment_${code}`);
    this.name = "CanvasRuntimeAttachmentConflictError";
  }
}

export type RuntimeAttachmentRequest = RuntimeCanvasScope & {
  hostId: string;
  /** Ignored when the Host row exists; attachment stores `agent_hosts.id`. */
  hostGeneration?: string;
  operationId?: string;
  executionAttemptId?: string;
  reservationLeaseId?: string;
  contentRevision?: number;
  graphFingerprint?: string;
};

/** `agent_hosts.id` is the current execution generation of one installation. */
function hostExecutionGenerationId(database: SqliteDatabase, hostId: string): string {
  const row = database
    .prepare("SELECT id FROM agent_hosts WHERE id=? AND revoked_at IS NULL")
    .get(hostId) as { id: string } | undefined;
  if (!row) throw new Error("agent_host_not_found");
  return opaqueIdentifierSchema.parse(row.id);
}

export type RuntimeAttachmentOrchestratorOptions = {
  bindings: CanvasRuntimeHostBindingRepository;
  database: SqliteDatabase;
  clock?: () => Date;
};

function conflictingLeaseHostId(
  database: SqliteDatabase,
  scope: RuntimeCanvasScope,
  reservedHostId: string,
  operationId: string | undefined,
  nowIso: string
): string | undefined {
  const runtimeLease = database
    .prepare(
      `SELECT host_id FROM canvas_runtime_leases
       WHERE workspace_id=? AND project_id=? AND canvas_id=?
         AND status='active' AND expires_at>? AND host_id!=?
       LIMIT 1`
    )
    .get(scope.workspaceId, scope.projectId, scope.canvasId, nowIso, reservedHostId) as
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
       WHERE o.workspace_id=? AND o.project_id=? AND o.canvas_id=?
         AND r.status='active' AND r.host_id!=?
         AND (? IS NULL OR o.id!=?)
       LIMIT 1`
    )
    .get(
      scope.workspaceId,
      scope.projectId,
      scope.canvasId,
      reservedHostId,
      operationId ?? null,
      operationId ?? null
    ) as { host_id: string } | undefined;
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
  const hostGeneration = hostExecutionGenerationId(options.database, hostId);
  workspaceIdSchema.parse(scope.workspaceId);
  if (!request.operationId || !request.executionAttemptId) {
    throw new Error("canvas_runtime_attachment_requires_accepted_operation");
  }
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
  options.bindings.upsertOperationAttachment({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    hostId,
    hostGeneration,
    ...(request.operationId ? { operationId: request.operationId } : {}),
    ...(request.executionAttemptId ? { executionAttemptId: request.executionAttemptId } : {}),
    ...(request.contentRevision !== undefined ? { contentRevision: request.contentRevision } : {}),
    ...(request.graphFingerprint ? { graphFingerprint: request.graphFingerprint } : {})
  });
}

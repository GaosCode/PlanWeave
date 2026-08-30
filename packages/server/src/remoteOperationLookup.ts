import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import type { RemoteOperation } from "./remoteOperations.js";
import type { SqliteDatabase } from "./sqlite.js";

export const remoteOperationIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: persisted keys reject C0 controls and DEL.
  .regex(/^[^\u0000-\u001f\u007f]+$/);

export const remoteOperationBlockRefSchema = z
  .string()
  .min(3)
  .max(257)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*#[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const remoteOperationScopeSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: remoteOperationBlockRefSchema
  })
  .strict();

const remoteOperationIdScopeSchema = remoteOperationScopeSchema.extend({
  operationId: opaqueIdentifierSchema
});

export type RemoteOperationScope = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
  blockRef: string;
};
export type RemoteOperationIdScope = RemoteOperationScope & { operationId: string };
export type RemoteOperationIdempotencyScope = RemoteOperationScope & { idempotencyKey: string };

type ReadRequiredOperation = (operationId: string) => RemoteOperation;

export class RemoteOperationLookupConflictError extends Error {
  readonly code = "remote_operation_generation_ambiguous";

  constructor() {
    super("remote_operation_generation_ambiguous");
    this.name = "RemoteOperationLookupConflictError";
  }
}

function readSelected(
  row: Record<string, unknown> | undefined,
  readRequired: ReadRequiredOperation
): RemoteOperation | undefined {
  return typeof row?.id === "string" ? readRequired(row.id) : undefined;
}

export function getRemoteOperationInWorkspace(
  database: SqliteDatabase,
  workspaceId: string,
  operationId: string,
  readRequired: ReadRequiredOperation
): RemoteOperation | undefined {
  const row = database
    .prepare("SELECT id FROM remote_operations WHERE workspace_id=? AND id=?")
    .get(workspaceIdSchema.parse(workspaceId), opaqueIdentifierSchema.parse(operationId));
  return readSelected(row, readRequired);
}

export function findLatestRemoteOperationByScope(
  database: SqliteDatabase,
  rawScope: RemoteOperationScope,
  readRequired: ReadRequiredOperation
): RemoteOperation | undefined {
  const scope = remoteOperationScopeSchema.parse(rawScope);
  const row = database
    .prepare(
      `SELECT id FROM remote_operations
       WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=?
       ORDER BY created_at DESC,rowid DESC LIMIT 1`
    )
    .get(scope.workspaceId, scope.projectId, scope.canvasId, scope.blockRef);
  return readSelected(row, readRequired);
}

export function findRemoteOperationByIdInScope(
  database: SqliteDatabase,
  rawScope: RemoteOperationIdScope,
  readRequired: ReadRequiredOperation
): RemoteOperation | undefined {
  const scope = remoteOperationIdScopeSchema.parse(rawScope);
  const row = database
    .prepare(
      `SELECT id FROM remote_operations
       WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=? AND id=?`
    )
    .get(scope.workspaceId, scope.projectId, scope.canvasId, scope.blockRef, scope.operationId);
  return readSelected(row, readRequired);
}

export function findRemoteOperationByIdempotencyKeyInScope(
  database: SqliteDatabase,
  rawScope: RemoteOperationIdempotencyScope,
  readRequired: ReadRequiredOperation
): RemoteOperation | undefined {
  const scope = remoteOperationScopeSchema.parse({
    workspaceId: rawScope.workspaceId,
    projectId: rawScope.projectId,
    canvasId: rawScope.canvasId,
    blockRef: rawScope.blockRef
  });
  const idempotencyKey = remoteOperationIdempotencyKeySchema.parse(rawScope.idempotencyKey);
  const rows = database
    .prepare(
      `SELECT id FROM remote_operations
       WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=? AND idempotency_key=?
       ORDER BY created_at DESC,id DESC LIMIT 2`
    )
    .all(scope.workspaceId, scope.projectId, scope.canvasId, scope.blockRef, idempotencyKey);
  if (rows.length > 1) throw new RemoteOperationLookupConflictError();
  return readSelected(rows[0], readRequired);
}

export function getRemoteOperationByDispatchId(
  database: SqliteDatabase,
  dispatchId: string,
  readRequired: ReadRequiredOperation
): RemoteOperation | undefined {
  const row = database
    .prepare("SELECT id FROM remote_operations WHERE dispatch_id=?")
    .get(dispatchId);
  return readSelected(row, readRequired);
}

export function findRemoteOperationByCallerIdentity(
  database: SqliteDatabase,
  input: RemoteOperationIdempotencyScope,
  readRequired: ReadRequiredOperation
): RemoteOperation | undefined {
  const scope = remoteOperationScopeSchema.parse({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    canvasId: input.canvasId,
    blockRef: input.blockRef
  });
  const idempotencyKey = remoteOperationIdempotencyKeySchema.parse(input.idempotencyKey);
  const rows = database
    .prepare(
      `SELECT id FROM remote_operations
       WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=? AND idempotency_key=?
       ORDER BY created_at DESC,id DESC LIMIT 2`
    )
    .all(scope.workspaceId, scope.projectId, scope.canvasId, scope.blockRef, idempotencyKey);
  if (rows.length > 1) throw new RemoteOperationLookupConflictError();
  return readSelected(rows[0], readRequired);
}

export function listNonTerminalRemoteOperations(
  database: SqliteDatabase,
  readRequired: ReadRequiredOperation
): RemoteOperation[] {
  return database
    .prepare(
      `SELECT id FROM remote_operations
       WHERE state NOT IN ('completed','failed','cancelled') ORDER BY created_at,id`
    )
    .all()
    .map((row) => {
      if (typeof row.id !== "string") throw new Error("remote_operation_row_invalid");
      return readRequired(row.id);
    });
}

import {
  executionTargetRecordSchema,
  type ExecutionTargetRecord
} from "@planweave-ai/collaboration-protocol/work/execution-target";
import {
  responsibilityRecordSchema,
  type ResponsibilityRecord
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import {
  reviewAssignmentRecordSchema,
  type ReviewAssignmentRecord
} from "@planweave-ai/collaboration-protocol/work/review";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { HumanPrincipalIdentity } from "../identity/humanPrincipalIdentity.js";
import {
  authorityScopeSchema,
  scopeKey,
  type AuthorityActor,
  type AuthorityScope,
  type ExecutionTargetMutation,
  type ResponsibilityMutation,
  type ReviewerMutation,
  authorityRevisionSnapshotSchema,
  type AuthorityRevisionSnapshot
} from "./authoritySchemas.js";

type ScopeColumns = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
  scopeKind: "task" | "block";
  scopeKey: string;
};

function scopeColumns(rawScope: unknown): ScopeColumns {
  const scope = authorityScopeSchema.parse(rawScope);
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    canvasId: scope.canvasId,
    scopeKind: scope.kind,
    scopeKey: scopeKey(scope)
  };
}

function scopeFromColumns(row: Record<string, unknown>): AuthorityScope {
  if (row.scope_kind === "task") {
    return authorityScopeSchema.parse({
      kind: "task",
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      taskId: row.scope_key
    });
  }
  return authorityScopeSchema.parse({
    kind: "block",
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    blockRef: row.scope_key
  });
}

function actorColumns(actor: AuthorityActor): [string, string] {
  return [actor.kind, actor.id];
}

type GenericRow = Record<string, unknown> & {
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  scope_kind: string;
  scope_key: string;
  principal_id: string | null;
  revision: number;
  updated_at: string;
};
type ExecutionTargetRow = Record<string, unknown> & {
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  block_ref: string;
  target_kind: string;
  host_id: string | null;
  revision: number;
  updated_at: string;
};

export type AuthorityRepositoryOptions = { clock?: () => Date };

/** Durable storage for the three independent OSS-003 authorities. */
export class AuthorityRepository {
  private readonly clock: () => Date;

  constructor(
    private readonly database: SqliteDatabase,
    options: AuthorityRepositoryOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  getResponsibility(scopeInput: unknown): ResponsibilityRecord | undefined {
    const scope = scopeColumns(scopeInput);
    const row = this.database
      .prepare(
        `SELECT * FROM responsibility_records
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND scope_kind=? AND scope_key=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, scope.scopeKind, scope.scopeKey) as
      | GenericRow
      | undefined;
    return row
      ? responsibilityRecordSchema.parse(this.toHumanRecord(row, "responsibility"))
      : undefined;
  }

  getReviewer(scopeInput: unknown): ReviewAssignmentRecord | undefined {
    const scope = scopeColumns(scopeInput);
    const row = this.database
      .prepare(
        `SELECT * FROM review_assignment_records
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND scope_kind=? AND scope_key=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, scope.scopeKind, scope.scopeKey) as
      | GenericRow
      | undefined;
    return row
      ? reviewAssignmentRecordSchema.parse(this.toHumanRecord(row, "reviewer"))
      : undefined;
  }

  getExecutionTarget(scopeInput: unknown): ExecutionTargetRecord | undefined {
    const scope = scopeColumns(scopeInput);
    if (scope.scopeKind !== "block") throw new Error("execution_target_requires_exact_block_scope");
    const row = this.database
      .prepare(
        `SELECT * FROM execution_target_records
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, scope.scopeKey) as
      | ExecutionTargetRow
      | undefined;
    if (!row) return undefined;
    const target =
      row.target_kind === "exact_host"
        ? { kind: "exact_host" as const, hostId: row.host_id }
        : row.target_kind === "automatic_host"
          ? { kind: "automatic_host" as const }
          : { kind: "unassigned" as const };
    return executionTargetRecordSchema.parse({
      schemaVersion: "execution-target/v1",
      scope: authorityScopeSchema.parse({
        kind: "block",
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        blockRef: row.block_ref
      }),
      target,
      revision: Number(row.revision),
      updatedAt: row.updated_at
    });
  }

  currentRevisions(scopeInput: unknown): AuthorityRevisionSnapshot {
    const scope = authorityScopeSchema.parse(scopeInput);
    const responsibility = this.getResponsibility(scope)?.revision ?? 0;
    const reviewer = this.getReviewer(scope)?.revision ?? 0;
    const executionTarget =
      scope.kind === "block" ? (this.getExecutionTarget(scope)?.revision ?? 0) : 0;
    return authorityRevisionSnapshotSchema.parse({
      responsibilityRevision: responsibility,
      reviewerRevision: reviewer,
      executionTargetRevision: executionTarget
    });
  }

  applyResponsibility(input: {
    mutation: ResponsibilityMutation;
    actor: AuthorityActor;
  }): ResponsibilityRecord {
    const mutation = input.mutation;
    const scope = scopeColumns(mutation.scope);
    const principal = mutation.principal
      ? {
          kind: "human" as const,
          humanPrincipalId: new HumanPrincipalIdentity(this.database).canonicalizeTarget(
            mutation.principal.humanPrincipalId
          )
        }
      : null;
    let nextRevision = 0;
    const [updatedByKind, updatedById] = actorColumns(input.actor);
    const at = this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      nextRevision = this.casRevision(
        "responsibility_records",
        scope,
        mutation.expectedRevision,
        input.actor
      );
      this.database
        .prepare(
          `INSERT INTO responsibility_records(workspace_id,project_id,canvas_id,scope_kind,scope_key,principal_id,revision,updated_by_kind,updated_by_id,updated_at)
           VALUES(?,?,?,?,?,?, ?,?,?,?)
           ON CONFLICT(workspace_id,project_id,canvas_id,scope_kind,scope_key) DO UPDATE SET principal_id=excluded.principal_id,revision=excluded.revision,updated_by_kind=excluded.updated_by_kind,updated_by_id=excluded.updated_by_id,updated_at=excluded.updated_at`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          scope.scopeKind,
          scope.scopeKey,
          principal?.humanPrincipalId ?? null,
          nextRevision,
          updatedByKind,
          updatedById,
          at
        );
    });
    return responsibilityRecordSchema.parse({
      schemaVersion: "responsibility/v1",
      scope: mutation.scope,
      principal,
      revision: nextRevision,
      updatedAt: at
    });
  }

  applyReviewer(input: {
    mutation: ReviewerMutation;
    actor: AuthorityActor;
  }): ReviewAssignmentRecord {
    const mutation = input.mutation;
    const scope = scopeColumns(mutation.scope);
    const principal = mutation.principal
      ? {
          kind: "human" as const,
          humanPrincipalId: new HumanPrincipalIdentity(this.database).canonicalizeTarget(
            mutation.principal.humanPrincipalId
          )
        }
      : null;
    let nextRevision = 0;
    const [updatedByKind, updatedById] = actorColumns(input.actor);
    const at = this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      nextRevision = this.casRevision(
        "review_assignment_records",
        scope,
        mutation.expectedRevision,
        input.actor
      );
      this.database
        .prepare(
          `INSERT INTO review_assignment_records(workspace_id,project_id,canvas_id,scope_kind,scope_key,principal_id,revision,updated_by_kind,updated_by_id,updated_at)
           VALUES(?,?,?,?,?,?, ?,?,?,?)
           ON CONFLICT(workspace_id,project_id,canvas_id,scope_kind,scope_key) DO UPDATE SET principal_id=excluded.principal_id,revision=excluded.revision,updated_by_kind=excluded.updated_by_kind,updated_by_id=excluded.updated_by_id,updated_at=excluded.updated_at`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          scope.scopeKind,
          scope.scopeKey,
          principal?.humanPrincipalId ?? null,
          nextRevision,
          updatedByKind,
          updatedById,
          at
        );
    });
    return reviewAssignmentRecordSchema.parse({
      schemaVersion: "review-assignment/v1",
      scope: mutation.scope,
      principal,
      revision: nextRevision,
      updatedAt: at
    });
  }

  applyExecutionTarget(input: {
    mutation: ExecutionTargetMutation;
    actor: AuthorityActor;
  }): ExecutionTargetRecord {
    const mutation = input.mutation;
    const scope = scopeColumns(mutation.scope);
    if (scope.scopeKind !== "block") throw new Error("execution_target_requires_exact_block_scope");
    let nextRevision = 0;
    const [updatedByKind, updatedById] = actorColumns(input.actor);
    const at = this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      nextRevision = this.casRevision(
        "execution_target_records",
        scope,
        mutation.expectedRevision,
        input.actor
      );
      this.database
        .prepare(
          `INSERT INTO execution_target_records(workspace_id,project_id,canvas_id,block_ref,target_kind,host_id,revision,updated_by_kind,updated_by_id,updated_at)
           VALUES(?,?,?,?,?,?, ?,?,?,?)
           ON CONFLICT(workspace_id,project_id,canvas_id,block_ref) DO UPDATE SET target_kind=excluded.target_kind,host_id=excluded.host_id,revision=excluded.revision,updated_by_kind=excluded.updated_by_kind,updated_by_id=excluded.updated_by_id,updated_at=excluded.updated_at`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          scope.scopeKey,
          mutation.target.kind,
          mutation.target.kind === "exact_host" ? mutation.target.hostId : null,
          nextRevision,
          updatedByKind,
          updatedById,
          at
        );
    });
    return executionTargetRecordSchema.parse({
      schemaVersion: "execution-target/v1",
      scope: mutation.scope,
      target: mutation.target,
      revision: nextRevision,
      updatedAt: at
    });
  }

  migrationState(
    workspaceId: string,
    projectId: string
  ):
    | {
        marker: string;
        status: string;
        authoritativeReadVersion: string;
        failureCode: string | null;
      }
    | undefined {
    const row = this.database
      .prepare(
        "SELECT marker,status,authoritative_read_version,failure_code FROM assignment_authority_migrations WHERE workspace_id=? AND project_id=?"
      )
      .get(workspaceId, projectId) as Record<string, unknown> | undefined;
    return row
      ? {
          marker: String(row.marker),
          status: String(row.status),
          authoritativeReadVersion: String(row.authoritative_read_version),
          failureCode: row.failure_code === null ? null : String(row.failure_code)
        }
      : undefined;
  }

  private casRevision(
    table: string,
    scope: ScopeColumns,
    expectedRevision: number,
    actor: AuthorityActor
  ): number {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("authority_input_invalid");
    const existing = this.database
      .prepare(
        `SELECT revision FROM ${table} WHERE workspace_id=? AND project_id=? AND canvas_id=? AND ${table === "execution_target_records" ? "block_ref" : "scope_kind=? AND scope_key"}=?`
      )
      .get(
        ...(table === "execution_target_records"
          ? [scope.workspaceId, scope.projectId, scope.canvasId, scope.scopeKey]
          : [scope.workspaceId, scope.projectId, scope.canvasId, scope.scopeKind, scope.scopeKey])
      ) as { revision: number } | undefined;
    const current = existing ? Number(existing.revision) : 0;
    if (current !== expectedRevision) throw new Error("authority_revision_conflict");
    void actor;
    return current + 1;
  }

  private toHumanRecord(row: GenericRow, authority: "responsibility" | "reviewer") {
    return {
      schemaVersion: authority === "responsibility" ? "responsibility/v1" : "review-assignment/v1",
      scope: scopeFromColumns(row),
      principal:
        row.principal_id === null
          ? null
          : { kind: "human" as const, humanPrincipalId: row.principal_id },
      revision: Number(row.revision),
      updatedAt: row.updated_at
    };
  }
}

export { scopeColumns };

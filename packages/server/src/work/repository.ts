import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { humanProjectIdSchema, type ActorRef } from "../identity/schemas.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { HumanPrincipalIdentity } from "../identity/humanPrincipalIdentity.js";
import { WORK_ASSIGNMENT_ERROR_MESSAGES, type WorkAssignmentErrorCode } from "./errors.js";
import { WORK_ASSIGNMENT_BATCH_MAX } from "./limits.js";
import {
  assignmentConcurrencyFactsSchema,
  assignmentRecordSchema,
  assignmentTargetSchema,
  workItemRefSchema,
  type AssignmentConcurrencyFacts,
  type AssignmentRecord,
  type AssignmentTarget,
  type WorkItemRef
} from "./schemas.js";

export class WorkAssignmentError extends Error {
  constructor(
    readonly code: WorkAssignmentErrorCode,
    message: string = WORK_ASSIGNMENT_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "WorkAssignmentError";
  }
}

type AssignmentRow = {
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  work_item_kind: string;
  work_item_key: string;
  target_kind: string;
  target_human_principal_id: string | null;
  target_host_id: string | null;
  revision: number;
  updated_by_kind: string;
  updated_by_id: string;
  updated_by_display_name: string | null;
  updated_at: string;
  reason: string | null;
};

export type WorkItemKeyParts = {
  canvasId: string;
  workItemKind: "task" | "block";
  workItemKey: string;
};

export type WorkAssignmentRepositoryOptions = {
  onAssignmentUpdatedInTransaction?: (record: AssignmentRecord) => void;
};

export function workItemKeyParts(workItem: WorkItemRef): WorkItemKeyParts {
  const parsed = workItemRefSchema.parse(workItem);
  if (parsed.kind === "task") {
    return {
      canvasId: parsed.canvasId,
      workItemKind: "task",
      workItemKey: parsed.taskId
    };
  }
  return {
    canvasId: parsed.canvasId,
    workItemKind: "block",
    workItemKey: parsed.blockRef
  };
}

function workItemFromParts(parts: WorkItemKeyParts): WorkItemRef {
  if (parts.workItemKind === "task") {
    return workItemRefSchema.parse({
      kind: "task",
      canvasId: parts.canvasId,
      taskId: parts.workItemKey
    });
  }
  return workItemRefSchema.parse({
    kind: "block",
    canvasId: parts.canvasId,
    blockRef: parts.workItemKey
  });
}

function targetFromRow(row: AssignmentRow): AssignmentTarget {
  switch (row.target_kind) {
    case "unassigned":
      return assignmentTargetSchema.parse({ kind: "unassigned" });
    case "human":
      return assignmentTargetSchema.parse({
        kind: "human",
        humanPrincipalId: row.target_human_principal_id
      });
    case "exact_host":
      return assignmentTargetSchema.parse({
        kind: "exact_host",
        hostId: row.target_host_id
      });
    case "automatic_host":
      return assignmentTargetSchema.parse({ kind: "automatic_host" });
    default:
      throw new WorkAssignmentError(
        "work_input_invalid",
        "Unknown assignment target kind in storage."
      );
  }
}

function targetColumns(
  target: AssignmentTarget,
  identity: HumanPrincipalIdentity
): {
  target_kind: string;
  target_human_principal_id: string | null;
  target_host_id: string | null;
} {
  switch (target.kind) {
    case "unassigned":
      return {
        target_kind: "unassigned",
        target_human_principal_id: null,
        target_host_id: null
      };
    case "human":
      return {
        target_kind: "human",
        target_human_principal_id: identity.canonicalizeTarget(target.humanPrincipalId),
        target_host_id: null
      };
    case "exact_host":
      return {
        target_kind: "exact_host",
        target_human_principal_id: null,
        target_host_id: target.hostId
      };
    case "automatic_host":
      return {
        target_kind: "automatic_host",
        target_human_principal_id: null,
        target_host_id: null
      };
    default: {
      const _exhaustive: never = target;
      throw new WorkAssignmentError("work_input_invalid");
    }
  }
}

function toRecord(row: AssignmentRow): AssignmentRecord {
  const workItem = workItemFromParts({
    canvasId: row.canvas_id,
    workItemKind: row.work_item_kind as "task" | "block",
    workItemKey: row.work_item_key
  });
  const updatedBy: ActorRef = {
    kind: row.updated_by_kind as ActorRef["kind"],
    id: row.updated_by_id,
    ...(row.updated_by_display_name ? { displayName: row.updated_by_display_name } : {})
  };
  return assignmentRecordSchema.parse({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    workItem,
    target: targetFromRow(row),
    revision: Number(row.revision),
    updatedBy,
    updatedAt: row.updated_at,
    ...(row.reason ? { reason: row.reason } : {})
  });
}

/**
 * Durable assignment repository: uniqueness + compare-and-set in SQLite transactions.
 * Does not authorize actors or resolve package facts — callers (application service) do that first.
 */
export class WorkAssignmentRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: WorkAssignmentRepositoryOptions = {}
  ) {}

  get(workspaceId: string, projectId: string, workItem: WorkItemRef): AssignmentRecord | undefined {
    const wid = opaqueIdentifierSchema.parse(workspaceId);
    const pid = humanProjectIdSchema.parse(projectId);
    const parts = workItemKeyParts(workItem);
    const row = this.database
      .prepare(
        `SELECT * FROM work_assignments
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?`
      )
      .get(wid, pid, parts.canvasId, parts.workItemKind, parts.workItemKey) as
      | AssignmentRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  getConcurrency(
    workspaceId: string,
    projectId: string,
    workItem: WorkItemRef
  ): AssignmentConcurrencyFacts {
    const current = this.get(workspaceId, projectId, workItem);
    if (!current) {
      return assignmentConcurrencyFactsSchema.parse({ currentRevision: 0 });
    }
    return assignmentConcurrencyFactsSchema.parse({
      currentRevision: current.revision,
      current
    });
  }

  /**
   * Batch fetch by exact WorkItemRef list. Missing refs are omitted (caller synthesizes revision 0).
   * Order of returned records is not guaranteed to match input order.
   */
  getMany(
    workspaceId: string,
    projectId: string,
    workItems: readonly WorkItemRef[]
  ): AssignmentRecord[] {
    const wid = opaqueIdentifierSchema.parse(workspaceId);
    const pid = humanProjectIdSchema.parse(projectId);
    if (workItems.length === 0) return [];
    if (workItems.length > WORK_ASSIGNMENT_BATCH_MAX) {
      throw new WorkAssignmentError("work_input_invalid", "Work item batch exceeds maximum size.");
    }

    const results: AssignmentRecord[] = [];
    // SQLite has no array bind; iterate with prepared statement for exact keys.
    const stmt = this.database.prepare(
      `SELECT * FROM work_assignments
       WHERE workspace_id=? AND project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?`
    );
    for (const workItem of workItems) {
      const parts = workItemKeyParts(workItem);
      const row = stmt.get(wid, pid, parts.canvasId, parts.workItemKind, parts.workItemKey) as
        | AssignmentRow
        | undefined;
      if (row) results.push(toRecord(row));
    }
    return results;
  }

  listByProject(
    workspaceId: string,
    projectId: string,
    options: {
      canvasId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): AssignmentRecord[] {
    const wid = opaqueIdentifierSchema.parse(workspaceId);
    const pid = humanProjectIdSchema.parse(projectId);
    const limit = options.limit ?? WORK_ASSIGNMENT_BATCH_MAX;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORK_ASSIGNMENT_BATCH_MAX) {
      throw new WorkAssignmentError("work_input_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new WorkAssignmentError("work_input_invalid");
    }

    if (options.canvasId !== undefined) {
      const canvasId = opaqueIdentifierSchema.parse(options.canvasId);
      return (
        this.database
          .prepare(
            `SELECT * FROM work_assignments
             WHERE workspace_id=? AND project_id=? AND canvas_id=?
             ORDER BY updated_at ASC, work_item_kind ASC, work_item_key ASC
             LIMIT ? OFFSET ?`
          )
          .all(wid, pid, canvasId, limit, offset) as AssignmentRow[]
      ).map(toRecord);
    }

    return (
      this.database
        .prepare(
          `SELECT * FROM work_assignments
           WHERE workspace_id=? AND project_id=?
           ORDER BY canvas_id ASC, updated_at ASC, work_item_kind ASC, work_item_key ASC
           LIMIT ? OFFSET ?`
        )
        .all(wid, pid, limit, offset) as AssignmentRow[]
    ).map(toRecord);
  }

  /**
   * Compare-and-set write. expectedRevision must match current (0 = no row).
   * Always runs in a write transaction. Concurrent losers receive work_revision_conflict.
   */
  applyCasUpdate(input: { record: AssignmentRecord; expectedRevision: number }): AssignmentRecord {
    const record = assignmentRecordSchema.parse(input.record);
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      record.revision !== input.expectedRevision + 1
    ) {
      throw new WorkAssignmentError("work_input_invalid");
    }
    if (record.projectId !== humanProjectIdSchema.parse(record.projectId)) {
      throw new WorkAssignmentError("work_input_invalid");
    }

    return inWriteTransaction(this.database, () => {
      const parts = workItemKeyParts(record.workItem);
      const existing = this.database
        .prepare(
          `SELECT revision FROM work_assignments
           WHERE workspace_id=? AND project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?`
        )
        .get(
          record.workspaceId,
          record.projectId,
          parts.canvasId,
          parts.workItemKind,
          parts.workItemKey
        ) as { revision: number } | undefined;

      const currentRevision = existing ? Number(existing.revision) : 0;
      if (currentRevision !== input.expectedRevision) {
        throw new WorkAssignmentError("work_revision_conflict");
      }

      const target = targetColumns(record.target, new HumanPrincipalIdentity(this.database));
      const updatedByDisplayName = record.updatedBy.displayName ?? null;
      const reason = record.reason ?? null;

      if (input.expectedRevision === 0) {
        try {
          this.database
            .prepare(
              `INSERT INTO work_assignments(
                workspace_id,project_id,canvas_id,work_item_kind,work_item_key,
                target_kind,target_human_principal_id,target_host_id,
                revision,updated_by_kind,updated_by_id,updated_by_display_name,
                updated_at,reason
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            )
            .run(
              record.workspaceId,
              record.projectId,
              parts.canvasId,
              parts.workItemKind,
              parts.workItemKey,
              target.target_kind,
              target.target_human_principal_id,
              target.target_host_id,
              record.revision,
              record.updatedBy.kind,
              record.updatedBy.id,
              updatedByDisplayName,
              record.updatedAt,
              reason
            );
        } catch (error) {
          // Unique race: another writer inserted first.
          if (error instanceof Error && /UNIQUE/i.test(error.message)) {
            throw new WorkAssignmentError("work_revision_conflict");
          }
          throw error;
        }
      } else {
        const updated = this.database
          .prepare(
            `UPDATE work_assignments SET
              target_kind=?,
              target_human_principal_id=?,
              target_host_id=?,
              revision=?,
              updated_by_kind=?,
              updated_by_id=?,
              updated_by_display_name=?,
              updated_at=?,
              reason=?
             WHERE workspace_id=? AND project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?
               AND revision=?`
          )
          .run(
            target.target_kind,
            target.target_human_principal_id,
            target.target_host_id,
            record.revision,
            record.updatedBy.kind,
            record.updatedBy.id,
            updatedByDisplayName,
            record.updatedAt,
            reason,
            record.workspaceId,
            record.projectId,
            parts.canvasId,
            parts.workItemKind,
            parts.workItemKey,
            input.expectedRevision
          );
        if (updated.changes !== 1) {
          throw new WorkAssignmentError("work_revision_conflict");
        }
      }

      const stored = this.get(record.workspaceId, record.projectId, record.workItem);
      if (!stored) {
        throw new WorkAssignmentError("work_input_invalid", "Assignment row missing after write.");
      }
      this.options.onAssignmentUpdatedInTransaction?.(stored);
      return stored;
    });
  }
}

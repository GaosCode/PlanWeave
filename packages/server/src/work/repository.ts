/**
 * A2 repository — read/write helpers for work tables.
 *
 * Every read uses either an existing transaction's `database` (when
 * called inside an `executeIdempotent` UnitOfWork) or the shared
 * `SqliteDatabase` (for read paths that are explicitly outside a write
 * transaction).
 *
 * Write paths take the `UnitOfWork` so the same transaction that
 * appends events / audit also persists the aggregate changes.
 */

import type { SqliteDatabase } from "../sqlite.js";
import type { UnitOfWork } from "../store.js";
import type {
  WorkAssignment,
  WorkRepository,
  WorkReview,
  WorkSubmission,
  WorkTask,
  WorkTaskPolicy
} from "./types.js";

type WorkTaskRow = {
  id: string;
  project_id: string;
  task_id: string;
  title: string;
  parallel: number;
  locks_json: string;
  ownership_scopes_json: string;
  acceptance_checks_json: string;
  reviewers_json: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
};

type WorkAssignmentRow = {
  id: string;
  project_id: string;
  task_id: string;
  assignee_user_id: string;
  assignee_device_id: string;
  status: string;
  version: number;
  branch_name: string;
  base_commit: string;
  lease_expires_at: string;
  current_submission_id: string | null;
  created_at: string;
  updated_at: string;
};

type WorkSubmissionRow = {
  id: string;
  project_id: string;
  assignment_id: string;
  head_commit: string;
  base_commit: string;
  status: string;
  version: number;
  submitted_at: string;
  updated_at: string;
};

function stringArray(value: string): string[] {
  const decoded = JSON.parse(value) as unknown;
  return Array.isArray(decoded) ? decoded.filter((item): item is string => typeof item === "string") : [];
}

function decodePolicy(row: Pick<WorkTaskRow, "parallel" | "locks_json" | "ownership_scopes_json" | "acceptance_checks_json" | "reviewers_json">): WorkTaskPolicy {
  const locks = JSON.parse(row.locks_json) as unknown;
  return {
    parallel: row.parallel === 1,
    locks: Array.isArray(locks) ? locks.filter((value): value is string => typeof value === "string") : [],
    ownershipScopes: stringArray(row.ownership_scopes_json),
    acceptanceChecks: stringArray(row.acceptance_checks_json),
    reviewers: stringArray(row.reviewers_json)
  };
}

function mapTask(row: WorkTaskRow): WorkTask {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    title: row.title,
    policy: decodePolicy(row),
    version: Number(row.version),
    status: row.status as WorkTask["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAssignment(row: WorkAssignmentRow): WorkAssignment {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    assigneeUserId: row.assignee_user_id,
    assigneeDeviceId: row.assignee_device_id,
    status: row.status as WorkAssignment["status"],
    version: Number(row.version),
    branchName: row.branch_name,
    baseCommit: row.base_commit,
    leaseExpiresAt: row.lease_expires_at,
    currentSubmissionId: row.current_submission_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSubmission(row: WorkSubmissionRow): WorkSubmission {
  return {
    id: row.id,
    projectId: row.project_id,
    assignmentId: row.assignment_id,
    headCommit: row.head_commit,
    baseCommit: row.base_commit,
    status: row.status as WorkSubmission["status"],
    version: Number(row.version),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at
  };
}

type CreateWorkRepositoryOptions = {
  database: SqliteDatabase;
};

export function createWorkRepository(options: CreateWorkRepositoryOptions): WorkRepository {
  const { database } = options;

  const loadTask = (projectId: string, taskId: string): WorkTask | null => {
    const row = database
      .prepare("SELECT * FROM work_tasks WHERE project_id=? AND task_id=?")
      .get(projectId, taskId) as WorkTaskRow | undefined;
    return row ? mapTask(row) : null;
  };

  const loadTaskByServerId = (projectId: string, serverTaskId: string): WorkTask | null => {
    const row = database.prepare("SELECT * FROM work_tasks WHERE project_id=? AND id=?").get(projectId, serverTaskId) as WorkTaskRow | undefined;
    return row ? mapTask(row) : null;
  };

  const listDependencyIds = (projectId: string, serverTaskId: string): string[] => {
    return (database.prepare("SELECT depends_on_task_id AS id FROM work_task_dependencies WHERE project_id=? AND task_id=?").all(projectId, serverTaskId) as Array<{ id: string }>).map((row) => row.id);
  };

  const insertTask: WorkRepository["insertTask"] = (unit, input) => {
    const now = input.now;
    const version = 1;
    unit.database
      .prepare("INSERT INTO work_tasks(id,project_id,task_id,title,parallel,locks_json,ownership_scopes_json,acceptance_checks_json,reviewers_json,version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`task_${input.taskId}`, input.projectId, input.taskId, input.title, input.policy.parallel ? 1 : 0, JSON.stringify(input.policy.locks), JSON.stringify(input.policy.ownershipScopes ?? []), JSON.stringify(input.policy.acceptanceChecks ?? []), JSON.stringify(input.policy.reviewers ?? []), version, "ready", now, now);
    for (const dependency of input.dependencyIds) {
      unit.database.prepare("INSERT INTO work_task_dependencies(project_id,task_id,depends_on_task_id) VALUES (?,?,?)").run(input.projectId, `task_${input.taskId}`, dependency);
    }
    const created = loadTaskByServerId(input.projectId, `task_${input.taskId}`);
    if (!created) throw new Error("Inserted task row not found.");
    return created;
  };

  const loadAssignment = (unit: UnitOfWork, assignmentId: string): WorkAssignment | null => {
    const row = unit.database.prepare("SELECT * FROM work_assignments WHERE id=?").get(assignmentId) as WorkAssignmentRow | undefined;
    return row ? mapAssignment(row) : null;
  };

  const loadActiveAssignmentForTask = (unit: UnitOfWork, projectId: string, serverTaskId: string): WorkAssignment | null => {
    const row = unit.database
      .prepare("SELECT * FROM work_assignments WHERE project_id=? AND task_id=? AND status='active'")
      .get(projectId, serverTaskId) as WorkAssignmentRow | undefined;
    return row ? mapAssignment(row) : null;
  };

  const insertAssignment: WorkRepository["insertAssignment"] = (unit, input) => {
    const version = 1;
    unit.database
      .prepare(
        "INSERT INTO work_assignments(id,project_id,task_id,assignee_user_id,assignee_device_id,status,version,branch_name,base_commit,lease_expires_at,current_submission_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        input.id,
        input.projectId,
        input.taskId,
        input.assigneeUserId,
        input.assigneeDeviceId,
        input.status,
        version,
        input.branchName,
        input.baseCommit,
        input.leaseExpiresAt,
        null,
        input.createdAt,
        input.updatedAt
      );
    const created = loadAssignment(unit, input.id);
    if (!created) throw new Error("Inserted assignment row not found.");
    return created;
  };

  const updateAssignment: WorkRepository["updateAssignment"] = (unit, current, patch, now) => {
    const next: WorkAssignment = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: patch.leaseExpiresAt } : {}),
      ...(patch.currentSubmissionId !== undefined ? { currentSubmissionId: patch.currentSubmissionId } : {}),
      version: current.version + 1,
      updatedAt: now
    };
    unit.database
      .prepare("UPDATE work_assignments SET status=?, version=?, lease_expires_at=?, current_submission_id=?, updated_at=? WHERE id=? AND version=?")
      .run(next.status, next.version, next.leaseExpiresAt, next.currentSubmissionId, next.updatedAt, current.id, current.version);
    return next;
  };

  const loadSubmission = (unit: UnitOfWork, submissionId: string): WorkSubmission | null => {
    const row = unit.database.prepare("SELECT * FROM work_submissions WHERE id=?").get(submissionId) as WorkSubmissionRow | undefined;
    return row ? mapSubmission(row) : null;
  };

  const insertSubmission: WorkRepository["insertSubmission"] = (unit, input) => {
    const version = 1;
    unit.database
      .prepare("INSERT INTO work_submissions(id,project_id,assignment_id,head_commit,base_commit,status,version,submitted_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.projectId, input.assignmentId, input.headCommit, input.baseCommit, input.status, version, input.submittedAt, input.updatedAt);
    const created = loadSubmission(unit, input.id);
    if (!created) throw new Error("Inserted submission row not found.");
    return created;
  };

  const updateSubmission: WorkRepository["updateSubmission"] = (unit, current, patch, now) => {
    const next: WorkSubmission = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      version: current.version + 1,
      updatedAt: now
    };
    unit.database.prepare("UPDATE work_submissions SET status=?, version=?, updated_at=? WHERE id=? AND version=?").run(next.status, next.version, next.updatedAt, current.id, current.version);
    return next;
  };

  const insertReview: WorkRepository["insertReview"] = (unit, input) => {
    const version = 1;
    unit.database
      .prepare("INSERT INTO work_reviews(id,project_id,submission_id,assignment_id,reviewer_user_id,verdict,comments,version,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.projectId, input.submissionId, input.assignmentId, input.reviewerUserId, input.verdict, input.comments, version, input.createdAt);
    const created: WorkReview = {
      id: input.id,
      projectId: input.projectId,
      submissionId: input.submissionId,
      assignmentId: input.assignmentId,
      reviewerUserId: input.reviewerUserId,
      verdict: input.verdict,
      comments: input.comments,
      version,
      createdAt: input.createdAt
    };
    return created;
  };

  const listExpiredAssignments = (unit: UnitOfWork, now: string): WorkAssignment[] => {
    return (unit.database.prepare("SELECT * FROM work_assignments WHERE status='active' AND lease_expires_at <= ?").all(now) as WorkAssignmentRow[]).map(mapAssignment);
  };

  return {
    database,
    loadTask,
    loadTaskByServerId,
    listDependencyIds,
    insertTask,
    loadAssignment,
    loadActiveAssignmentForTask,
    insertAssignment,
    updateAssignment,
    loadSubmission,
    insertSubmission,
    updateSubmission,
    insertReview,
    listExpiredAssignments
  };
}

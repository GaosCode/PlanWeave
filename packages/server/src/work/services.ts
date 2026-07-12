/**
 * A2 application services — plain TypeScript functions, no HTTP coupling.
 *
 * Every state-changing command goes through `executeIdempotent` with:
 *   - a validated `Idempotency-Key` (16..128 ASCII)
 *   - `expectedVersion` for commands that mutate an existing aggregate
 *   - a `UnitOfWork` that wraps assignment / event / audit writes in one
 *     transaction (so `executeIdempotent` only commits when all three succeed)
 *
 * Conflict semantics:
 *   - `version_conflict` — `expectedVersion` did not match the stored
 *     aggregate version at the time of write. Returned with
 *     `details.currentVersion` so the client can refresh.
 *   - `state_conflict` — the write was rejected by a domain invariant
 *     (active assignment exists, dependency not ready, terminal state, etc).
 *     Returned with a `details.policyConflict` or `details.blockingDependencyIds`.
 *
 * The HTTP layer (A7/A8) maps these to the CONTRACTS-v1 `ApiError` envelope.
 */

import { executeIdempotent, type IdempotentCommand, type UnitOfWork } from "../store.js";
import {
  assertExpectedVersion,
  assertIdempotencyKey,
  requestFingerprintFor,
  WorkError,
  type ClaimTaskCommand,
  type ClaimTaskResult,
  type HeartbeatCommand,
  type HeartbeatResult,
  type ReviewCommand,
  type ReviewResult,
  type SubmitCommand,
  type SubmitResult,
  type WithdrawCommand,
  type WithdrawResult,
  type WorkRepository,
  type WorkServices,
  type WorkSubmission,
  type WorkTask
} from "./types.js";

/** Returns the current ISO timestamp, or the injected `now` if provided (for tests). */
// Reserved for future time-injection; the harness currently uses a no-op clock.
// function nowIso(now?: string): string {
//   return now ?? new Date().toISOString();
// }

/**
 * Map a SQLite error thrown by `node:sqlite` to a `WorkError` if the cause is
 * the unique-active-assignment constraint; otherwise re-throw. Called from
 * `command.execute` after a failed conditional INSERT.
 */
function translateUniqueViolation(error: unknown, serverTaskId: string): WorkError {
  if (error instanceof Error && /^UNIQUE constraint failed/i.test(error.message)) {
    return new WorkError("state_conflict", "Task already has an active assignment.", {
      aggregateType: "task",
      aggregateId: serverTaskId,
      policyConflict: { activeAssignmentId: null, reason: "task_locked" }
    });
  }
  throw error;
}

type CreateWorkServicesOptions = {
  repository: WorkRepository;
  /** Optional override of the clock; used for tests. */
  now?: () => string;
};

export function createWorkServices(options: CreateWorkServicesOptions): WorkServices {
  const { repository } = options;
  const clock = options.now ?? (() => new Date().toISOString());

  /**
   * Insert a domain event and return the new event id. The caller is inside
   * an existing `UnitOfWork`; this is a thin wrapper for symmetry with the
   * `audit` helper on the unit.
   */
  const appendEvent: WorkServices["appendEvent"] = (unit, event) => unit.appendEvent(event);

  /**
   * Verify every dependency has reached a terminal-success state. The
   * `work_tasks` row is the only source of truth here — `status` is the
   * dependency snapshot. A task with no dependencies is always ready.
   */
  function verifyDependenciesReady(task: WorkTask, unit: UnitOfWork): void {
    const depIds = repository.listDependencyIds(task.projectId, task.id);
    if (depIds.length === 0) return;
    const blocking: string[] = [];
    for (const depServerId of depIds) {
      const row = unit.database
        .prepare("SELECT status FROM work_tasks WHERE id=?")
        .get(depServerId) as { status: string } | undefined;
      if (!row || row.status !== "accepted") {
        blocking.push(depServerId);
      }
    }
    if (blocking.length > 0) {
      throw new WorkError("state_conflict", "Task dependencies are not satisfied.", {
        aggregateType: "task",
        aggregateId: task.id,
        blockingDependencyIds: blocking
      });
    }
  }

  const claimTask: WorkServices["claimTask"] = (command) => {
    assertIdempotencyKey(command.idempotencyKey);
    if (!Number.isInteger(command.leaseDurationSeconds) || command.leaseDurationSeconds < 1) {
      throw new WorkError("validation_failed", "leaseDurationSeconds must be a positive integer.", {});
    }
    const fingerprint = requestFingerprintFor(command, {
      projectId: command.projectId,
      taskId: command.taskId,
      branchName: command.branchName,
      baseCommit: command.baseCommit,
      leaseDurationSeconds: command.leaseDurationSeconds
    });
    const idempotent: IdempotentCommand<ClaimTaskResult & { eventId: string }> = {
      deviceId: command.deviceId,
      route: `/api/v1/projects/${command.projectId}/tasks/${command.taskId}/claim`,
      projectId: command.projectId,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
        // Load the task; the assignment FK column references the server task id
        const taskRow = unit.database
          .prepare("SELECT * FROM work_tasks WHERE project_id=? AND task_id=?")
          .get(command.projectId, command.taskId) as Record<string, unknown> | undefined;
        if (!taskRow) {
          throw new WorkError("not_found", `Task '${command.taskId}' does not exist.`, { aggregateType: "task", aggregateId: command.taskId });
        }
        const task = mapTaskRow(taskRow);
        // Validate expectedVersion if provided (claim is a creation command in
        // spirit but the task itself is the existing aggregate being observed)
        if (command.expectedVersion !== undefined && task.version !== command.expectedVersion) {
          throw new WorkError("version_conflict", `Task version mismatch.`, {
            aggregateType: "task",
            aggregateId: task.id,
            currentVersion: task.version,
            expectedVersion: command.expectedVersion
          });
        }
        verifyDependenciesReady(task, unit);

        const assignmentId = `asn_${cryptoRandomId()}`;
        const now = clock();
        const leaseExpiresAt = new Date(Date.parse(now) + command.leaseDurationSeconds * 1000).toISOString();

        // Insert the active assignment. `INSERT OR IGNORE` is the database-
        // level serialization point: the partial UNIQUE index
        // `WHERE status='active'` ensures at most one active row per
        // (project, task) even under concurrent transactions.
        try {
          unit.database
            .prepare(
              "INSERT OR IGNORE INTO work_assignments(id,project_id,task_id,assignee_user_id,assignee_device_id,status,version,branch_name,base_commit,lease_expires_at,current_submission_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
            )
            .run(
              assignmentId,
              command.projectId,
              task.id,
              command.actorId,
              command.deviceId,
              "active",
              1,
              command.branchName,
              command.baseCommit,
              leaseExpiresAt,
              null,
              now,
              now
            );
        } catch (error) {
          throw translateUniqueViolation(error, task.id);
        }
        // Detect whether the partial UNIQUE dropped our INSERT. The
        // server's `SqliteStatement` typing does not surface `changes`, so
        // we re-read the row by primary key to confirm ownership of the
        // generated id.
        const insertedRow = unit.database
          .prepare("SELECT id FROM work_assignments WHERE id=?")
          .get(assignmentId) as { id: string } | undefined;
        if (!insertedRow) {
          // The partial UNIQUE index silently dropped our INSERT. Re-read
          // the task to report the current version (which the winner bumped).
          const currentTaskRow = unit.database
            .prepare("SELECT * FROM work_tasks WHERE id=?")
            .get(task.id) as Record<string, unknown>;
          const currentTask = mapTaskRow(currentTaskRow);
          throw new WorkError("version_conflict", "Task already has an active assignment.", {
            aggregateType: "task",
            aggregateId: task.id,
            currentVersion: currentTask.version
          });
        }

        // Bump task version (1 -> 2) and transition status to `leased`.
        const newTaskVersion = task.version + 1;
        unit.database
          .prepare("UPDATE work_tasks SET version=?, status=?, updated_at=? WHERE id=? AND version=?")
          .run(newTaskVersion, "leased", now, task.id, task.version);

        const eventId = unit.appendEvent({
          projectId: command.projectId,
          aggregateType: "task",
          aggregateId: task.id,
          aggregateVersion: newTaskVersion,
          type: "task.claimed"
        });
        unit.audit({
          projectId: command.projectId,
          actorId: command.actorId,
          action: "task.claim",
          aggregateType: "task",
          aggregateId: task.id,
          details: { assignmentId, branchName: command.branchName, baseCommit: command.baseCommit, leaseExpiresAt }
        });

        const createdAssignment = repository.loadAssignment(unit, assignmentId);
        if (!createdAssignment) throw new Error("Inserted assignment row not found.");
        const refreshedTask = repository.loadTaskByServerId(command.projectId, task.id);
        if (!refreshedTask) throw new Error("Task row disappeared after claim.");
        return { assignment: createdAssignment, task: refreshedTask, eventId };
      }
    };
    const result = executeIdempotent(repository.database, idempotent);
    return { replayed: result.replayed, value: result.value, eventIds: [result.value.eventId] };
  };

  const heartbeat: WorkServices["heartbeat"] = (command) => {
    assertIdempotencyKey(command.idempotencyKey);
    assertExpectedVersion(command.expectedVersion);
    if (!Number.isInteger(command.leaseDurationSeconds) || command.leaseDurationSeconds < 1) {
      throw new WorkError("validation_failed", "leaseDurationSeconds must be a positive integer.", {});
    }
    const fingerprint = requestFingerprintFor(command, {
      projectId: command.projectId,
      actorId: command.actorId,
      aggregateId: command.aggregateId,
      expectedVersion: command.expectedVersion,
      leaseDurationSeconds: command.leaseDurationSeconds
    });
    const idempotent: IdempotentCommand<HeartbeatResult & { eventId: string }> = {
      deviceId: command.deviceId,
      route: `/api/v1/projects/${command.projectId}/assignments/${command.aggregateId}/heartbeat`,
      projectId: command.projectId,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
        const current = repository.loadAssignment(unit, command.aggregateId!);
        if (!current || current.projectId !== command.projectId) {
          throw new WorkError("not_found", `Assignment '${command.aggregateId}' does not exist.`, { aggregateType: "assignment", aggregateId: command.aggregateId });
        }
        if (current.version !== command.expectedVersion) {
          throw new WorkError("version_conflict", "Assignment version mismatch.", {
            aggregateType: "assignment",
            aggregateId: current.id,
            currentVersion: current.version,
            expectedVersion: command.expectedVersion
          });
        }
        if (current.status !== "active") {
          throw new WorkError("state_conflict", "Only active assignments can heartbeat.", {
            aggregateType: "assignment",
            aggregateId: current.id
          });
        }
        const now = clock();
        const newLeaseExpiresAt = new Date(Date.parse(now) + command.leaseDurationSeconds * 1000).toISOString();
        const updated = repository.updateAssignment(unit, current, { leaseExpiresAt: newLeaseExpiresAt }, now);
        const eventId = unit.appendEvent({
          projectId: command.projectId,
          aggregateType: "assignment",
          aggregateId: updated.id,
          aggregateVersion: updated.version,
          type: "task.heartbeated"
        });
        unit.audit({
          projectId: command.projectId,
          actorId: command.actorId,
          action: "assignment.heartbeat",
          aggregateType: "assignment",
          aggregateId: updated.id,
          details: { newLeaseExpiresAt }
        });
        return { assignment: updated, newLeaseExpiresAt, eventId };
      }
    };
    const result = executeIdempotent(repository.database, idempotent);
    return { replayed: result.replayed, value: result.value, eventIds: [result.value.eventId] };
  };

  const submit: WorkServices["submit"] = (command) => {
    assertIdempotencyKey(command.idempotencyKey);
    assertExpectedVersion(command.expectedVersion);
    const fingerprint = requestFingerprintFor(command, {
      projectId: command.projectId,
      actorId: command.actorId,
      aggregateId: command.aggregateId,
      expectedVersion: command.expectedVersion,
      headCommit: command.headCommit,
      baseCommit: command.baseCommit
    });
    const idempotent: IdempotentCommand<SubmitResult & { eventId: string }> = {
      deviceId: command.deviceId,
      route: `/api/v1/projects/${command.projectId}/assignments/${command.aggregateId}/submit`,
      projectId: command.projectId,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
        const current = repository.loadAssignment(unit, command.aggregateId!);
        if (!current || current.projectId !== command.projectId) {
          throw new WorkError("not_found", `Assignment '${command.aggregateId}' does not exist.`, { aggregateType: "assignment", aggregateId: command.aggregateId });
        }
        if (current.version !== command.expectedVersion) {
          throw new WorkError("version_conflict", "Assignment version mismatch.", {
            aggregateType: "assignment",
            aggregateId: current.id,
            currentVersion: current.version,
            expectedVersion: command.expectedVersion
          });
        }
        if (current.status !== "active" && current.status !== "needs_changes") {
          throw new WorkError("state_conflict", "Only active or needs_changes assignments can submit.", {
            aggregateType: "assignment",
            aggregateId: current.id
          });
        }
        const now = clock();
        const submissionId = `sub_${cryptoRandomId()}`;
        const submission = repository.insertSubmission(unit, {
          id: submissionId,
          projectId: command.projectId,
          assignmentId: current.id,
          headCommit: command.headCommit,
          baseCommit: command.baseCommit,
          status: "open",
          submittedAt: now,
          updatedAt: now
        });
        // Bump assignment: status=reviewing, current_submission_id=sub
        const updatedAssignment = repository.updateAssignment(
          unit,
          current,
          { status: "reviewing", currentSubmissionId: submission.id },
          now
        );
        // Bump the task version too so dependent work can observe the change
        const taskRow = unit.database
          .prepare("SELECT * FROM work_tasks WHERE id=?")
          .get(current.taskId) as Record<string, unknown>;
        const task = mapTaskRow(taskRow);
        unit.database
          .prepare("UPDATE work_tasks SET version=?, status=?, updated_at=? WHERE id=? AND version=?")
          .run(task.version + 1, "submitted", now, task.id, task.version);
        const eventId = unit.appendEvent({
          projectId: command.projectId,
          aggregateType: "submission",
          aggregateId: submission.id,
          aggregateVersion: submission.version,
          type: "task.submitted"
        });
        unit.audit({
          projectId: command.projectId,
          actorId: command.actorId,
          action: "assignment.submit",
          aggregateType: "submission",
          aggregateId: submission.id,
          details: { assignmentId: current.id, headCommit: command.headCommit, baseCommit: command.baseCommit }
        });
        return { assignment: updatedAssignment, submission, eventId };
      }
    };
    const result = executeIdempotent(repository.database, idempotent);
    return { replayed: result.replayed, value: result.value, eventIds: [result.value.eventId] };
  };

  const review: WorkServices["review"] = (command) => {
    assertIdempotencyKey(command.idempotencyKey);
    assertExpectedVersion(command.expectedVersion);
    const fingerprint = requestFingerprintFor(command, {
      projectId: command.projectId,
      actorId: command.actorId,
      aggregateId: command.aggregateId,
      expectedVersion: command.expectedVersion,
      verdict: command.verdict,
      comments: command.comments
    });
    const idempotent: IdempotentCommand<ReviewResult & { eventId: string }> = {
      deviceId: command.deviceId,
      route: `/api/v1/projects/${command.projectId}/submissions/${command.aggregateId}/review`,
      projectId: command.projectId,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
        const currentSubmission = repository.loadSubmission(unit, command.aggregateId!);
        if (!currentSubmission || currentSubmission.projectId !== command.projectId) {
          throw new WorkError("not_found", `Submission '${command.aggregateId}' does not exist.`, { aggregateType: "submission", aggregateId: command.aggregateId });
        }
        if (currentSubmission.version !== command.expectedVersion) {
          throw new WorkError("version_conflict", "Submission version mismatch.", {
            aggregateType: "submission",
            aggregateId: currentSubmission.id,
            currentVersion: currentSubmission.version,
            expectedVersion: command.expectedVersion
          });
        }
        if (currentSubmission.status !== "open") {
          throw new WorkError("state_conflict", "Only open submissions can be reviewed.", {
            aggregateType: "submission",
            aggregateId: currentSubmission.id
          });
        }
        const now = clock();
        const reviewId = `rev_${cryptoRandomId()}`;
        const reviewRow = repository.insertReview(unit, {
          id: reviewId,
          projectId: command.projectId,
          submissionId: currentSubmission.id,
          assignmentId: currentSubmission.assignmentId,
          reviewerUserId: command.actorId,
          verdict: command.verdict,
          comments: command.comments,
          createdAt: now
        });
        // Update submission status. Use a widened local so the spread
        // type-checks against the full SubmissionStatus union.
        const widened: WorkSubmission = currentSubmission;
        const nextSubmissionStatus = command.verdict === "accepted" ? "accepted" as const : "rejected" as const;
        const updatedSubmission = repository.updateSubmission(unit, widened, { status: nextSubmissionStatus }, now);
        // Update the linked assignment: accepted -> accepted; needs_changes -> needs_changes
        const assignment = repository.loadAssignment(unit, currentSubmission.assignmentId);
        if (!assignment) throw new WorkError("not_found", "Linked assignment missing.", { aggregateType: "assignment", aggregateId: currentSubmission.assignmentId });
        const nextAssignmentStatus: typeof assignment.status = command.verdict === "accepted" ? "accepted" : "needs_changes";
        const updatedAssignment = repository.updateAssignment(unit, assignment, { status: nextAssignmentStatus }, now);
        // If accepted, mark task accepted. If needs_changes, allow re-claim by
        // bumping task version so callers see the new state.
        const taskRow = unit.database
          .prepare("SELECT * FROM work_tasks WHERE id=?")
          .get(assignment.taskId) as Record<string, unknown>;
        const task = mapTaskRow(taskRow);
        const nextTaskStatus: typeof task.status = command.verdict === "accepted" ? "accepted" : "needs_changes";
        unit.database
          .prepare("UPDATE work_tasks SET version=?, status=?, updated_at=? WHERE id=? AND version=?")
          .run(task.version + 1, nextTaskStatus, now, task.id, task.version);
        const eventId = unit.appendEvent({
          projectId: command.projectId,
          aggregateType: "submission",
          aggregateId: updatedSubmission.id,
          aggregateVersion: updatedSubmission.version,
          type: "task.reviewed"
        });
        unit.audit({
          projectId: command.projectId,
          actorId: command.actorId,
          action: "submission.review",
          aggregateType: "submission",
          aggregateId: updatedSubmission.id,
          details: { verdict: command.verdict, assignmentId: assignment.id }
        });
        return { review: reviewRow, submission: updatedSubmission, assignment: updatedAssignment, eventId };
      }
    };
    const result = executeIdempotent(repository.database, idempotent);
    return { replayed: result.replayed, value: result.value, eventIds: [result.value.eventId] };
  };

  const withdraw: WorkServices["withdraw"] = (command) => {
    assertIdempotencyKey(command.idempotencyKey);
    assertExpectedVersion(command.expectedVersion);
    const fingerprint = requestFingerprintFor(command, {
      projectId: command.projectId,
      actorId: command.actorId,
      aggregateId: command.aggregateId,
      expectedVersion: command.expectedVersion
    });
    const idempotent: IdempotentCommand<WithdrawResult & { eventId: string }> = {
      deviceId: command.deviceId,
      route: `/api/v1/projects/${command.projectId}/assignments/${command.aggregateId}/withdraw`,
      projectId: command.projectId,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
        const current = repository.loadAssignment(unit, command.aggregateId!);
        if (!current || current.projectId !== command.projectId) {
          throw new WorkError("not_found", `Assignment '${command.aggregateId}' does not exist.`, { aggregateType: "assignment", aggregateId: command.aggregateId });
        }
        if (current.version !== command.expectedVersion) {
          throw new WorkError("version_conflict", "Assignment version mismatch.", {
            aggregateType: "assignment",
            aggregateId: current.id,
            currentVersion: current.version,
            expectedVersion: command.expectedVersion
          });
        }
        if (current.status !== "active") {
          throw new WorkError("state_conflict", "Only active assignments can be withdrawn.", {
            aggregateType: "assignment",
            aggregateId: current.id
          });
        }
        const now = clock();
        const updated = repository.updateAssignment(unit, current, { status: "withdrawn" }, now);
        // Re-arm the task so a new claim can take the slot
        const taskRow = unit.database
          .prepare("SELECT * FROM work_tasks WHERE id=?")
          .get(current.taskId) as Record<string, unknown>;
        const task = mapTaskRow(taskRow);
        unit.database
          .prepare("UPDATE work_tasks SET version=?, status=?, updated_at=? WHERE id=? AND version=?")
          .run(task.version + 1, "ready", now, task.id, task.version);
        const eventId = unit.appendEvent({
          projectId: command.projectId,
          aggregateType: "assignment",
          aggregateId: updated.id,
          aggregateVersion: updated.version,
          type: "task.withdrawn"
        });
        unit.audit({
          projectId: command.projectId,
          actorId: command.actorId,
          action: "assignment.withdraw",
          aggregateType: "assignment",
          aggregateId: updated.id,
          details: {}
        });
        return { assignment: updated, eventId };
      }
    };
    const result = executeIdempotent(repository.database, idempotent);
    return { replayed: result.replayed, value: result.value, eventIds: [result.value.eventId] };
  };

  /**
   * Server-owned scan for expired leases. Transitions `assignment.status`
   * from `active` to `expired` and bumps the task version so a new claim
   * can take the slot. Crucially, it does NOT delete the assignment row or
   * any submission branches — those remain visible to the contributor.
   */
  const reclaimExpiredLeases: WorkServices["reclaimExpiredLeases"] = (nowArg) => {
    const now = nowArg ?? clock();
    const eventIds: string[] = [];
    const expiredIds: string[] = [];
    // Use a single write transaction for the whole batch; idempotent over
    // a clock that has not moved between calls within the same tick.
    executeIdempotent(repository.database, {
      deviceId: "system",
      route: "system://work/reclaim",
      projectId: "system",
      key: `reclaim-${now}`,
      requestFingerprint: `reclaim-${now}`,
      execute: (unit) => {
        const expired = repository.listExpiredAssignments(unit, now);
        for (const assignment of expired) {
          const updated = repository.updateAssignment(unit, assignment, { status: "expired" }, now);
          // Re-arm the task for claim by incrementing its version
          const taskRow = unit.database
            .prepare("SELECT * FROM work_tasks WHERE id=?")
            .get(updated.taskId) as Record<string, unknown> | undefined;
          if (!taskRow) continue;
          const task = mapTaskRow(taskRow);
          unit.database
            .prepare("UPDATE work_tasks SET version=?, status=?, updated_at=? WHERE id=? AND version=?")
            .run(task.version + 1, "ready", now, task.id, task.version);
          const eventId = unit.appendEvent({
            projectId: updated.projectId,
            aggregateType: "assignment",
            aggregateId: updated.id,
            aggregateVersion: updated.version,
            type: "task.lease_expired"
          });
          unit.audit({
            projectId: updated.projectId,
            actorId: "system",
            action: "assignment.lease_expired",
            aggregateType: "assignment",
            aggregateId: updated.id,
            details: { leaseExpiresAt: updated.leaseExpiresAt }
          });
          eventIds.push(eventId);
          expiredIds.push(updated.id);
        }
        return { expiredAssignmentIds: expiredIds, eventIds };
      }
    });
    return { expiredAssignmentIds: expiredIds, eventIds };
  };

  return {
    repository,
    claimTask,
    heartbeat,
    submit,
    review,
    withdraw,
    reclaimExpiredLeases,
    appendEvent
  };
}

/** Cryptographically-random short id used for row primary keys. */
function cryptoRandomId(): string {
  // 9 random bytes base16 = 18 hex chars, collision-resistant for our scale.
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type WorkTaskRowShape = {
  id: string;
  project_id: string;
  task_id: string;
  title: string;
  parallel: number;
  locks_json: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
};

function mapTaskRow(row: Record<string, unknown>): WorkTask {
  const r = row as unknown as WorkTaskRowShape;
  const locks = JSON.parse(r.locks_json) as unknown;
  return {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    title: r.title,
    policy: {
      parallel: r.parallel === 1,
      locks: Array.isArray(locks) ? locks.filter((v): v is string => typeof v === "string") : []
    },
    version: Number(r.version),
    status: r.status as WorkTask["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// Re-export for tests / external callers
export type { ClaimTaskResult, HeartbeatResult, SubmitResult, ReviewResult, WithdrawResult };

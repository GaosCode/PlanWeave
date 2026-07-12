/**
 * Domain types for A2 — Transactional Work Coordination.
 *
 * These types describe the server's authoritative state for collaborative
 * task ownership, leases, submissions, and reviews. They are the source of
 * truth for the application services that HTTP/CLI/Desktop layers call.
 *
 * Wire DTOs (over HTTP) come from CONTRACTS-v1.md; the shapes below are the
 * internal server projections, not the wire envelope. Application services
 * return these internal values; HTTP/WS layers are responsible for shaping
 * them to `EventEnvelopeV1` / collection pages.
 *
 * Concurrency model:
 *  - Every state-changing command goes through `executeIdempotent` with an
 *    `Idempotency-Key` (16..128 ASCII chars) and an `expectedVersion` for
 *    commands that mutate an existing aggregate.
 *  - Aggregate version increments exactly once per successful command.
 *  - "One active assignment per task" is enforced by a UNIQUE partial index
 *    on `assignments(task_id) WHERE status = 'active'`. A claim that loses
 *    the conditional write surfaces as `version_conflict` (if version
 *    changed) or `state_conflict` (if a parallel constraint fired).
 *  - Domain events follow `aggregateType.action` (e.g. `task.claimed`,
 *    `task.heartbeated`, `task.submitted`, `task.reviewed`,
 *    `task.lease_expired`).
 */

import type { DomainEvent, UnitOfWork } from "../store.js";
import type { SqliteDatabase } from "../sqlite.js";

/** Statuses the RFC assigns to a `task` aggregate. */
export const taskStatuses = ["planned", "ready", "leased", "submitted", "reviewing", "accepted", "needs_changes", "withdrawn", "expired"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

/** Statuses for an assignment row (the lease-attached row per attempt). */
export const assignmentStatuses = ["active", "submitted", "reviewing", "accepted", "needs_changes", "withdrawn", "expired"] as const;
export type AssignmentStatus = (typeof assignmentStatuses)[number];

/** Statuses for a submission record. */
export const submissionStatuses = ["open", "superseded", "accepted", "rejected"] as const;
export type SubmissionStatus = (typeof submissionStatuses)[number];

/** Review verdicts. */
export const reviewVerdicts = ["accepted", "needs_changes"] as const;
export type ReviewVerdict = (typeof reviewVerdicts)[number];

/** Parallel/lock policy the task was bound with. Mirrors PlanWeave runtime. */
export type WorkTaskPolicy = {
  /** When false (a "locked" task), at most one active assignment is allowed. */
  parallel: boolean;
  /** Logical locks this task takes; reject parallel claims that overlap. */
  locks: string[];
  /** Repository-relative globs/paths this task is allowed to modify. */
  ownershipScopes?: string[];
  /** Commands that must pass before this task may be merged. */
  acceptanceChecks?: string[];
  /** User ids explicitly assigned to review this task. */
  reviewers?: string[];
};

/**
 * A server-side binding of a PlanWeave task to a project. The task_id is
 * the stable runtime identifier; `id` is the server-local row id.
 */
export type WorkTask = {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  policy: WorkTaskPolicy;
  version: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * An assignment row is the durable record of a contributor's attempt to
 * work a task. The lease fields ride on this row; transitions flip
 * `status` and emit one `DomainEvent` per successful command.
 */
export type WorkAssignment = {
  id: string;
  projectId: string;
  taskId: string;
  assigneeUserId: string;
  assigneeDeviceId: string;
  status: AssignmentStatus;
  /** Aggregate version — increments on every successful state change. */
  version: number;
  /** Branch name the contributor created locally; never deleted by reclaim. */
  branchName: string;
  /** Base commit the contributor branched from; immutable for the assignment. */
  baseCommit: string;
  /** RFC 3339 UTC millisecond timestamp the lease expires. */
  leaseExpiresAt: string;
  /** Optional submission id currently attached to this assignment. */
  currentSubmissionId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A submitted head commit for an assignment. */
export type WorkSubmission = {
  id: string;
  projectId: string;
  assignmentId: string;
  headCommit: string;
  baseCommit: string;
  status: SubmissionStatus;
  version: number;
  submittedAt: string;
  updatedAt: string;
};

/** A review verdict for a submission. */
export type WorkReview = {
  id: string;
  projectId: string;
  submissionId: string;
  assignmentId: string;
  reviewerUserId: string;
  verdict: ReviewVerdict;
  comments: string;
  version: number;
  createdAt: string;
};

/* ------------------------------------------------------------------ *
 * Error envelope — DTOs match `ApiError` from CONTRACTS-v1.md.        *
 * Application services throw `WorkError`; the HTTP layer (A7/A8) is    *
 * responsible for mapping to a response status and body. We never put *
 * the wire shape (`{ error: {...} }`) inside an application service.  *
 * ------------------------------------------------------------------ */

export type WorkErrorCode =
  | "validation_failed"
  | "version_conflict"
  | "state_conflict"
  | "idempotency_key_reused"
  | "not_found";

export type WorkErrorDetails = {
  aggregateType?: "task" | "assignment" | "submission" | "review";
  aggregateId?: string;
  currentVersion?: number;
  expectedVersion?: number;
  /** When the rejection is about a missing dependency, list the dep ids. */
  blockingDependencyIds?: string[];
  /** When the rejection is the parallel/lock policy, name the conflict. */
  policyConflict?: { activeAssignmentId: string; locks?: string[] } | { activeAssignmentId: null; reason: "task_locked" };
};

export class WorkError extends Error {
  readonly code: WorkErrorCode;
  readonly details: WorkErrorDetails;
  constructor(code: WorkErrorCode, message: string, details: WorkErrorDetails = {}) {
    super(message);
    this.name = "WorkError";
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ *
 * Command shape. Application services are versioned: every state-    *
 * changing command carries an `expectedVersion` (the version the      *
 * caller observed), and a stable `commandType` for the idempotency   *
 * fingerprint. Creation commands (first claim, first submission)     *
 * omit `expectedVersion` and use a 1-based optimistic count.          *
 * ------------------------------------------------------------------ */

export type WorkCommandBase = {
  deviceId: string;
  /** Idempotency-Key (16..128 ASCII chars). Validated up front. */
  idempotencyKey: string;
  /** Stable command type for idempotency fingerprint hashing. */
  commandType: string;
  /** Aggregate being mutated. */
  aggregateType: "task" | "assignment" | "submission" | "review";
  /** Server-local row id of the aggregate. Omit on creation commands. */
  aggregateId?: string;
  /** Observed version before this command runs. Omit on creation. */
  expectedVersion?: number;
  /** Project the command targets (for idempotency scoping). */
  projectId: string;
  /** User invoking the command; recorded in audit_log. */
  actorId: string;
};

export type ClaimTaskCommand = WorkCommandBase & {
  commandType: "claim_task";
  taskId: string;
  branchName: string;
  baseCommit: string;
  /** Lease duration in seconds; converted to an absolute expiry. */
  leaseDurationSeconds: number;
};

export type HeartbeatCommand = WorkCommandBase & {
  commandType: "heartbeat";
  aggregateType: "assignment";
  aggregateId: string;
  expectedVersion: number;
  /** Desired new lease duration in seconds. */
  leaseDurationSeconds: number;
};

export type SubmitCommand = WorkCommandBase & {
  commandType: "submit";
  aggregateType: "assignment";
  aggregateId: string;
  expectedVersion: number;
  headCommit: string;
  baseCommit: string;
};

export type ReviewCommand = WorkCommandBase & {
  commandType: "review";
  aggregateType: "submission";
  aggregateId: string;
  expectedVersion: number;
  verdict: ReviewVerdict;
  comments: string;
};

export type WithdrawCommand = WorkCommandBase & {
  commandType: "withdraw";
  aggregateType: "assignment";
  aggregateId: string;
  expectedVersion: number;
};

/* ------------------------------------------------------------------ *
 * Command dispatch helpers                                           *
 * ------------------------------------------------------------------ */

export const idempotencyKeyPattern = /^[\x21-\x7E]{16,128}$/;

export function assertIdempotencyKey(key: string): void {
  if (!idempotencyKeyPattern.test(key)) {
    throw new WorkError("validation_failed", "Idempotency-Key must be 16..128 ASCII printable characters.", {});
  }
}

export function assertExpectedVersion(value: number | undefined): asserts value is number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new WorkError("validation_failed", "expectedVersion must be a positive integer.", {});
  }
}

/** Stable fingerprint for an idempotency key: command type + canonical body. */
export function requestFingerprintFor(command: WorkCommandBase, body: Record<string, unknown>): string {
  return `${command.commandType}::${JSON.stringify(body)}`;
}

/* ------------------------------------------------------------------ *
 * Repository contract — application services use this to read/write  *
 * the durable rows. Implementations live in `repository.ts` and use   *
 * the `UnitOfWork` from A1.                                           *
 * ------------------------------------------------------------------ */

export type WorkRepository = {
  database: SqliteDatabase;
  loadTask(projectId: string, taskId: string): WorkTask | null;
  loadTaskByServerId(projectId: string, serverTaskId: string): WorkTask | null;
  listDependencyIds(projectId: string, serverTaskId: string): string[];
  insertTask(unit: UnitOfWork, input: { projectId: string; taskId: string; title: string; policy: WorkTaskPolicy; dependencyIds: string[]; now: string }): WorkTask;
  loadAssignment(unit: UnitOfWork, assignmentId: string): WorkAssignment | null;
  /** Returns the active assignment for the task, if any. Enforces uniqueness via the partial index. */
  loadActiveAssignmentForTask(unit: UnitOfWork, projectId: string, serverTaskId: string): WorkAssignment | null;
  insertAssignment(unit: UnitOfWork, input: Omit<WorkAssignment, "id" | "version" | "createdAt" | "updatedAt" | "currentSubmissionId"> & { id: string; createdAt: string; updatedAt: string; currentSubmissionId: null }): WorkAssignment;
  updateAssignment(unit: UnitOfWork, current: WorkAssignment, patch: Partial<Pick<WorkAssignment, "status" | "leaseExpiresAt" | "currentSubmissionId">>, now: string): WorkAssignment;
  loadSubmission(unit: UnitOfWork, submissionId: string): WorkSubmission | null;
  insertSubmission(unit: UnitOfWork, input: Omit<WorkSubmission, "id" | "version" | "submittedAt" | "updatedAt"> & { id: string; submittedAt: string; updatedAt: string }): WorkSubmission;
  updateSubmission(unit: UnitOfWork, current: WorkSubmission, patch: Partial<Pick<WorkSubmission, "status">>, now: string): WorkSubmission;
  insertReview(unit: UnitOfWork, input: Omit<WorkReview, "id" | "version" | "createdAt"> & { id: string; createdAt: string }): WorkReview;
  /** Server-owned: scan for active assignments whose lease has expired. */
  listExpiredAssignments(unit: UnitOfWork, now: string): WorkAssignment[];
};

/* ------------------------------------------------------------------ *
 * Application service handle. Constructed once per process from the  *
 * shared `SqliteDatabase` and the in-process clock.                   *
 * ------------------------------------------------------------------ */

export type WorkServices = {
  repository: WorkRepository;
  /** Plain-function services, no HTTP coupling. */
  claimTask(command: ClaimTaskCommand): { replayed: boolean; value: ClaimTaskResult; eventIds: string[] };
  heartbeat(command: HeartbeatCommand): { replayed: boolean; value: HeartbeatResult; eventIds: string[] };
  submit(command: SubmitCommand): { replayed: boolean; value: SubmitResult; eventIds: string[] };
  review(command: ReviewCommand): { replayed: boolean; value: ReviewResult; eventIds: string[] };
  withdraw(command: WithdrawCommand): { replayed: boolean; value: WithdrawResult; eventIds: string[] };
  /** Reclaim expired leases. Returns the number of assignments that expired. */
  reclaimExpiredLeases(now?: string): { expiredAssignmentIds: string[]; eventIds: string[] };
  /** Helper for tests / HTTP wiring: append a domain event from a service. */
  appendEvent(unit: UnitOfWork, event: Omit<DomainEvent, "projectId" | "aggregateVersion"> & { projectId: string; aggregateVersion: number }): string;
};

export type ClaimTaskResult = {
  assignment: WorkAssignment;
  task: WorkTask;
};

export type HeartbeatResult = {
  assignment: WorkAssignment;
  newLeaseExpiresAt: string;
};

export type SubmitResult = {
  submission: WorkSubmission;
  assignment: WorkAssignment;
};

export type ReviewResult = {
  review: WorkReview;
  submission: WorkSubmission;
  assignment: WorkAssignment;
};

export type WithdrawResult = {
  assignment: WorkAssignment;
};

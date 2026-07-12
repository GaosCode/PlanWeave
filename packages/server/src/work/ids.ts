/**
 * Public surface for A2 work coordination.
 *
 * Importers should not reach into `repository.ts` or `services.ts`
 * directly — go through this module so the stable contract is clear.
 */

export { WorkError, idempotencyKeyPattern, assertIdempotencyKey, assertExpectedVersion, requestFingerprintFor } from "./types.js";
export type {
  WorkAssignment,
  WorkReview,
  WorkSubmission,
  WorkTask,
  WorkTaskPolicy,
  WorkRepository,
  WorkServices,
  ClaimTaskCommand,
  ClaimTaskResult,
  HeartbeatCommand,
  HeartbeatResult,
  ReviewCommand,
  ReviewResult,
  SubmitCommand,
  SubmitResult,
  WithdrawCommand,
  WithdrawResult,
  WorkErrorCode,
  WorkErrorDetails,
  TaskStatus,
  AssignmentStatus,
  SubmissionStatus,
  ReviewVerdict
} from "./types.js";
export { createWorkRepository } from "./repository.js";
export { createWorkServices } from "./services.js";
export { applyWorkMigrations, workMigrations } from "./migrations.js";

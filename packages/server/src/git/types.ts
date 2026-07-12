import type { DomainEvent, UnitOfWork } from "../store.js"
import type { SqliteDatabase } from "../sqlite.js"

export const mergeQueueStatuses = ["pending", "checking", "reviewing", "merging", "merged", "failed", "conflict"] as const
export type MergeQueueStatus = (typeof mergeQueueStatuses)[number]

export type MergeQueueEntry = {
  id: string
  projectId: string
  submissionId: string
  headCommit: string
  baseCommit: string
  targetBranch: string
  status: MergeQueueStatus
  worktreePath: string | null
  checkLogs: string | null
  reviewVerdict: string | null
  errorDetails: string | null
  createdAt: string
  updatedAt: string
}

export type MergeQueueConfig = {
  bareRepoPath: string
  worktreesDir: string
  checks: string[]
  requireApproval: boolean
  maxConcurrent: number
  retentionDays: number
}

export type MergeQueueErrorCode =
  | "validation_failed"
  | "ancestry_invalid"
  | "conflict"
  | "check_failed"
  | "stale_target"
  | "path_violation"
  | "process_crash"
  | "worktree_error"
  | "not_found"
  | "state_conflict"

export type MergeQueueErrorDetails = {
  entryId?: string
  headCommit?: string
  baseCommit?: string
  targetBranch?: string
  checkName?: string
  worktreePath?: string
  exitCode?: number
  stdout?: string
  stderr?: string
}

export class MergeQueueError extends Error {
  readonly code: MergeQueueErrorCode
  readonly details: MergeQueueErrorDetails
  constructor(code: MergeQueueErrorCode, message: string, details: MergeQueueErrorDetails = {}) {
    super(message)
    this.name = "MergeQueueError"
    this.code = code
    this.details = details
  }
}

export type MergeValidationResult = {
  valid: boolean
  reason?: string
  conflictingFiles?: string[]
}

export type CheckResult = {
  name: string
  passed: boolean
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number
}

export type MergeResult = {
  entryId: string
  status: MergeQueueStatus
  mergeCommit?: string
  error?: string
}

export type EnqueueCommand = {
  deviceId: string
  idempotencyKey: string
  projectId: string
  submissionId: string
  headCommit: string
  baseCommit: string
  targetBranch: string
  actorId: string
}

export type MergeQueueRepository = {
  database: SqliteDatabase
  loadEntry(unit: UnitOfWork, entryId: string): MergeQueueEntry | null
  loadEntryBySubmission(unit: UnitOfWork, projectId: string, submissionId: string): MergeQueueEntry | null
  insertEntry(unit: UnitOfWork, input: Omit<MergeQueueEntry, "id" | "checkLogs" | "reviewVerdict" | "errorDetails" | "createdAt" | "updatedAt" | "worktreePath"> & { id: string; worktreePath: string | null; createdAt: string; updatedAt: string }): MergeQueueEntry
  updateEntry(unit: UnitOfWork, current: MergeQueueEntry, patch: Partial<Pick<MergeQueueEntry, "status" | "worktreePath" | "checkLogs" | "reviewVerdict" | "errorDetails">>, now: string): MergeQueueEntry
  listEntries(unit: UnitOfWork, projectId: string): MergeQueueEntry[]
  listInterruptedEntries(unit: UnitOfWork): MergeQueueEntry[]
  loadConfig(projectId: string): MergeQueueConfig | null
  upsertConfig(unit: UnitOfWork, projectId: string, config: MergeQueueConfig): void
}

export type MergeQueueServices = {
  repository: MergeQueueRepository
  enqueueSubmission(command: EnqueueCommand): { replayed: boolean; value: MergeQueueEntry; eventIds: string[] }
  processEntry(entryId: string): Promise<MergeResult>
  processQueue(projectId: string): Promise<MergeResult[]>
  reconcileOnStartup(): Promise<{ reconciledEntries: string[]; eventIds: string[] }>
  garbageCollect(): Promise<{ removedWorktrees: string[]; errors: string[] }>
}

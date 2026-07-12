import { executeIdempotent, type IdempotentCommand, type UnitOfWork } from "../store.js"
import { createMergeQueueRepository } from "./repository.js"
import { createWorktreeManager } from "./worktreeManager.js"
import { runRepositoryChecks, runTargetedChecks, retainCheckLogs } from "./checks.js"
import { validateCommitAncestry, validatePathWithinScope } from "./validation.js"
import { MergeQueueError, type CheckResult, type EnqueueCommand, type MergeQueueConfig, type MergeQueueEntry, type MergeQueueRepository, type MergeQueueServices, type MergeResult } from "./types.js"
import type { SqliteDatabase } from "../sqlite.js"

function cryptoRandomId(): string {
  const bytes = new Uint8Array(9)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

type CreateMergeQueueServicesOptions = {
  database: SqliteDatabase
  config: Partial<MergeQueueConfig> & { dataDirectory: string }
  now?: () => string
  worktreeManager?: ReturnType<typeof createWorktreeManager>
}

export function createMergeQueueServices(options: CreateMergeQueueServicesOptions): MergeQueueServices {
  const { database } = options
  const clock = options.now ?? (() => new Date().toISOString())
  const dataDir = options.config.dataDirectory
  const config: MergeQueueConfig = {
    bareRepoPath: options.config.bareRepoPath ?? `${dataDir}/bare-repo`,
    worktreesDir: options.config.worktreesDir ?? `${dataDir}/worktrees`,
    checks: options.config.checks ?? ["pnpm-lint", "pnpm-build", "pnpm-test"],
    requireApproval: options.config.requireApproval ?? true,
    maxConcurrent: options.config.maxConcurrent ?? 4,
    retentionDays: options.config.retentionDays ?? 7
  }

  const repository = createMergeQueueRepository({ database })
  const worktreeManager = options.worktreeManager ?? createWorktreeManager()

  const validationCtx = { worktreeManager, config, database }

  const enqueueSubmission: MergeQueueServices["enqueueSubmission"] = (command) => {
    if (!/^[\x21-\x7E]{16,128}$/.test(command.idempotencyKey)) {
      throw new MergeQueueError("validation_failed", "Idempotency-Key must be 16..128 ASCII printable characters.", {})
    }
    const fingerprint = `enqueue:${command.submissionId}:${command.headCommit}:${command.baseCommit}:${command.targetBranch}`
    const idempotent: IdempotentCommand<MergeQueueEntry> = {
      deviceId: command.deviceId,
      route: `/api/v1/projects/${command.projectId}/merge-queue`,
      projectId: command.projectId,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
        validateEnqueueAuthority(unit.database, command)
        const existing = repository.loadEntryBySubmission(unit, command.projectId, command.submissionId)
        if (existing) return existing
        const entryId = `mqe_${cryptoRandomId()}`
        const now = clock()
        const entry = repository.insertEntry(unit, {
          id: entryId,
          projectId: command.projectId,
          submissionId: command.submissionId,
          headCommit: command.headCommit,
          baseCommit: command.baseCommit,
          targetBranch: command.targetBranch,
          status: "pending",
          worktreePath: null,
          createdAt: now,
          updatedAt: now
        })
        unit.audit({
          projectId: command.projectId,
          actorId: command.actorId,
          action: "merge_queue.enqueue",
          aggregateType: "merge_queue_entry",
          aggregateId: entry.id,
          details: {
            submissionId: command.submissionId,
            headCommit: command.headCommit,
            baseCommit: command.baseCommit,
            targetBranch: command.targetBranch
          }
        })
        return entry
      }
    }
    const result = executeIdempotent(repository.database, idempotent)
    return { replayed: result.replayed, value: result.value, eventIds: [] }
  }

  function validateEnqueueAuthority(database: SqliteDatabase, command: EnqueueCommand): void {
    const membership = database
      .prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?")
      .get(command.projectId, command.actorId)
    if (!membership) {
      throw new MergeQueueError("validation_failed", "User must be a project member to enqueue a submission.", {})
    }

    const workSchemaExists = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_submissions'")
      .get()
    if (!workSchemaExists) return

    const submission = database
      .prepare("SELECT project_id, assignment_id, head_commit, base_commit FROM work_submissions WHERE id=?")
      .get(command.submissionId)
    if (!submission || submission.project_id !== command.projectId) {
      throw new MergeQueueError("validation_failed", "Submission does not belong to the target project.", {})
    }
    if (submission.head_commit !== command.headCommit || submission.base_commit !== command.baseCommit) {
      throw new MergeQueueError("validation_failed", "Submission commits do not match the immutable work submission.", {
        headCommit: command.headCommit,
        baseCommit: command.baseCommit
      })
    }
    const assignment = database
      .prepare("SELECT assignee_user_id FROM work_assignments WHERE id=? AND project_id=?")
      .get(submission.assignment_id, command.projectId)
    const role = String(membership.role)
    if (!assignment || (assignment.assignee_user_id !== command.actorId && role !== "maintainer" && role !== "owner")) {
      throw new MergeQueueError("validation_failed", "Only the assignee or a project maintainer may enqueue this submission.", {})
    }
  }

  const processEntry = async (entryId: string): Promise<MergeResult> => {
    let entry: MergeQueueEntry | null = null
    let worktreePath: string | null = null

    const readUnit: UnitOfWork = { database, appendEvent: () => "", audit: () => {} }

    try {
      entry = repository.loadEntry(readUnit, entryId)
      if (!entry) return { entryId, status: "failed", error: "Entry not found." }

      if (entry.status !== "pending") {
        return { entryId, status: entry.status }
      }

      // Transition to checking
      entry = await transitionEntry(entry.id, "checking", null, null, null)

      // Validate ancestry
      await validateCommitAncestry(entry, validationCtx)

      const taskPolicy = await validateTaskOwnership(entry)

      // Create worktree
      worktreePath = await worktreeManager.createWorktree(entry, config)
      entry = await transitionEntry(entry.id, "checking", worktreePath, null, null)

      // Snapshot target head for final check
      const targetHeadBefore = await worktreeManager.getTargetHead(config.bareRepoPath, entry.targetBranch)

      // Run repository checks
      const checkResults: CheckResult[] = []
      try {
        if (taskPolicy) {
          const targeted = await runTargetedChecks(worktreePath, taskPolicy.acceptanceChecks, { worktreeManager })
          checkResults.push(...targeted)
          const failed = targeted.find((result) => !result.passed)
          if (failed) throw new MergeQueueError("check_failed", `Task acceptance check '${failed.name}' failed with exit code ${failed.exitCode}.`, { checkName: failed.name, exitCode: failed.exitCode })
        }
        const repoChecks = await runRepositoryChecks(worktreePath, { worktreeManager })
        checkResults.push(...repoChecks)
      } catch (error) {
        if (error instanceof MergeQueueError && error.code === "check_failed") {
          const failLogs = retainCheckLogs(checkResults)
          await transitionEntry(entry.id, "failed", worktreePath, failLogs, error.message)
          await cleanupWorktree(worktreePath)
          return { entryId, status: "failed", error: error.message }
        }
        throw error
      }

      const checkLogs = retainCheckLogs(checkResults)

      // Review gate
      if (config.requireApproval) {
        entry = await transitionEntry(entry.id, "reviewing", worktreePath, checkLogs, null)
        return { entryId, status: "reviewing" }
      }

      // Transition to merging
      entry = await transitionEntry(entry.id, "merging", worktreePath, checkLogs, null)

      // Final target-head check before merge (serialized mutation)
      await validateTargetHeadStale(entry, targetHeadBefore)

      // Perform merge
      const headBranch = `merge-${entry.id}`
      const mergeResult = await worktreeManager.mergeEntry(worktreePath, headBranch, entry.targetBranch)
      if (mergeResult.conflict) {
        const errorMsg = `Merge conflict with target branch '${entry.targetBranch}'.`
        await transitionEntry(entry.id, "conflict", worktreePath, checkLogs, errorMsg)
        await cleanupWorktree(worktreePath)
        return { entryId, status: "conflict", error: errorMsg }
      }

      await transitionEntry(entry.id, "merged", worktreePath, checkLogs, null)
      await cleanupWorktree(worktreePath)

      return { entryId, status: "merged", mergeCommit: mergeResult.mergeCommit }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (error instanceof MergeQueueError) {
        const failStatus = error.code === "conflict" ? "conflict" : "failed"
        if (entry) {
          await transitionEntry(entry.id, failStatus, worktreePath, entry.checkLogs, errorMsg)
        }
        if (worktreePath) await cleanupWorktree(worktreePath)
        return { entryId, status: failStatus, error: errorMsg }
      }
      if (entry) {
        await transitionEntry(entry.id, "failed", worktreePath, entry.checkLogs, errorMsg)
      }
      if (worktreePath) await cleanupWorktree(worktreePath)
      return { entryId, status: "failed", error: errorMsg }
    }
  }

  async function validateTaskOwnership(entry: MergeQueueEntry): Promise<{ acceptanceChecks: string[] } | null> {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_submissions'").get()
    if (!table) return null
    const row = database.prepare("SELECT t.ownership_scopes_json,t.acceptance_checks_json FROM work_submissions s JOIN work_assignments a ON a.id=s.assignment_id JOIN work_tasks t ON t.id=a.task_id WHERE s.id=? AND s.project_id=?").get(entry.submissionId, entry.projectId)
    if (!row) throw new MergeQueueError("validation_failed", "Submission has no authoritative task ownership policy.", {})
    const scopes = parsePolicyList(row.ownership_scopes_json)
    if (scopes.length === 0) throw new MergeQueueError("path_violation", "Task has no ownership scope and cannot be merged.", {})
    const changedFiles = await worktreeManager.changedFilesInRange(config.bareRepoPath, entry.baseCommit, entry.headCommit)
    validatePathWithinScope(changedFiles, scopes)
    return { acceptanceChecks: parsePolicyList(row.acceptance_checks_json) }
  }

  const processQueue = async (projectId: string): Promise<MergeResult[]> => {
    const results: MergeResult[] = []
    const readUnit: UnitOfWork = { database, appendEvent: () => "", audit: () => {} }
    const pending = repository.listEntries(readUnit, projectId).filter((e) => e.status === "pending")

    for (const entry of pending) {
      const result = await processEntry(entry.id)
      results.push(result)
    }

    return results
  }

  const reconcileOnStartup = async (): Promise<{ reconciledEntries: string[]; eventIds: string[] }> => {
    const reconciledEntries: string[] = []
    const readUnit: UnitOfWork = { database, appendEvent: () => "", audit: () => {} }

    const interrupted = repository.listInterruptedEntries(readUnit)
    for (const entry of interrupted) {
      if (entry.worktreePath) {
        try {
          await worktreeManager.removeWorktree(entry.worktreePath, config)
        } catch { /* best effort */ }
      }
      executeIdempotent(repository.database, {
        deviceId: "system",
        route: "system://merge-queue/reconcile",
        projectId: entry.projectId,
        key: `reconcile-${entry.id}-${cryptoRandomId()}`,
        requestFingerprint: `reconcile-${entry.id}`,
        execute: (unit) => {
          const current = repository.loadEntry(unit, entry.id)
          if (current && (current.status === "checking" || current.status === "reviewing" || current.status === "merging")) {
            repository.updateEntry(unit, current, { status: "pending", worktreePath: null }, clock())
          }
          return entry.id
        }
      })
      reconciledEntries.push(entry.id)
    }
    return { reconciledEntries, eventIds: [] }
  }

  const garbageCollect = async (): Promise<{ removedWorktrees: string[]; errors: string[] }> => {
    return worktreeManager.garbageCollect(config)
  }

  async function transitionEntry(
    entryId: string,
    status: MergeQueueEntry["status"],
    worktreePath: string | null,
    checkLogs: string | null,
    errorDetails: string | null
  ): Promise<MergeQueueEntry> {
    const now = clock()
    const keySuffix = cryptoRandomId()
    const idempotent: IdempotentCommand<MergeQueueEntry> = {
      deviceId: "system",
      route: `system://merge-queue/transition`,
      projectId: undefined,
      key: `transition-${entryId}-${keySuffix}`,
      requestFingerprint: `transition-${entryId}-${status}`,
      execute: (unit) => {
        const current = repository.loadEntry(unit, entryId)
        if (!current) throw new MergeQueueError("not_found", `Entry '${entryId}' not found.`, { entryId })
        const patch: Parameters<MergeQueueRepository["updateEntry"]>[2] = { status }
        if (worktreePath !== undefined) patch.worktreePath = worktreePath
        if (checkLogs !== undefined) patch.checkLogs = checkLogs
        if (errorDetails !== undefined) patch.errorDetails = errorDetails
        return repository.updateEntry(unit, current, patch, now)
      }
    }
    const result = executeIdempotent(repository.database, idempotent)
    return result.value
  }

  async function validateTargetHeadStale(entry: MergeQueueEntry, previousHead: string): Promise<void> {
    const currentHead = await worktreeManager.getTargetHead(config.bareRepoPath, entry.targetBranch)
    if (currentHead !== previousHead) {
      throw new MergeQueueError("stale_target", `Target branch '${entry.targetBranch}' has moved since checks began.`, {
        entryId: entry.id,
        targetBranch: entry.targetBranch
      })
    }
  }

  async function cleanupWorktree(path: string | null): Promise<void> {
    if (!path) return
    try {
      await worktreeManager.removeWorktree(path, config)
    } catch { /* best effort */ }
  }

  return {
    repository,
    enqueueSubmission,
    processEntry,
    processQueue,
    reconcileOnStartup,
    garbageCollect
  }
}

function parsePolicyList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : []
  } catch { return [] }
}

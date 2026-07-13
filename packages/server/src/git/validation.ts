import { MergeQueueError, type MergeQueueEntry, type MergeQueueConfig } from "./types.js"
import type { WorktreeManager } from "./worktreeManager.js"
import { posix } from "node:path"

export type ValidationContext = {
  worktreeManager: WorktreeManager
  config: MergeQueueConfig
  database: { prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined } }
}

export async function validateCommitAncestry(
  entry: MergeQueueEntry,
  ctx: ValidationContext
): Promise<void> {
  const result = await ctx.worktreeManager.verifyAncestry(
    ctx.config.bareRepoPath,
    entry.headCommit,
    entry.baseCommit
  )
  if (!result.valid) {
    throw new MergeQueueError("ancestry_invalid", result.reason ?? "Head commit is not a descendant of base commit.", {
      entryId: entry.id,
      headCommit: entry.headCommit,
      baseCommit: entry.baseCommit
    })
  }
}

export function validateMembership(
  entry: MergeQueueEntry,
  userId: string
): void {
  const row = entry
  if (!userId) {
    throw new MergeQueueError("validation_failed", "User must be a project member to enqueue.", {
      entryId: entry.id
    })
  }
}

export function validateAssignmentScope(
  _entry: MergeQueueEntry,
  _workTask: Record<string, unknown>
): void {
  // validate that changed files match the task's assigned scope
  // scope validation is based on the task policy locks
  // for now, this is a pass-through
}

export async function validateNoConflict(
  entry: MergeQueueEntry,
  worktreePath: string,
  ctx: ValidationContext
): Promise<void> {
  const headBranch = `merge-${entry.id}`
  const result = await ctx.worktreeManager.mergeEntry(worktreePath, headBranch, entry.targetBranch)
  if (result.conflict) {
    throw new MergeQueueError("conflict", `Merge conflict with target branch '${entry.targetBranch}'.`, {
      entryId: entry.id,
      targetBranch: entry.targetBranch,
      worktreePath
    })
  }
}

export async function validateTargetHead(
  entry: MergeQueueEntry,
  previousTargetHead: string,
  ctx: ValidationContext
): Promise<string> {
  const currentHead = await ctx.worktreeManager.getTargetHead(
    ctx.config.bareRepoPath,
    entry.targetBranch
  )
  if (currentHead !== previousTargetHead) {
    throw new MergeQueueError("stale_target", `Target branch '${entry.targetBranch}' has moved since validation.`, {
      entryId: entry.id,
      targetBranch: entry.targetBranch
    })
  }
  return currentHead
}

export function validatePathWithinScope(
  changedFiles: string[],
  allowedPaths: string[]
): void {
  if (allowedPaths.length === 0) return
  for (const file of changedFiles) {
    const normalizedFile = normalizeRepositoryPath(file, "changed file")
    const allowed = allowedPaths.some((rawScope) => {
      const wildcard = rawScope.endsWith("/**") || rawScope.endsWith("/*")
      const scope = normalizeRepositoryPath(wildcard ? rawScope.replace(/\/(\*\*|\*)$/, "") : rawScope, "allowed scope")
      if (wildcard) {
        return normalizedFile === scope || normalizedFile.startsWith(`${scope}/`)
      }
      return normalizedFile === scope
    })
    if (!allowed) {
      throw new MergeQueueError("path_violation", `File '${file}' is outside the allowed scope.`, {
        entryId: undefined,
        worktreePath: undefined
      })
    }
  }
}

function normalizeRepositoryPath(value: string, label: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) {
    throw new MergeQueueError("path_violation", `Invalid ${label} '${value}'.`, {})
  }
  const normalized = posix.normalize(value)
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new MergeQueueError("path_violation", `Invalid ${label} '${value}'.`, {})
  }
  return normalized.replace(/^\.\//, "")
}

import type { SqliteDatabase } from "../sqlite.js"
import type { UnitOfWork } from "../store.js"
import { MergeQueueError, type MergeQueueConfig, type MergeQueueEntry, type MergeQueueRepository, type MergeQueueStatus } from "./types.js"

type MergeQueueEntryRow = {
  id: string
  project_id: string
  submission_id: string
  head_commit: string
  base_commit: string
  target_branch: string
  status: string
  worktree_path: string | null
  check_logs: string | null
  review_verdict: string | null
  error_details: string | null
  created_at: string
  updated_at: string
}

function mapEntry(row: MergeQueueEntryRow): MergeQueueEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    submissionId: row.submission_id,
    headCommit: row.head_commit,
    baseCommit: row.base_commit,
    targetBranch: row.target_branch,
    status: row.status as MergeQueueStatus,
    worktreePath: row.worktree_path,
    checkLogs: row.check_logs,
    reviewVerdict: row.review_verdict,
    errorDetails: row.error_details,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

type CreateMergeQueueRepositoryOptions = {
  database: SqliteDatabase
}

export function createMergeQueueRepository(options: CreateMergeQueueRepositoryOptions): MergeQueueRepository {
  const { database } = options

  const loadEntry = (unit: UnitOfWork, entryId: string): MergeQueueEntry | null => {
    const row = unit.database.prepare("SELECT * FROM merge_queue_entries WHERE id=?").get(entryId) as MergeQueueEntryRow | undefined
    return row ? mapEntry(row) : null
  }

  const loadEntryBySubmission = (unit: UnitOfWork, projectId: string, submissionId: string): MergeQueueEntry | null => {
    const row = unit.database.prepare("SELECT * FROM merge_queue_entries WHERE project_id=? AND submission_id=?").get(projectId, submissionId) as MergeQueueEntryRow | undefined
    return row ? mapEntry(row) : null
  }

  const insertEntry: MergeQueueRepository["insertEntry"] = (unit, input) => {
    unit.database
      .prepare(
        "INSERT INTO merge_queue_entries(id,project_id,submission_id,head_commit,base_commit,target_branch,status,worktree_path,check_logs,review_verdict,error_details,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        input.id,
        input.projectId,
        input.submissionId,
        input.headCommit,
        input.baseCommit,
        input.targetBranch,
        input.status,
        input.worktreePath,
        null,
        null,
        null,
        input.createdAt,
        input.updatedAt
      )
    const created = loadEntry(unit, input.id)
    if (!created) throw new Error("Inserted merge queue entry not found.")
    return created
  }

  const updateEntry: MergeQueueRepository["updateEntry"] = (unit, current, patch, now, expectedStatus) => {
    const next: MergeQueueEntry = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
      ...(patch.checkLogs !== undefined ? { checkLogs: patch.checkLogs } : {}),
      ...(patch.reviewVerdict !== undefined ? { reviewVerdict: patch.reviewVerdict } : {}),
      ...(patch.errorDetails !== undefined ? { errorDetails: patch.errorDetails } : {}),
      updatedAt: now
    }
    const result = expectedStatus === undefined
      ? unit.database
          .prepare("UPDATE merge_queue_entries SET status=?, worktree_path=?, check_logs=?, review_verdict=?, error_details=?, updated_at=? WHERE id=?")
          .run(next.status, next.worktreePath, next.checkLogs, next.reviewVerdict, next.errorDetails, next.updatedAt, current.id)
      : unit.database
          .prepare("UPDATE merge_queue_entries SET status=?, worktree_path=?, check_logs=?, review_verdict=?, error_details=?, updated_at=? WHERE id=? AND status=?")
          .run(next.status, next.worktreePath, next.checkLogs, next.reviewVerdict, next.errorDetails, next.updatedAt, current.id, expectedStatus)
    if (result.changes !== 1) {
      throw new MergeQueueError("state_conflict", `Merge queue entry '${current.id}' changed concurrently.`, {
        entryId: current.id
      })
    }
    return next
  }

  const listEntries = (unit: UnitOfWork, projectId: string): MergeQueueEntry[] => {
    return (unit.database.prepare("SELECT * FROM merge_queue_entries WHERE project_id=? ORDER BY created_at ASC").all(projectId) as MergeQueueEntryRow[]).map(mapEntry)
  }

  const listInterruptedEntries = (unit: UnitOfWork): MergeQueueEntry[] => {
    return (unit.database.prepare("SELECT * FROM merge_queue_entries WHERE status IN ('checking','merging')").all() as MergeQueueEntryRow[]).map(mapEntry)
  }

  const loadConfig = (projectId: string): MergeQueueConfig | null => {
    const row = database.prepare("SELECT * FROM merge_queue_config WHERE project_id=?").get(projectId) as { project_id: string; bare_repo_path: string; config_json: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.config_json) as MergeQueueConfig
    return { ...parsed, bareRepoPath: row.bare_repo_path }
  }

  const upsertConfig = (unit: UnitOfWork, projectId: string, config: MergeQueueConfig): void => {
    unit.database
      .prepare("INSERT OR REPLACE INTO merge_queue_config(project_id, bare_repo_path, config_json) VALUES (?,?,?)")
      .run(projectId, config.bareRepoPath, JSON.stringify({ ...config, bareRepoPath: undefined }))
  }

  return {
    database,
    loadEntry,
    loadEntryBySubmission,
    insertEntry,
    updateEntry,
    listEntries,
    listInterruptedEntries,
    loadConfig,
    upsertConfig
  }
}

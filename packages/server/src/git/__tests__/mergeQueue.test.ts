import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMigrations } from "../../migrations.js"
import { openServerDatabase, type SqliteDatabase } from "../../sqlite.js"
import { applyMergeQueueMigrations } from "../migrations.js"
import { createMergeQueueServices } from "../mergeQueue.js"
import { MergeQueueError, type MergeQueueEntry, type MergeQueueServices } from "../types.js"
import type { WorktreeManager } from "../worktreeManager.js"

function createMockWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    initBareRepo: async () => {},
    createWorktree: async () => "/tmp/mock-worktree",
    removeWorktree: async () => {},
    garbageCollect: async () => ({ removedWorktrees: [], errors: [] }),
    getTargetHead: async () => "abc123def456",
    mergeEntry: async () => ({ mergeCommit: "merge-commit-hash", conflict: false, conflictFiles: [] }),
    verifyAncestry: async () => ({ valid: true }),
    changedFilesInRange: async () => ["src/index.ts"],
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides
  }
}

type TestHarness = {
  dataDirectory: string
  database: SqliteDatabase
  services: MergeQueueServices
  seedProject(projectId: string): void
  seedConfig(projectId: string): void
  close(): void
  mockWm: WorktreeManager
  removedWorktrees: Set<string>
}

async function createTestHarness(mockOverrides: Partial<WorktreeManager> = {}): Promise<TestHarness> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-mq-"))
  const databasePath = join(dataDirectory, "server.sqlite")
  const database = await openServerDatabase(databasePath, 5000)
  applyMigrations(database)
  applyMergeQueueMigrations(database)

  const removedWorktrees = new Set<string>()
  const mockWm = createMockWorktreeManager({
    removeWorktree: async (path) => { removedWorktrees.add(path) },
    ...mockOverrides
  })

  const services = createMergeQueueServices({
    database,
    config: {
      dataDirectory,
      requireApproval: false,
      checkExecutionMode: "host",
      maxConcurrent: 2
    },
    worktreeManager: mockWm
  })

  const seedProject = (projectId: string) => {
    database.prepare("INSERT INTO projects(id,name,created_at) VALUES (?,?,?)").run(projectId, `Project ${projectId}`, new Date().toISOString())
    database.prepare("INSERT INTO memberships(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run(projectId, "user-1", "contributor", new Date().toISOString())
  }

  const seedConfig = (projectId: string) => {
    database.prepare("INSERT OR REPLACE INTO merge_queue_config(project_id,bare_repo_path,config_json) VALUES (?,?,?)").run(projectId, join(dataDirectory, "bare-repo"), JSON.stringify({}))
  }

  return {
    dataDirectory,
    database,
    services,
    seedProject,
    seedConfig,
    close: () => database.close(),
    mockWm,
    removedWorktrees
  }
}

async function cleanupHarness(harness: TestHarness): Promise<void> {
  harness.close()
  await rm(harness.dataDirectory, { recursive: true, force: true })
}

describe("A9 merge queue", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createTestHarness()
    harness.seedProject("project-a")
    harness.seedConfig("project-a")
  })

  afterEach(async () => {
    await cleanupHarness(harness)
  })

  it("enqueues a submission successfully", () => {
    const result = harness.services.enqueueSubmission({
      deviceId: "dev-1",
      idempotencyKey: "enqueue-key-aaaaaaaaaa",
      projectId: "project-a",
      submissionId: "sub-1",
      headCommit: "head-commit-hash",
      baseCommit: "base-commit-hash",
      targetBranch: "main",
      actorId: "user-1"
    })
    expect(result.replayed).toBe(false)
    expect(result.value.status).toBe("pending")
    expect(result.value.submissionId).toBe("sub-1")
    expect(result.value.headCommit).toBe("head-commit-hash")
    expect(result.value.baseCommit).toBe("base-commit-hash")
    expect(result.value.targetBranch).toBe("main")
  })

  it("replays a repeated enqueue with the same idempotency key", () => {
    const cmd = {
      deviceId: "dev-1",
      idempotencyKey: "enqueue-key-replayyyyy",
      projectId: "project-a",
      submissionId: "sub-replay",
      headCommit: "head-hash",
      baseCommit: "base-hash",
      targetBranch: "main",
      actorId: "user-1"
    }
    const first = harness.services.enqueueSubmission(cmd)
    const second = harness.services.enqueueSubmission(cmd)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.value.id).toBe(first.value.id)
    expect(second.value.submissionId).toBe(first.value.submissionId)
  })

  it("rejects invalid idempotency key", () => {
    expect(() =>
      harness.services.enqueueSubmission({
        deviceId: "dev-1",
        idempotencyKey: "short",
        projectId: "project-a",
        submissionId: "sub-2",
        headCommit: "head",
        baseCommit: "base",
        targetBranch: "main",
        actorId: "user-1"
      })
    ).toThrow(MergeQueueError)
  })

  it("rejects enqueue by a non-member", () => {
    expect(() =>
      harness.services.enqueueSubmission({
        deviceId: "dev-outsider",
        idempotencyKey: "outsider-key-aaaaaaaa",
        projectId: "project-a",
        submissionId: "sub-outsider",
        headCommit: "head-outsider",
        baseCommit: "base-outsider",
        targetBranch: "main",
        actorId: "user-outsider"
      })
    ).toThrowError(/project member/)
  })

  it("processes a single entry through the full happy path", async () => {
    const enqueued = harness.services.enqueueSubmission({
      deviceId: "dev-1",
      idempotencyKey: "happy-path-key-aaaaaa",
      projectId: "project-a",
      submissionId: "sub-happy",
      headCommit: "head-happy",
      baseCommit: "base-happy",
      targetBranch: "main",
      actorId: "user-1"
    })
    expect(enqueued.replayed).toBe(false)

    const result = await harness.services.processEntry(enqueued.value.id)
    expect(result.status).toBe("merged")
    expect(result.mergeCommit).toBe("merge-commit-hash")

    // verify entry in database
    const entry = harness.database.prepare("SELECT * FROM merge_queue_entries WHERE id=?").get(enqueued.value.id) as Record<string, unknown> | undefined
    expect(entry).toBeDefined()
    expect(entry!.status).toBe("merged")
  })

  it("handles process crash recovery by reconciling interrupted entries", async () => {
    // Manually set an entry to "checking" to simulate a crash
    const now = new Date().toISOString()
    harness.database.prepare(
      "INSERT INTO merge_queue_entries(id,project_id,submission_id,head_commit,base_commit,target_branch,status,worktree_path,check_logs,review_verdict,error_details,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run("mqe_crashed", "project-a", "sub-crash", "head-crash", "base-crash", "main", "checking", "/tmp/worktree-crash", null, null, null, now, now)

    const result = await harness.services.reconcileOnStartup()
    expect(result.reconciledEntries).toContain("mqe_crashed")

    // Verify entry was reset to pending
    const entry = harness.database.prepare("SELECT * FROM merge_queue_entries WHERE id=?").get("mqe_crashed") as Record<string, unknown> | undefined
    expect(entry!.status).toBe("pending")
    expect(entry!.worktree_path).toBeNull()
  })

  it("reconciles entries with worktree paths by removing them", async () => {
    const now = new Date().toISOString()
    harness.database.prepare(
      "INSERT INTO merge_queue_entries(id,project_id,submission_id,head_commit,base_commit,target_branch,status,worktree_path,check_logs,review_verdict,error_details,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run("mqe_wt", "project-a", "sub-wt", "head-wt", "base-wt", "main", "merging", "/tmp/worktree-wt", null, null, null, now, now)

    const result = await harness.services.reconcileOnStartup()
    expect(result.reconciledEntries).toContain("mqe_wt")
    expect(harness.removedWorktrees.has("/tmp/worktree-wt")).toBe(true)
  })

  it("detects conflict during merge", async () => {
    const conflictWm = createMockWorktreeManager({
      mergeEntry: async () => ({ mergeCommit: "", conflict: true, conflictFiles: ["src/conflict.ts"] })
    })

    const conflictHarness = await createTestHarness()
    try {
      conflictHarness.seedProject("project-conflict")
      conflictHarness.seedConfig("project-conflict")

      // Override the services to use the conflict mock
      // We need to create new services with the conflict mock
      const svc = createMergeQueueServices({
        database: conflictHarness.database,
        config: { dataDirectory: conflictHarness.dataDirectory, requireApproval: false, checkExecutionMode: "host" },
        worktreeManager: conflictWm
      })

      const enqueued = svc.enqueueSubmission({
        deviceId: "dev-1",
        idempotencyKey: "conflict-key-aaaaaaaa",
        projectId: "project-conflict",
        submissionId: "sub-conflict",
        headCommit: "head-conflict",
        baseCommit: "base-conflict",
        targetBranch: "main",
        actorId: "user-1"
      })

      const result = await svc.processEntry(enqueued.value.id)
      expect(result.status).toBe("conflict")
      expect(result.error).toContain("conflict")

      // verify entry status in database
      const entry = conflictHarness.database.prepare("SELECT * FROM merge_queue_entries WHERE id=?").get(enqueued.value.id) as Record<string, unknown> | undefined
      expect(entry!.status).toBe("conflict")
    } finally {
      await cleanupHarness(conflictHarness)
    }
  })

  it("detects stale target (target moved during processing)", async () => {
    let callCount = 0
    const staleWm = createMockWorktreeManager({
      getTargetHead: async () => {
        callCount++
        return callCount === 1 ? "target-v1" : "target-v2-moved"
      }
    })

    const staleHarness = await createTestHarness()
    try {
      staleHarness.seedProject("project-stale")
      staleHarness.seedConfig("project-stale")

      const svc = createMergeQueueServices({
        database: staleHarness.database,
        config: { dataDirectory: staleHarness.dataDirectory, requireApproval: false, checkExecutionMode: "host" },
        worktreeManager: staleWm
      })

      const enqueued = svc.enqueueSubmission({
        deviceId: "dev-1",
        idempotencyKey: "stale-key-aaaaaaaaaa",
        projectId: "project-stale",
        submissionId: "sub-stale",
        headCommit: "head-stale",
        baseCommit: "base-stale",
        targetBranch: "main",
        actorId: "user-1"
      })

      const result = await svc.processEntry(enqueued.value.id)
      expect(result.status).toBe("failed")
      expect(result.error).toContain("moved")
    } finally {
      await cleanupHarness(staleHarness)
    }
  })

  it("detects ancestry validation failure", async () => {
    const ancestryWm = createMockWorktreeManager({
      verifyAncestry: async () => ({ valid: false, reason: "Head is not a descendant of base." })
    })

    const ancestryHarness = await createTestHarness()
    try {
      ancestryHarness.seedProject("project-ancestry")
      ancestryHarness.seedConfig("project-ancestry")

      const svc = createMergeQueueServices({
        database: ancestryHarness.database,
        config: { dataDirectory: ancestryHarness.dataDirectory, requireApproval: false, checkExecutionMode: "host" },
        worktreeManager: ancestryWm
      })

      const enqueued = svc.enqueueSubmission({
        deviceId: "dev-1",
        idempotencyKey: "ancestry-key-aaaaaaaa",
        projectId: "project-ancestry",
        submissionId: "sub-ancestry",
        headCommit: "head-ancestry",
        baseCommit: "base-ancestry",
        targetBranch: "main",
        actorId: "user-1"
      })

      const result = await svc.processEntry(enqueued.value.id)
      expect(result.status).toBe("failed")
      expect(result.error).toContain("not a descendant")
    } finally {
      await cleanupHarness(ancestryHarness)
    }
  })

  it("handles check failure (lint/build/test exit code != 0)", async () => {
    const checkFailWm = createMockWorktreeManager({
      runCommand: async (path, cmd) => {
        if (cmd[0] === "pnpm") {
          return { stdout: "", stderr: "Lint errors found", exitCode: 1 }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      }
    })

    const checkHarness = await createTestHarness()
    try {
      checkHarness.seedProject("project-check")
      checkHarness.seedConfig("project-check")

      const svc = createMergeQueueServices({
        database: checkHarness.database,
        config: { dataDirectory: checkHarness.dataDirectory, requireApproval: false, checkExecutionMode: "host" },
        worktreeManager: checkFailWm
      })

      const enqueued = svc.enqueueSubmission({
        deviceId: "dev-1",
        idempotencyKey: "check-fail-key-aaaaaa",
        projectId: "project-check",
        submissionId: "sub-checkfail",
        headCommit: "head-checkfail",
        baseCommit: "base-checkfail",
        targetBranch: "main",
        actorId: "user-1"
      })

      const result = await svc.processEntry(enqueued.value.id)
      expect(result.status).toBe("failed")
      expect(result.error).toContain("failed")

      const entry = checkHarness.database.prepare("SELECT * FROM merge_queue_entries WHERE id=?").get(enqueued.value.id) as Record<string, unknown> | undefined
      expect(entry!.status).toBe("failed")
      expect(entry!.check_logs).not.toBeNull()
    } finally {
      await cleanupHarness(checkHarness)
    }
  })

  it("does not execute contributor-controlled checks on the host by default", async () => {
    let commandCalls = 0
    const services = createMergeQueueServices({
      database: harness.database,
      config: { dataDirectory: harness.dataDirectory, requireApproval: false },
      worktreeManager: createMockWorktreeManager({
        runCommand: async () => {
          commandCalls += 1
          return { stdout: "", stderr: "", exitCode: 0 }
        }
      })
    })
    const enqueued = services.enqueueSubmission({
      deviceId: "dev-1", idempotencyKey: "disabled-checks-key-aaaa", projectId: "project-a",
      submissionId: "sub-disabled-checks", headCommit: "head", baseCommit: "base", targetBranch: "main", actorId: "user-1"
    })
    const result = await services.processEntry(enqueued.value.id)
    expect(result.status).toBe("failed")
    expect(result.error).toContain("host command execution is disabled")
    expect(commandCalls).toBe(0)
  })

  it("processes queue with multiple entries", async () => {
    const e1 = harness.services.enqueueSubmission({
      deviceId: "dev-1",
      idempotencyKey: "queue-key-1-aaaaaaaaa",
      projectId: "project-a",
      submissionId: "sub-q1",
      headCommit: "head-q1",
      baseCommit: "base-q1",
      targetBranch: "main",
      actorId: "user-1"
    })

    const e2 = harness.services.enqueueSubmission({
      deviceId: "dev-1",
      idempotencyKey: "queue-key-2-aaaaaaaaa",
      projectId: "project-a",
      submissionId: "sub-q2",
      headCommit: "head-q2",
      baseCommit: "base-q2",
      targetBranch: "main",
      actorId: "user-1"
    })

    const results = await harness.services.processQueue("project-a")
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === "merged")).toBe(true)
  })

  it("claims a pending entry atomically when processors race", async () => {
    let mergeCalls = 0
    const racingServices = createMergeQueueServices({
      database: harness.database,
      config: { dataDirectory: harness.dataDirectory, requireApproval: false, checkExecutionMode: "host" },
      worktreeManager: createMockWorktreeManager({
        mergeEntry: async () => {
          mergeCalls += 1
          return { mergeCommit: "one-merge", conflict: false, conflictFiles: [] }
        }
      })
    })
    const enqueued = racingServices.enqueueSubmission({
      deviceId: "dev-1",
      idempotencyKey: "race-claim-key-aaaaaaaa",
      projectId: "project-a",
      submissionId: "sub-race",
      headCommit: "head-race",
      baseCommit: "base-race",
      targetBranch: "main",
      actorId: "user-1"
    })

    const results = await Promise.all([
      racingServices.processEntry(enqueued.value.id),
      racingServices.processEntry(enqueued.value.id)
    ])

    expect(mergeCalls).toBe(1)
    expect(results.some((result) => result.status === "merged")).toBe(true)
  })

  it("requires an authorized review and resumes approved entries", async () => {
    const reviewServices = createMergeQueueServices({
      database: harness.database,
      config: { dataDirectory: harness.dataDirectory, requireApproval: true, checkExecutionMode: "host" },
      worktreeManager: harness.mockWm
    })
    const enqueued = reviewServices.enqueueSubmission({
      deviceId: "dev-1",
      idempotencyKey: "review-flow-key-aaaaaaaa",
      projectId: "project-a",
      submissionId: "sub-review",
      headCommit: "head-review",
      baseCommit: "base-review",
      targetBranch: "main",
      actorId: "user-1"
    })
    expect((await reviewServices.processEntry(enqueued.value.id)).status).toBe("reviewing")

    await expect(reviewServices.reviewEntry({
      deviceId: "dev-1",
      idempotencyKey: "review-denied-key-aaaa",
      entryId: enqueued.value.id,
      actorId: "user-1",
      verdict: "approve"
    })).rejects.toThrow(/owner or maintainer/)

    harness.database.prepare("UPDATE memberships SET role='maintainer' WHERE project_id=? AND user_id=?").run("project-a", "user-1")
    const result = await reviewServices.reviewEntry({
      deviceId: "dev-1",
      idempotencyKey: "review-approved-key-aa",
      entryId: enqueued.value.id,
      actorId: "user-1",
      verdict: "approve"
    })
    expect(result.status).toBe("merged")
    const row = harness.database.prepare("SELECT status,review_verdict FROM merge_queue_entries WHERE id=?").get(enqueued.value.id)
    expect(row).toMatchObject({ status: "merged", review_verdict: "approved" })
  })

  it("keeps reviewing entries stable across startup reconciliation", async () => {
    const now = new Date().toISOString()
    harness.database.prepare(
      "INSERT INTO merge_queue_entries(id,project_id,submission_id,head_commit,base_commit,target_branch,status,worktree_path,check_logs,review_verdict,error_details,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run("mqe_reviewing", "project-a", "sub-reviewing", "head", "base", "main", "reviewing", "/tmp/reviewing-worktree", null, null, null, now, now)

    const result = await harness.services.reconcileOnStartup()
    const row = harness.database.prepare("SELECT status,worktree_path FROM merge_queue_entries WHERE id=?").get("mqe_reviewing")
    expect(result.reconciledEntries).not.toContain("mqe_reviewing")
    expect(row).toMatchObject({ status: "reviewing", worktree_path: "/tmp/reviewing-worktree" })
  })

  it("does not lose contributor commits when an entry fails", async () => {
    const failWm = createMockWorktreeManager({
      verifyAncestry: async () => ({ valid: false, reason: "Bad ancestry." })
    })

    const failHarness = await createTestHarness()
    try {
      failHarness.seedProject("project-fail")
      failHarness.seedConfig("project-fail")

      const svc = createMergeQueueServices({
        database: failHarness.database,
        config: { dataDirectory: failHarness.dataDirectory, requireApproval: false, checkExecutionMode: "host" },
        worktreeManager: failWm
      })

      const enqueued = svc.enqueueSubmission({
        deviceId: "dev-1",
        idempotencyKey: "no-lose-key-aaaaaaaaa",
        projectId: "project-fail",
        submissionId: "sub-nolose",
        headCommit: "head-nolose",
        baseCommit: "base-nolose",
        targetBranch: "main",
        actorId: "user-1"
      })

      const result = await svc.processEntry(enqueued.value.id)
      expect(result.status).toBe("failed")

      // The entry should still exist in the database with all its commit data
      const entry = failHarness.database.prepare("SELECT * FROM merge_queue_entries WHERE id=?").get(enqueued.value.id) as Record<string, unknown> | undefined
      expect(entry).toBeDefined()
      expect(entry!.head_commit).toBe("head-nolose")
      expect(entry!.base_commit).toBe("base-nolose")
      expect(entry!.submission_id).toBe("sub-nolose")
    } finally {
      await cleanupHarness(failHarness)
    }
  })
})

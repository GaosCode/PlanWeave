import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { createWorktreeManager } from "../worktreeManager.js"
import type { MergeQueueConfig, MergeQueueEntry } from "../types.js"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim()
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("worktree manager", () => {
  it("creates a real merge commit and atomically advances the target ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-worktree-"))
    temporaryDirectories.push(root)
    const source = join(root, "source")
    const bareRepoPath = join(root, "repo.git")
    const worktreesDir = join(root, "worktrees")
    await execFileAsync("git", ["init", "-b", "main", source])
    await git(source, "config", "user.name", "Test User")
    await git(source, "config", "user.email", "test@example.com")
    await writeFile(join(source, "base.txt"), "base\n", "utf8")
    await git(source, "add", ".")
    await git(source, "commit", "-m", "base")
    const baseCommit = await git(source, "rev-parse", "HEAD")
    await git(source, "checkout", "-b", "feature")
    await writeFile(join(source, "feature.txt"), "feature\n", "utf8")
    await git(source, "add", ".")
    await git(source, "commit", "-m", "feature")
    const headCommit = await git(source, "rev-parse", "HEAD")
    await execFileAsync("git", ["clone", "--bare", source, bareRepoPath])

    const config: MergeQueueConfig = {
      bareRepoPath,
      worktreesDir,
      checks: [],
      checkExecutionMode: "disabled",
      requireApproval: false,
      maxConcurrent: 1,
      retentionDays: 1
    }
    const entry: MergeQueueEntry = {
      id: "integration",
      projectId: "project",
      submissionId: "submission",
      headCommit,
      baseCommit,
      targetBranch: "main",
      status: "checking",
      worktreePath: null,
      checkLogs: null,
      reviewVerdict: null,
      errorDetails: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const manager = createWorktreeManager()
    const worktreePath = await manager.createWorktree(entry, config)
    const result = await manager.mergeEntry(worktreePath, "merge-integration", "main")

    expect(result.conflict).toBe(false)
    expect(await git(source, "--git-dir", bareRepoPath, "rev-parse", "refs/heads/main")).toBe(result.mergeCommit)
    const parents = (await git(source, "--git-dir", bareRepoPath, "show", "-s", "--format=%P", result.mergeCommit)).split(" ")
    expect(parents).toEqual([baseCommit, headCommit])
  })
})

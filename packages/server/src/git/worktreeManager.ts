import { execFile } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { MergeQueueError, type MergeQueueConfig, type MergeQueueEntry } from "./types.js"

const execFileAsync = promisify(execFile)

export type WorktreeManager = {
  initBareRepo(config: MergeQueueConfig): Promise<void>
  createWorktree(entry: MergeQueueEntry, config: MergeQueueConfig): Promise<string>
  removeWorktree(worktreePath: string, config: MergeQueueConfig): Promise<void>
  garbageCollect(config: MergeQueueConfig): Promise<{ removedWorktrees: string[]; errors: string[] }>
  getTargetHead(bareRepoPath: string, branch: string): Promise<string>
  mergeEntry(worktreePath: string, headBranch: string, targetBranch: string): Promise<{ mergeCommit: string; conflict: boolean; conflictFiles: string[] }>
  verifyAncestry(bareRepoPath: string, headCommit: string, baseCommit: string): Promise<{ valid: boolean; reason?: string }>
  changedFilesInRange(bareRepoPath: string, baseCommit: string, headCommit: string): Promise<string[]>
  runCommand(worktreePath: string, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

function gitBare(bareRepoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["--git-dir", bareRepoPath, ...args], {
    maxBuffer: 10 * 1024 * 1024
  })
}

function gitWorktree(worktreePath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024
  })
}

function gitWorktreePrune(bareRepoPath: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", bareRepoPath, "worktree", "prune"], {
    maxBuffer: 10 * 1024 * 1024
  })
}

function gitWorktreeAdd(bareRepoPath: string, worktreePath: string, baseCommit: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", bareRepoPath, "worktree", "add", "--detach", worktreePath, baseCommit], {
    maxBuffer: 10 * 1024 * 1024
  })
}

function gitWorktreeRemove(bareRepoPath: string, worktreePath: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", bareRepoPath, "worktree", "remove", "--force", worktreePath], {
    maxBuffer: 10 * 1024 * 1024
  })
}

export function createWorktreeManager(): WorktreeManager {
  const initBareRepo = async (config: MergeQueueConfig): Promise<void> => {
    await mkdir(config.bareRepoPath, { recursive: true })
    await mkdir(config.worktreesDir, { recursive: true })
    try {
      await execFileAsync("git", ["init", "--bare", config.bareRepoPath])
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("already exists"))) {
        throw new MergeQueueError("worktree_error", "Failed to initialize bare repository.", {
          worktreePath: config.bareRepoPath
        })
      }
    }
  }

  const createWorktree = async (entry: MergeQueueEntry, config: MergeQueueConfig): Promise<string> => {
    const worktreePath = resolve(join(config.worktreesDir, `entry-${entry.id}`))
    try {
      const { stderr } = await gitWorktreeAdd(config.bareRepoPath, worktreePath, entry.baseCommit)
      if (stderr && !stderr.includes("Preparing worktree")) {
        throw new MergeQueueError("worktree_error", `Failed to create worktree: ${stderr}`, {
          entryId: entry.id,
          worktreePath,
          stderr
        })
      }
    } catch (error) {
      if (error instanceof MergeQueueError) throw error
      const msg = error instanceof Error ? error.message : String(error)
      throw new MergeQueueError("worktree_error", `Failed to create worktree: ${msg}`, {
        entryId: entry.id,
        worktreePath
      })
    }
    const headBranch = `merge-${entry.id}`
    try {
      await gitWorktree(worktreePath, ["checkout", "-b", headBranch, entry.headCommit])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new MergeQueueError("worktree_error", `Failed to create merge branch: ${msg}`, {
        entryId: entry.id,
        headCommit: entry.headCommit,
        worktreePath
      })
    }
    return worktreePath
  }

  const removeWorktree = async (worktreePath: string, config: MergeQueueConfig): Promise<void> => {
    try {
      await gitWorktreeRemove(config.bareRepoPath, worktreePath)
    } catch {
      try {
        await rm(worktreePath, { recursive: true, force: true })
      } catch { /* best effort */ }
    }
    try {
      await gitWorktreePrune(config.bareRepoPath)
    } catch { /* best effort */ }
  }

  const garbageCollect = async (config: MergeQueueConfig): Promise<{ removedWorktrees: string[]; errors: string[] }> => {
    const removedWorktrees: string[] = []
    const errors: string[] = []
    try {
      const { stdout } = await execFileAsync("git", [
        "-C", config.bareRepoPath,
        "worktree", "list", "--porcelain"
      ], { maxBuffer: 10 * 1024 * 1024 })
      const lines = stdout.split("\n")
      let currentPath = ""
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          currentPath = line.slice("worktree ".length)
        }
        if (line === "prunable" && currentPath) {
          try {
            await removeWorktree(currentPath, config)
            removedWorktrees.push(currentPath)
          } catch (error) {
            errors.push(`Failed to prune ${currentPath}: ${error instanceof Error ? error.message : String(error)}`)
          }
          currentPath = ""
        }
      }
    } catch (error) {
      errors.push(`Failed to list worktrees: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { removedWorktrees, errors }
  }

  const SAFE_BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/;

  const getTargetHead = async (bareRepoPath: string, branch: string): Promise<string> => {
    if (!SAFE_BRANCH_RE.test(branch)) throw new MergeQueueError("validation_failed", `Invalid branch name: '${branch}'.`, { targetBranch: branch });
    try {
      const { stdout } = await gitBare(bareRepoPath, ["rev-parse", `refs/heads/${branch}`])
      return stdout.trim()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new MergeQueueError("validation_failed", `Failed to resolve target branch '${branch}': ${msg}`, {
        targetBranch: branch
      })
    }
  }

  const mergeEntry = async (worktreePath: string, headBranch: string, targetBranch: string): Promise<{ mergeCommit: string; conflict: boolean; conflictFiles: string[] }> => {
    if (!SAFE_BRANCH_RE.test(targetBranch)) throw new MergeQueueError("validation_failed", `Invalid branch name: '${targetBranch}'.`, { targetBranch });
    let targetHead: string
    try {
      targetHead = (await gitWorktree(worktreePath, ["rev-parse", `refs/heads/${targetBranch}`])).stdout.trim()
      await gitWorktree(worktreePath, ["checkout", "--detach", targetHead])
    } catch (error) {
      throw new MergeQueueError("worktree_error", `Failed to checkout target branch '${targetBranch}'.`, {
        worktreePath,
        targetBranch,
        stderr: error instanceof Error ? error.message : String(error)
      })
    }

    try {
      await gitWorktree(worktreePath, ["merge-base", "--is-ancestor", headBranch, targetHead])
      return { mergeCommit: targetHead, conflict: false, conflictFiles: [] }
    } catch { /* not already merged */ }

    try {
      await gitWorktree(worktreePath, ["merge", "--no-ff", "--no-commit", headBranch])
      await gitWorktree(worktreePath, [
        "-c", "user.name=PlanWeave Merge Queue",
        "-c", "user.email=merge-queue@planweave.local",
        "commit", "--no-edit"
      ])
      const finalRev = (await gitWorktree(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()
      try {
        await gitWorktree(worktreePath, ["update-ref", `refs/heads/${targetBranch}`, finalRev, targetHead])
      } catch (error) {
        throw new MergeQueueError("stale_target", `Target branch '${targetBranch}' moved while the merge was being committed.`, {
          worktreePath,
          targetBranch,
          stderr: error instanceof Error ? error.message : String(error)
        })
      }
      return { mergeCommit: finalRev, conflict: false, conflictFiles: [] }
    } catch (error) {
      const { stdout: statusOut } = await gitWorktree(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "", stderr: "" }))
      const conflictFiles = statusOut.trim().split("\n").filter(Boolean)
      await gitWorktree(worktreePath, ["merge", "--abort"]).catch(() => {})
      if (conflictFiles.length > 0) {
        return { mergeCommit: "", conflict: true, conflictFiles }
      }
      if (error instanceof MergeQueueError) throw error
      throw new MergeQueueError("worktree_error", "Git failed to create or publish the merge commit.", {
        worktreePath,
        targetBranch,
        stderr: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const verifyAncestry = async (bareRepoPath: string, headCommit: string, baseCommit: string): Promise<{ valid: boolean; reason?: string }> => {
    try {
      await gitBare(bareRepoPath, ["merge-base", "--is-ancestor", baseCommit, headCommit])
      return { valid: true }
    } catch {
      try {
        const { stdout } = await gitBare(bareRepoPath, ["merge-base", baseCommit, headCommit])
        const mergeBase = stdout.trim()
        if (mergeBase === baseCommit) {
          return { valid: true }
        }
        return { valid: false, reason: `baseCommit ${baseCommit.slice(0, 8)} is not an ancestor of headCommit ${headCommit.slice(0, 8)}` }
      } catch {
        return { valid: false, reason: "Could not verify ancestry between commits." }
      }
    }
  }

  const changedFilesInRange = async (bareRepoPath: string, baseCommit: string, headCommit: string): Promise<string[]> => {
    try {
      const { stdout } = await gitBare(bareRepoPath, ["diff", "--name-only", `${baseCommit}..${headCommit}`])
      return stdout.trim().split("\n").filter(Boolean)
    } catch {
      return []
    }
  }

  const runCommand = async (worktreePath: string, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    if (command.length === 0) return { stdout: "", stderr: "", exitCode: 0 }
    const [cmd, ...args] = command
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: worktreePath,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000
      })
      return { stdout, stderr, exitCode: 0 }
    } catch (error) {
      if (error instanceof Error && "stdout" in error && "stderr" in error && "code" in error) {
        const execErr = error as unknown as { stdout: string; stderr: string; code: number; killed: boolean }
        return { stdout: execErr.stdout ?? "", stderr: execErr.stderr ?? "", exitCode: execErr.code ?? 1 }
      }
      return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }
    }
  }

  return {
    initBareRepo,
    createWorktree,
    removeWorktree,
    garbageCollect,
    getTargetHead,
    mergeEntry,
    verifyAncestry,
    changedFilesInRange,
    runCommand
  }
}

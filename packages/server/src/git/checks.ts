import { MergeQueueError, type CheckResult } from "./types.js"
import type { WorktreeManager } from "./worktreeManager.js"

export type CheckContext = {
  worktreeManager: WorktreeManager
}

export async function runTargetedChecks(
  worktreePath: string,
  taskChecks: string[],
  ctx: CheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of taskChecks) {
    const result = await runSingleCheck(worktreePath, check, ctx)
    results.push(result)
    if (!result.passed) break
  }
  return results
}

const defaultRepositoryChecks: Array<{ name: string; command: string[] }> = [
  { name: "pnpm-lint", command: ["pnpm", "lint"] },
  { name: "pnpm-build", command: ["pnpm", "-r", "build"] },
  { name: "pnpm-test", command: ["pnpm", "test"] }
]

export async function runRepositoryChecks(
  worktreePath: string,
  ctx: CheckContext,
  enabledChecks: string[] = defaultRepositoryChecks.map((check) => check.name)
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const selected = enabledChecks.map((name) => {
    const check = defaultRepositoryChecks.find((candidate) => candidate.name === name)
    if (!check) throw new MergeQueueError("validation_failed", `Unknown repository check '${name}'.`, { checkName: name })
    return check
  })
  for (const check of selected) {
    const start = Date.now()
    const { stdout, stderr, exitCode } = await ctx.worktreeManager.runCommand(
      worktreePath,
      check.command
    )
    const durationMs = Date.now() - start
    const passed = exitCode === 0
    results.push({
      name: check.name,
      passed,
      durationMs,
      stdout: String(stdout).slice(0, 10000),
      stderr: String(stderr).slice(0, 10000),
      exitCode
    })
    if (!passed) {
      throw new MergeQueueError("check_failed", `Check '${check.name}' failed with exit code ${exitCode}.`, {
        checkName: check.name,
        exitCode,
        stdout: String(stdout).slice(0, 2048),
        stderr: String(stderr).slice(0, 2048)
      })
    }
  }
  return results
}

export async function runSingleCheck(
  worktreePath: string,
  checkCommand: string,
  ctx: CheckContext
): Promise<CheckResult> {
  const parts = checkCommand.trim().split(/\s+/)
  const start = Date.now()
  const { stdout, stderr, exitCode } = await ctx.worktreeManager.runCommand(
    worktreePath,
    parts
  )
  const durationMs = Date.now() - start
  const passed = exitCode === 0
  return {
    name: parts[0] ?? checkCommand,
    passed,
    durationMs,
    stdout: String(stdout).slice(0, 10000),
    stderr: String(stderr).slice(0, 10000),
    exitCode
  }
}

export function retainCheckLogs(results: CheckResult[]): string {
  return JSON.stringify(results)
}

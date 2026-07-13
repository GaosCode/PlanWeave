import { gitExec, GitError } from "./client.js";
import type { GitCommitResult } from "./types.js";

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    await gitExec(["diff-index", "--quiet", "HEAD", "--"], { cwd });
    return false;
  } catch {
    return true;
  }
}

export async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await gitExec(["diff-index", "--quiet", "--cached", "HEAD", "--"], { cwd });
    return false;
  } catch {
    return true;
  }
}

export async function stageFiles(cwd: string, files: string[]): Promise<void> {
  try {
    await gitExec(["add", "--", ...files], { cwd });
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to stage files: ${error instanceof Error ? error.message : String(error)}`,
      "stage_error",
    );
  }
}

export async function stageAll(cwd: string): Promise<void> {
  try {
    await gitExec(["add", "-A"], { cwd });
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to stage all files: ${error instanceof Error ? error.message : String(error)}`,
      "stage_error",
    );
  }
}

export async function commit(
  cwd: string,
  message: string,
  options: { allowEmpty?: boolean } = {},
): Promise<GitCommitResult> {
  try {
    const args = ["commit", "-m", message];
    if (options.allowEmpty) args.push("--allow-empty");

    const { stdout } = await gitExec(args, { cwd });
    const hash = await getHeadCommit(cwd);
    return { hash, message };
  } catch (error) {
    if (error instanceof GitError) throw error;
    const stderr = error instanceof Error ? error.message : String(error);
    if (stderr.includes("nothing to commit") || stderr.includes("nothing added to commit")) {
      throw new GitError("Nothing to commit", "nothing_to_commit", stderr);
    }
    throw new GitError(`Failed to commit: ${stderr}`, "commit_error", stderr);
  }
}

async function getHeadCommit(cwd: string): Promise<string> {
  const { stdout } = await gitExec(["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

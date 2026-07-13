import { gitExec, GitError } from "./client.js";
import type { GitBranch } from "./types.js";

export async function getBranches(cwd: string): Promise<GitBranch[]> {
  try {
    const { stdout } = await gitExec(
      ["branch", "-a", "--format=%(refname:short)|%(HEAD)|%(objectname:short)"],
      { cwd },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, head, hash] = line.split("|");
        const isRemote = name.startsWith("remotes/") || name.startsWith("origin/");
        return {
          name: isRemote ? name.replace(/^remotes\//, "") : name,
          current: head === "*",
          remote: isRemote,
        };
      });
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to list branches: ${error instanceof Error ? error.message : String(error)}`,
      "branch_error",
    );
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return stdout.trim();
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`,
      "branch_error",
    );
  }
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  try {
    await gitExec(["checkout", "-b", name], { cwd });
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to create branch '${name}': ${error instanceof Error ? error.message : String(error)}`,
      "branch_error",
    );
  }
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  try {
    await gitExec(["checkout", branch], { cwd });
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to checkout '${branch}': ${error instanceof Error ? error.message : String(error)}`,
      "checkout_error",
    );
  }
}

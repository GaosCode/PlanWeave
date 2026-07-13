import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitExecOptions {
  cwd: string;
  maxBuffer?: number;
  timeout?: number;
}

export async function gitExec(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd: options.cwd,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export function isGitRepo(cwd: string): Promise<boolean> {
  return gitExec(["rev-parse", "--git-dir"], { cwd })
    .then(() => true)
    .catch(() => false);
}

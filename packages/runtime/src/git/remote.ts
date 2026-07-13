import { gitExec, GitError } from "./client.js";
import type { GitPushPullResult, GitRemote, GitRepoInfo } from "./types.js";

export async function getRemotes(cwd: string): Promise<GitRemote[]> {
  try {
    const { stdout } = await gitExec(["remote", "-v"], { cwd });
    const remotes = new Map<string, GitRemote>();

    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (match) {
        const [, name, url, type] = match;
        if (!remotes.has(name)) {
          remotes.set(name, { name, fetchUrl: "", pushUrl: "" });
        }
        const remote = remotes.get(name)!;
        if (type === "fetch") remote.fetchUrl = url;
        if (type === "push") remote.pushUrl = url;
      }
    }

    return [...remotes.values()];
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to get remotes: ${error instanceof Error ? error.message : String(error)}`,
      "remote_error",
    );
  }
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const sshMatch = url.match(/^git@github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/, "") };
  }

  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/, "") };
  }

  return null;
}

export async function getRepoInfo(cwd: string): Promise<GitRepoInfo> {
  const remotes = await getRemotes(cwd);
  const origin = remotes.find((r) => r.name === "origin");

  let owner: string | null = null;
  let repo: string | null = null;

  if (origin) {
    const parsed = parseGitHubRemote(origin.fetchUrl);
    if (parsed) {
      owner = parsed.owner;
      repo = parsed.repo;
    }
  }

  return {
    owner,
    repo,
    remotes,
    defaultRemote: origin?.name ?? null,
  };
}

export async function push(cwd: string, remote = "origin", branch?: string): Promise<GitPushPullResult> {
  try {
    const args = ["push", remote];
    if (branch) args.push(branch);

    const { stdout, stderr } = await gitExec(args, { cwd, timeout: 120_000 });
    return { success: true, output: stdout + stderr };
  } catch (error) {
    if (error instanceof GitError) {
      return { success: false, output: error.stderr ?? error.message };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: msg };
  }
}

export async function pull(cwd: string, remote = "origin", branch?: string): Promise<GitPushPullResult> {
  try {
    const args = ["pull", remote];
    if (branch) args.push(branch);

    const { stdout, stderr } = await gitExec(args, { cwd, timeout: 120_000 });
    return { success: true, output: stdout + stderr };
  } catch (error) {
    if (error instanceof GitError) {
      return { success: false, output: error.stderr ?? error.message };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: msg };
  }
}

export async function fetch(cwd: string, remote = "origin"): Promise<GitPushPullResult> {
  try {
    const { stdout, stderr } = await gitExec(["fetch", remote], { cwd, timeout: 120_000 });
    return { success: true, output: stdout + stderr };
  } catch (error) {
    if (error instanceof GitError) {
      return { success: false, output: error.stderr ?? error.message };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: msg };
  }
}

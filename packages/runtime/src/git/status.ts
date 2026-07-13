import { gitExec, GitError } from "./client.js";
import type { FileStatus, GitCommit, GitDiffResult, GitStatus } from "./types.js";

function parsePorcelainV2(stdout: string): { branch: GitStatus; files: FileStatus[] } {
  const files: FileStatus[] = [];
  const status: GitStatus = { branch: "", ahead: 0, behind: 0, files: [], clean: true };

  for (const line of stdout.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.oid ")) continue;
    if (line.startsWith("# branch.head ")) {
      status.branch = line.slice("# branch.head ".length);
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const parts = line.slice("# branch.ab ".length).split(" ");
      status.ahead = parseInt(parts[0]?.replace("+", "") ?? "0", 10);
      status.behind = parseInt(parts[1]?.replace("-", "") ?? "0", 10);
      continue;
    }

    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const fields = line.split(" ");
      const indexStatus = line.startsWith("1") || line.startsWith("2") || line.startsWith("u")
        ? (fields[1] ?? ".")
        : ".";
      const worktreeStatus = line.startsWith("u")
        ? (fields[2] ?? ".")
        : line.startsWith("1") || line.startsWith("2")
          ? (fields[2] ?? ".")
          : ".";

      let path = "";
      if (line.startsWith("2 ") && fields.length >= 10) {
        path = fields.slice(9).join(" ");
      } else if (line.startsWith("1 ") && fields.length >= 9) {
        path = fields.slice(8).join(" ");
      } else if (line.startsWith("u ") && fields.length >= 11) {
        path = fields.slice(10).join(" ");
      }

      if (path) {
        files.push({
          path,
          indexStatus,
          worktreeStatus,
          staged: indexStatus !== ".",
        });
      }
    }

    if (line.startsWith("?")) {
      const path = line.slice(2).trim();
      files.push({
        path,
        indexStatus: "?",
        worktreeStatus: "?",
        staged: false,
      });
    }
  }

  status.files = files;
  status.clean = files.length === 0;

  return { branch: status, files };
}

export async function getStatus(cwd: string): Promise<GitStatus> {
  try {
    const { stdout } = await gitExec(["status", "--porcelain=v2", "--branch"], { cwd });
    const parsed = parsePorcelainV2(stdout);
    parsed.branch.files = parsed.files;
    return parsed.branch;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to get git status: ${error instanceof Error ? error.message : String(error)}`,
      "status_error",
    );
  }
}

export async function getDiff(
  cwd: string,
  options: { staged?: boolean; files?: string[] } = {},
): Promise<GitDiffResult> {
  try {
    const args = ["diff"];
    if (options.staged) args.push("--staged");
    if (options.files?.length) args.push("--", ...options.files);

    const { stdout } = await gitExec(args, { cwd, maxBuffer: 50 * 1024 * 1024 });
    return {
      hunks: parseDiffHunks(stdout),
      raw: stdout,
    };
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`,
      "diff_error",
    );
  }
}

function parseDiffHunks(raw: string): { header: string; lines: string[] }[] {
  const hunks: { header: string; lines: string[] }[] = [];
  const lines = raw.split("\n");
  let currentHunk: string[] | null = null;
  let currentHeader = "";

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHunk) {
        hunks.push({ header: currentHeader, lines: currentHunk });
      }
      currentHunk = [];
      currentHeader = line;
    } else if (currentHunk) {
      currentHunk.push(line);
    }
  }

  if (currentHunk && currentHunk.length > 0) {
    hunks.push({ header: currentHeader, lines: currentHunk });
  }

  return hunks;
}

export async function getLog(
  cwd: string,
  options: { maxCount?: number; branch?: string } = {},
): Promise<GitCommit[]> {
  try {
    const args = [
      "log",
      "--format=%H||%h||%s||%an||%ae||%aI",
      `--max-count=${options.maxCount ?? 20}`,
    ];
    if (options.branch) args.push(options.branch);

    const { stdout } = await gitExec(args, { cwd });
    return parseLog(stdout);
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      `Failed to get git log: ${error instanceof Error ? error.message : String(error)}`,
      "log_error",
    );
  }
}

function parseLog(stdout: string): GitCommit[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, abbreviatedHash, message, authorName, authorEmail, date] = line.split("||");
      return { hash, abbreviatedHash, message, authorName, authorEmail, date };
    });
}

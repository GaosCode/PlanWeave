import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { MergeQueueError } from "./types.js";

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40,64}$/;

async function gitBare(bareRepoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["--git-dir", bareRepoPath, ...args], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
}

export async function initializeIntegrationRepository(input: { sourceRepoPath: string; bareRepoPath: string; targetBranch: string }): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(input.targetBranch)) throw new MergeQueueError("validation_failed", "Target branch is invalid", { targetBranch: input.targetBranch });
  await execFileAsync("git", ["-C", input.sourceRepoPath, "rev-parse", "--is-inside-work-tree"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  await mkdir(dirname(input.bareRepoPath), { recursive: true });
  let initialized = true;
  try { await stat(`${input.bareRepoPath}/HEAD`); } catch { initialized = false; }
  if (!initialized) {
    await execFileAsync("git", ["clone", "--bare", "--no-hardlinks", input.sourceRepoPath, input.bareRepoPath], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  } else {
    const remotes = (await gitBare(input.bareRepoPath, ["remote"])).stdout.split(/\r?\n/).filter(Boolean);
    if (remotes.includes("host-source")) await gitBare(input.bareRepoPath, ["remote", "set-url", "host-source", input.sourceRepoPath]);
    else await gitBare(input.bareRepoPath, ["remote", "add", "host-source", input.sourceRepoPath]);
    await gitBare(input.bareRepoPath, ["fetch", "--prune", "host-source", "+refs/heads/*:refs/heads/*"]);
  }
  await gitBare(input.bareRepoPath, ["rev-parse", `refs/heads/${input.targetBranch}`]);
}

export async function importSubmissionBundle(input: { bareRepoPath: string; bundlePath: string; submissionId: string; baseCommit: string; headCommit: string; maxBytes: number }): Promise<{ refName: string; headCommit: string }> {
  if (!COMMIT_RE.test(input.baseCommit) || !COMMIT_RE.test(input.headCommit)) throw new MergeQueueError("bundle_invalid", "Bundle commit ids must be full hexadecimal object ids", { baseCommit: input.baseCommit, headCommit: input.headCommit });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.submissionId)) throw new MergeQueueError("bundle_invalid", "Submission id cannot be represented as an isolated Git ref", { submissionId: input.submissionId });
  const info = await stat(input.bundlePath);
  if (info.size < 1 || info.size > input.maxBytes) throw new MergeQueueError("bundle_invalid", "Git bundle is empty or exceeds the configured limit", {});
  try {
    await gitBare(input.bareRepoPath, ["bundle", "verify", input.bundlePath]);
    const advertisedHeads = (await gitBare(input.bareRepoPath, ["bundle", "list-heads", input.bundlePath])).stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 2)[0])
      .filter(Boolean);
    if (!advertisedHeads.includes(input.headCommit)) throw new Error("Bundle does not advertise the declared head commit");
    const refName = `refs/planweave/submissions/${input.submissionId}`;
    await gitBare(input.bareRepoPath, ["fetch", "--no-tags", input.bundlePath, `${input.headCommit}:${refName}`]);
    const imported = (await gitBare(input.bareRepoPath, ["rev-parse", refName])).stdout.trim();
    if (imported !== input.headCommit) throw new Error("Imported commit differs from the immutable submission head");
    await gitBare(input.bareRepoPath, ["merge-base", "--is-ancestor", input.baseCommit, input.headCommit]);
    return { refName, headCommit: imported };
  } catch (error) {
    throw new MergeQueueError("bundle_invalid", `Git bundle could not be verified or imported: ${error instanceof Error ? error.message : String(error)}`, { headCommit: input.headCommit, baseCommit: input.baseCommit });
  }
}

export async function projectIntegrationBranch(input: { sourceRepoPath: string; bareRepoPath: string; targetBranch: string; mergeCommit: string }): Promise<{ status: "updated" | "tracking_ref" | "failed"; details: string }> {
  try {
    const trackingRef = `refs/remotes/planweave/${input.targetBranch}`;
    await execFileAsync("git", ["-C", input.sourceRepoPath, "fetch", "--no-tags", input.bareRepoPath, `refs/heads/${input.targetBranch}:${trackingRef}`], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    const currentBranch = (await execFileAsync("git", ["-C", input.sourceRepoPath, "branch", "--show-current"], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const dirty = (await execFileAsync("git", ["-C", input.sourceRepoPath, "status", "--porcelain"], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    if (currentBranch === input.targetBranch && !dirty) {
      await execFileAsync("git", ["-C", input.sourceRepoPath, "merge", "--ff-only", input.mergeCommit], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
      return { status: "updated", details: `Fast-forwarded ${input.targetBranch} to ${input.mergeCommit}` };
    }
    return { status: "tracking_ref", details: dirty ? `Host worktree has uncommitted changes; merge is available at ${trackingRef}` : `Host is on '${currentBranch || "detached HEAD"}'; merge is available at ${trackingRef}` };
  } catch (error) {
    return { status: "failed", details: error instanceof Error ? error.message : String(error) };
  }
}

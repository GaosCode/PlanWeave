import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { importSubmissionBundle, initializeIntegrationRepository, projectIntegrationBranch } from "../bundleTransport.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

describe("submission bundle transport", () => {
  it("imports only the declared descendant commit into an isolated ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-bundle-"));
    roots.push(root);
    const source = join(root, "source");
    const member = join(root, "member");
    const bare = join(root, "integration.git");
    const bundle = join(root, "submission.bundle");
    await execFile("git", ["init", "--initial-branch=main", source]);
    await git(source, "config", "user.email", "host@planweave.local");
    await git(source, "config", "user.name", "PlanWeave Host");
    await execFile("sh", ["-c", "printf base > base.txt"], { cwd: source });
    await git(source, "add", "base.txt");
    await git(source, "commit", "-m", "base");
    const baseCommit = await git(source, "rev-parse", "HEAD");

    await initializeIntegrationRepository({ sourceRepoPath: source, bareRepoPath: bare, targetBranch: "main" });
    await execFile("git", ["clone", source, member]);
    await git(member, "config", "user.email", "member@planweave.local");
    await git(member, "config", "user.name", "PlanWeave Member");
    await execFile("sh", ["-c", "printf change > change.txt"], { cwd: member });
    await git(member, "add", "change.txt");
    await git(member, "commit", "-m", "member change");
    const headCommit = await git(member, "rev-parse", "HEAD");
    await git(member, "bundle", "create", bundle, "HEAD", `^${baseCommit}`);

    const imported = await importSubmissionBundle({ bareRepoPath: bare, bundlePath: bundle, submissionId: "sub-safe", baseCommit, headCommit, maxBytes: 10 * 1024 * 1024 });
    expect(imported).toEqual({ refName: "refs/planweave/submissions/sub-safe", headCommit });
    expect(await execFile("git", ["--git-dir", bare, "rev-parse", imported.refName], { encoding: "utf8" }).then((result) => result.stdout.trim())).toBe(headCommit);
    await execFile("git", ["--git-dir", bare, "update-ref", "refs/heads/main", headCommit, baseCommit]);
    const projection = await projectIntegrationBranch({ sourceRepoPath: source, bareRepoPath: bare, targetBranch: "main", mergeCommit: headCommit });
    expect(projection.status).toBe("updated");
    expect(await git(source, "rev-parse", "HEAD")).toBe(headCommit);
  });

  it("rejects a bundle whose declared head is not present", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-bundle-invalid-"));
    roots.push(root);
    const source = join(root, "source");
    const bare = join(root, "integration.git");
    const bundle = join(root, "submission.bundle");
    await execFile("git", ["init", "--initial-branch=main", source]);
    await git(source, "config", "user.email", "host@planweave.local");
    await git(source, "config", "user.name", "PlanWeave Host");
    await execFile("sh", ["-c", "printf base > base.txt"], { cwd: source });
    await git(source, "add", "base.txt");
    await git(source, "commit", "-m", "base");
    const baseCommit = await git(source, "rev-parse", "HEAD");
    await initializeIntegrationRepository({ sourceRepoPath: source, bareRepoPath: bare, targetBranch: "main" });
    await git(source, "bundle", "create", bundle, "main");

    await expect(importSubmissionBundle({ bareRepoPath: bare, bundlePath: bundle, submissionId: "sub-wrong", baseCommit, headCommit: "a".repeat(40), maxBytes: 10 * 1024 * 1024 })).rejects.toThrow(/declared head/i);
  });
});

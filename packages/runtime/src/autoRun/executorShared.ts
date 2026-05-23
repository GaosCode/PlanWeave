import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import type { ClaimResult, ExecutorProfile, PackageWorkspaceRef } from "../types.js";

export type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
export type FeedbackClaim = Extract<ClaimResult, { kind: "feedback" }>;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function nextRunId(runRoot: string): Promise<string> {
  try {
    const entries = await readdir(runRoot, { withFileTypes: true });
    const count = entries.filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name)).length;
    return `RUN-${String(count + 1).padStart(3, "0")}`;
  } catch {
    return "RUN-001";
  }
}

export async function prepareBlockRun(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executorName: string;
  profile: ExecutorProfile;
  prompt: string;
}): Promise<{ runId: string; runDir: string; promptPath: string; metadataPath: string; startedAt: string }> {
  const { workspace } = await loadPackage(options.projectRoot);
  const { taskId, blockId } = parseBlockRef(options.claim.ref);
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  const promptPath = join(runDir, "prompt.md");
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(promptPath, options.prompt, "utf8");
  await writeJsonFile(metadataPath, {
    runId,
    ref: options.claim.ref,
    executor: options.executorName,
    adapter: options.profile.adapter,
    projectRoot: workspace.rootPath,
    executionCwd: workspace.rootPath,
    startedAt,
    finishedAt: null,
    exitCode: null,
    agentSessionId: null,
    codexSessionId: null
  });
  return { runId, runDir, promptPath, metadataPath, startedAt };
}

export async function finishRunMetadata(path: string, patch: Record<string, unknown>): Promise<void> {
  let previous: Record<string, unknown> = {};
  if (await pathExists(path)) {
    previous = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  }
  await writeJsonFile(path, { ...previous, ...patch });
}

export async function execWithStdin(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : code ?? 1, timedOut });
    });
    child.stdin.end(options.stdin);
  });
}

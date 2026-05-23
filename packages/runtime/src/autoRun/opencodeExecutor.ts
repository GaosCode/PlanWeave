import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { ExecutorAdapterResult, OpencodeExecExecutorProfile, PackageWorkspaceRef } from "../types.js";
import { execWithStdin, finishRunMetadata, nextRunId, prepareBlockRun, type BlockClaim, type FeedbackClaim } from "./executorShared.js";

function extractOpencodeSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId = parsed.sessionId ?? parsed.session_id ?? parsed.threadId ?? parsed.thread_id;
      if (typeof sessionId === "string" && sessionId.trim()) {
        return sessionId;
      }
    } catch {
      const match =
        trimmed.match(/^(?:opencodeSessionId|sessionId|session_id|session id|threadId|thread_id)\s*[:=]\s*([A-Za-z0-9_.:-]+)$/i) ??
        trimmed.match(/^\*\*Session ID:\*\*\s*([A-Za-z0-9_.:-]+)$/i) ??
        trimmed.match(/^Continue\s+opencode\s+-s\s+([A-Za-z0-9_.:-]+)$/i);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

export async function runOpencodeBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: OpencodeExecExecutorProfile;
}): Promise<ExecutorAdapterResult> {
  const run = await prepareBlockRun({
    projectRoot: options.projectRoot,
    claim: options.claim,
    executorName: options.executorName,
    profile: options.profile,
    prompt: options.prompt
  });
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  const result = await execWithStdin({
    command: options.profile.command,
    args: options.profile.args,
    cwd: workspace.rootPath,
    stdin: options.prompt,
    timeoutMs: options.profile.timeoutMs
  });
  const agentSessionId = extractOpencodeSessionId(`${result.stdout}\n${result.stderr}`);
  await writeFile(join(run.runDir, "stdout.md"), result.stdout, "utf8");
  await writeFile(join(run.runDir, "stderr.log"), result.stderr, "utf8");
  await finishRunMetadata(run.metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: options.profile.args,
    projectRoot: workspace.rootPath,
    executionCwd: workspace.rootPath,
    sandbox: options.profile.sandbox ?? null,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: result.timedOut,
    agentSessionId,
    opencodeSessionId: agentSessionId,
    resumed: false
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.timedOut
        ? `Executor '${options.executorName}' timed out after ${options.profile.timeoutMs}ms.`
        : result.stderr.trim() || `Executor '${options.executorName}' exited with code ${result.exitCode}.`
    );
  }
  if (options.claim.blockType === "review") {
    const resultPath = join(run.runDir, "review-result.json");
    await writeJsonFile(resultPath, JSON.parse(result.stdout.trim()));
    return { kind: "review", resultPath, runId: run.runId, executor: options.executorName, adapter: "opencode-exec", agentSessionId, ...result };
  }
  const reportPath = join(run.runDir, "report.md");
  await writeFile(reportPath, result.stdout, "utf8");
  return { kind: "block", reportPath, runId: run.runId, executor: options.executorName, adapter: "opencode-exec", agentSessionId, ...result };
}

export async function runOpencodeFeedback(options: {
  projectRoot: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: OpencodeExecExecutorProfile;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const result = await execWithStdin({
    command: options.profile.command,
    args: options.profile.args,
    cwd: options.projectRoot,
    stdin: options.claim.content,
    timeoutMs: options.profile.timeoutMs
  });
  const agentSessionId = extractOpencodeSessionId(`${result.stdout}\n${result.stderr}`);
  await writeFile(join(runDir, "stdout.md"), result.stdout, "utf8");
  await writeFile(join(runDir, "stderr.log"), result.stderr, "utf8");
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId,
    executor: options.executorName,
    adapter: "opencode-exec",
    projectRoot: options.projectRoot,
    executionCwd: options.projectRoot,
    startedAt: null,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: result.timedOut,
    agentSessionId,
    opencodeSessionId: agentSessionId
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.timedOut
        ? `Executor '${options.executorName}' timed out after ${options.profile.timeoutMs}ms.`
        : result.stderr.trim() || `Executor '${options.executorName}' exited with code ${result.exitCode}.`
    );
  }
  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, result.stdout, "utf8");
  return { kind: "feedback", reportPath, runId, executor: options.executorName, adapter: "opencode-exec", agentSessionId, ...result };
}

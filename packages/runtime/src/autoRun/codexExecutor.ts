import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { CodexExecExecutorProfile, ExecutorAdapterResult, PackageWorkspaceRef } from "../types.js";
import { execWithStdin, finishRunMetadata, nextRunId, prepareBlockRun, type BlockClaim, type FeedbackClaim } from "./executorShared.js";

const CODEX_STATUS_SESSION_PATTERN = /(?:^|[\s│|>])Session\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|[│|]|$)/i;

function codexExecArgs(profile: CodexExecExecutorProfile): string[] {
  if (!profile.sandbox) {
    return profile.args;
  }
  const stdinPromptIndex = profile.args.lastIndexOf("-");
  const sandboxArgs = ["--sandbox", profile.sandbox];
  if (stdinPromptIndex === -1) {
    return [...profile.args, ...sandboxArgs];
  }
  return [...profile.args.slice(0, stdinPromptIndex), ...sandboxArgs, ...profile.args.slice(stdinPromptIndex)];
}

function codexResumeArgs(profile: CodexExecExecutorProfile, sessionId: string, prompt: string): string[] {
  const execIndex = profile.args.indexOf("exec");
  const prefix = execIndex === -1 ? [] : profile.args.slice(0, execIndex);
  const sandboxArgs = profile.sandbox ? ["--sandbox", profile.sandbox] : [];
  return [...prefix, "exec", ...sandboxArgs, "resume", sessionId, prompt];
}

function findSessionIdValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  for (const key of ["codexSessionId", "sessionId", "session_id", "threadId", "thread_id"]) {
    const sessionId = object[key];
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId;
    }
  }
  for (const key of ["session", "thread"]) {
    const nested = object[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const id = (nested as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) {
        return id;
      }
    }
  }
  for (const nested of Object.values(object)) {
    const sessionId = findSessionIdValue(nested);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

export function extractCodexSessionId(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const sessionId = findSessionIdValue(JSON.parse(trimmed));
      if (sessionId) {
        return sessionId;
      }
    } catch {
      const match = trimmed.match(/^(?:codexSessionId|sessionId|session_id|session id|threadId|thread_id)\s*[:=]\s*([A-Za-z0-9_.:-]+)$/i);
      if (match) {
        return match[1];
      }
      const statusSessionMatch = trimmed.match(CODEX_STATUS_SESSION_PATTERN);
      if (statusSessionMatch) {
        return statusSessionMatch[1];
      }
    }
  }
  return null;
}

export async function runCodexBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: CodexExecExecutorProfile;
}): Promise<ExecutorAdapterResult> {
  const run = await prepareBlockRun({
    projectRoot: options.projectRoot,
    claim: options.claim,
    executorName: options.executorName,
    profile: options.profile,
    prompt: options.prompt
  });
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  const args = codexExecArgs(options.profile);
  const result = await execWithStdin({
    command: options.profile.command,
    args,
    cwd: workspace.rootPath,
    stdin: options.prompt,
    timeoutMs: options.profile.timeoutMs
  });
  let finalResult = result;
  let codexSessionId = extractCodexSessionId(`${result.stdout}\n${result.stderr}`);
  let resumed = false;
  if (result.exitCode !== 0 && codexSessionId) {
    const resumeResult = await execWithStdin({
      command: options.profile.command,
      args: codexResumeArgs(options.profile, codexSessionId, "continue this block and produce the required report"),
      cwd: workspace.rootPath,
      stdin: "",
      timeoutMs: options.profile.timeoutMs
    });
    finalResult = {
      stdout: [result.stdout.trim(), "--- resume stdout ---", resumeResult.stdout.trim()].filter(Boolean).join("\n"),
      stderr: [result.stderr.trim(), "--- resume stderr ---", resumeResult.stderr.trim()].filter(Boolean).join("\n"),
      exitCode: resumeResult.exitCode,
      timedOut: result.timedOut || resumeResult.timedOut
    };
    codexSessionId = codexSessionId ?? extractCodexSessionId(`${resumeResult.stdout}\n${resumeResult.stderr}`);
    resumed = true;
  }
  const finishedAt = new Date().toISOString();
  await writeFile(join(run.runDir, "stdout.md"), finalResult.stdout, "utf8");
  await writeFile(join(run.runDir, "stderr.log"), finalResult.stderr, "utf8");
  await finishRunMetadata(run.metadataPath, {
    finishedAt,
    exitCode: finalResult.exitCode,
    command: options.profile.command,
    args,
    projectRoot: workspace.rootPath,
    executionCwd: workspace.rootPath,
    sandbox: options.profile.sandbox ?? null,
    role: options.profile.role ?? null,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: finalResult.timedOut,
    agentSessionId: codexSessionId,
    codexSessionId,
    resumed
  });
  if (finalResult.exitCode !== 0) {
    throw new Error(
      finalResult.timedOut
        ? `Executor '${options.executorName}' timed out after ${options.profile.timeoutMs}ms.`
        : finalResult.stderr.trim() || `Executor '${options.executorName}' exited with code ${finalResult.exitCode}.`
    );
  }
  if (options.claim.blockType === "review") {
    const resultPath = join(run.runDir, "review-result.json");
    const parsed = JSON.parse(finalResult.stdout.trim());
    await writeJsonFile(resultPath, parsed);
    return { kind: "review", resultPath, runId: run.runId, executor: options.executorName, adapter: "codex-exec", agentSessionId: codexSessionId, codexSessionId, ...finalResult };
  }
  const reportPath = join(run.runDir, "report.md");
  await writeFile(reportPath, finalResult.stdout, "utf8");
  return { kind: "block", reportPath, runId: run.runId, executor: options.executorName, adapter: "codex-exec", agentSessionId: codexSessionId, codexSessionId, ...finalResult };
}

export async function runCodexFeedback(options: {
  projectRoot: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: CodexExecExecutorProfile;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const args = codexExecArgs(options.profile);
  const result = await execWithStdin({
    command: options.profile.command,
    args,
    cwd: options.projectRoot,
    stdin: options.claim.content,
    timeoutMs: options.profile.timeoutMs
  });
  await writeFile(join(runDir, "stdout.md"), result.stdout, "utf8");
  await writeFile(join(runDir, "stderr.log"), result.stderr, "utf8");
  const codexSessionId = extractCodexSessionId(`${result.stdout}\n${result.stderr}`);
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId,
    executor: options.executorName,
    adapter: "codex-exec",
    projectRoot: options.projectRoot,
    executionCwd: options.projectRoot,
    startedAt: null,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: result.timedOut,
    agentSessionId: codexSessionId,
    codexSessionId
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
  return { kind: "feedback", reportPath, runId, executor: options.executorName, adapter: "codex-exec", agentSessionId: codexSessionId, codexSessionId, ...result };
}

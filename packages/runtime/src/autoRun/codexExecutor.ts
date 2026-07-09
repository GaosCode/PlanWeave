import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { CodexExecExecutorProfile, ExecutorAdapterResult, PackageWorkspaceRef } from "../types.js";
import { codexExecArgs, codexResumeArgs, extractCodexSessionId } from "./codexProtocol.js";
import {
  executorLimitFailureMessage,
  executorRuntimeLimits,
  finishRunMetadata,
  allocateRunId,
  prepareBlockRun,
  workspaceExecutionCwd,
  workspaceExecutorEnv,
  type BlockClaim,
  type ExecutorRuntimeLimits,
  type FeedbackClaim
} from "./executorShared.js";
import { runStreamingCommandWithSessionCapture, type StreamedCommandResult } from "./streamingExecutor.js";
import { createTmuxSessionInfo, tmuxMetadataPatch, type TmuxSessionInfo } from "./tmuxExecutor.js";

async function runCodexStreamingCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdoutPath: string;
  stderrPath: string;
  tmux?: TmuxSessionInfo | null;
  onSessionId: (sessionId: string) => Promise<void>;
}): Promise<StreamedCommandResult> {
  return runStreamingCommandWithSessionCapture({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    stdin: options.stdin,
    env: options.env,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    tmux: options.tmux,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
    sessionIdFromOutput: extractCodexSessionId,
    onSessionId: options.onSessionId
  });
}

function executorFailureMessage(input: { executorName: string; result: StreamedCommandResult; limits: ExecutorRuntimeLimits }): string {
  if (input.result.limitExceeded) {
    return executorLimitFailureMessage({ executorName: input.executorName, limitExceeded: input.result.limitExceeded });
  }
  return input.result.timedOut
    ? `Executor '${input.executorName}' timed out after ${input.limits.timeoutMs}ms.`
    : input.result.stderr.trim() || `Executor '${input.executorName}' exited with code ${input.result.exitCode}.`;
}

export async function runCodexBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: CodexExecExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  const run = await prepareBlockRun({
    projectRoot: options.projectRoot,
    claim: options.claim,
    executorName: options.executorName,
    profile: options.profile,
    prompt: options.prompt
  });
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  const executionCwd = workspaceExecutionCwd(workspace);
  const args = codexExecArgs(options.profile);
  const stdoutPath = join(run.runDir, "stdout.md");
  const stderrPath = join(run.runDir, "stderr.log");
  const limits = executorRuntimeLimits(options.profile);
  const tmux = await createTmuxSessionInfo({
    runDir: run.runDir,
    runId: run.runId,
    tmuxOwnerRunId: options.tmuxOwnerRunId,
    ref: options.claim.ref,
    kind: "block",
    enabled: options.tmuxEnabled
  });
  await finishRunMetadata(run.metadataPath, tmuxMetadataPatch(tmux));
  let codexSessionId: string | null = null;
  const onSessionId = async (sessionId: string): Promise<void> => {
    if (codexSessionId) {
      return;
    }
    codexSessionId = sessionId;
    await finishRunMetadata(run.metadataPath, {
      agentSessionId: sessionId,
      codexSessionId: sessionId
    });
  };
  const result = await runCodexStreamingCommand({
    command: options.profile.command,
    args,
    cwd: executionCwd,
    stdin: options.prompt,
    env: workspaceExecutorEnv(workspace),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath,
    stderrPath,
    tmux,
    onSessionId
  });
  let finalResult = result;
  codexSessionId = codexSessionId ?? extractCodexSessionId(`${result.stdout}\n${result.stderr}`);
  let resumed = false;
  if (result.exitCode !== 0 && codexSessionId && !result.limitExceeded) {
    const resumeStdoutPath = join(run.runDir, "resume-stdout.md");
    const resumeStderrPath = join(run.runDir, "resume-stderr.log");
    const resumeTmux = await createTmuxSessionInfo({
      runDir: join(run.runDir, "resume"),
      runId: `${run.runId}-resume`,
      tmuxOwnerRunId: options.tmuxOwnerRunId,
      ref: options.claim.ref,
      kind: "block",
      enabled: options.tmuxEnabled
    });
    const resumeResult = await runCodexStreamingCommand({
      command: options.profile.command,
      args: codexResumeArgs(options.profile, codexSessionId, "continue this block and produce the required report"),
      cwd: executionCwd,
      stdin: "",
      env: workspaceExecutorEnv(workspace),
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
      stdoutPath: resumeStdoutPath,
      stderrPath: resumeStderrPath,
      tmux: resumeTmux,
      onSessionId
    });
    finalResult = {
      stdout: [result.stdout.trim(), "--- resume stdout ---", resumeResult.stdout.trim()].filter(Boolean).join("\n"),
      stderr: [result.stderr.trim(), "--- resume stderr ---", resumeResult.stderr.trim()].filter(Boolean).join("\n"),
      exitCode: resumeResult.exitCode,
      timedOut: result.timedOut || resumeResult.timedOut,
      limitExceeded: resumeResult.limitExceeded
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
    executionCwd,
    sandbox: options.profile.sandbox ?? null,
    role: options.profile.role ?? null,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: finalResult.timedOut,
    agentSessionId: codexSessionId,
    codexSessionId,
    resumed
  });
  if (finalResult.exitCode !== 0) {
    throw new Error(executorFailureMessage({ executorName: options.executorName, result: finalResult, limits }));
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
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: CodexExecExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const args = codexExecArgs(options.profile);
  const limits = executorRuntimeLimits(options.profile);
  const tmux = await createTmuxSessionInfo({ runDir, runId, tmuxOwnerRunId: options.tmuxOwnerRunId, kind: "feedback", enabled: options.tmuxEnabled });
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: options.claim.feedbackId,
    sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
    taskId: options.claim.taskId,
    executor: options.executorName,
    adapter: "codex-exec",
    projectRoot: options.projectRoot,
    executionCwd: options.executionCwd,
    startedAt,
    finishedAt: null,
    exitCode: null,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: false,
    agentSessionId: null,
    codexSessionId: null,
    ...tmuxMetadataPatch(tmux)
  });
  let codexSessionId: string | null = null;
  const onSessionId = async (sessionId: string): Promise<void> => {
    if (codexSessionId) {
      return;
    }
    codexSessionId = sessionId;
    await finishRunMetadata(metadataPath, {
      agentSessionId: sessionId,
      codexSessionId: sessionId
    });
  };
  const result = await runCodexStreamingCommand({
    command: options.profile.command,
    args,
    cwd: options.executionCwd,
    stdin: options.claim.content,
    env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath: join(runDir, "stdout.md"),
    stderrPath: join(runDir, "stderr.log"),
    tmux,
    onSessionId
  });
  codexSessionId = codexSessionId ?? extractCodexSessionId(`${result.stdout}\n${result.stderr}`);
  await finishRunMetadata(metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: result.timedOut,
    agentSessionId: codexSessionId,
    codexSessionId
  });
  if (result.exitCode !== 0) {
    throw new Error(executorFailureMessage({ executorName: options.executorName, result, limits }));
  }
  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, result.stdout, "utf8");
  return { kind: "feedback", reportPath, runId, executor: options.executorName, adapter: "codex-exec", agentSessionId: codexSessionId, codexSessionId, ...result };
}

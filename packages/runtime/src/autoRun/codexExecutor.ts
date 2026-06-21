import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { CodexExecExecutorProfile, ExecutorAdapterResult, PackageWorkspaceRef } from "../types.js";
import { codexExecArgs, codexResumeArgs, extractCodexSessionId } from "./codexProtocol.js";
import { finishRunMetadata, nextRunId, prepareBlockRun, workspaceExecutionCwd, workspaceExecutorEnv, type BlockClaim, type FeedbackClaim } from "./executorShared.js";
import { runStreamingCommandWithSessionCapture, type StreamedCommandResult } from "./streamingExecutor.js";
import { createTmuxSessionInfo, tmuxMetadataPatch, type TmuxSessionInfo } from "./tmuxExecutor.js";

async function runCodexStreamingCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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
    sessionIdFromOutput: extractCodexSessionId,
    onSessionId: options.onSessionId
  });
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
    timeoutMs: options.profile.timeoutMs,
    stdoutPath,
    stderrPath,
    tmux,
    onSessionId
  });
  let finalResult = result;
  codexSessionId = codexSessionId ?? extractCodexSessionId(`${result.stdout}\n${result.stderr}`);
  let resumed = false;
  if (result.exitCode !== 0 && codexSessionId) {
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
      timeoutMs: options.profile.timeoutMs,
      stdoutPath: resumeStdoutPath,
      stderrPath: resumeStderrPath,
      tmux: resumeTmux,
      onSessionId
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
    executionCwd,
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
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const args = codexExecArgs(options.profile);
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
    timeoutMs: options.profile.timeoutMs ?? null,
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
    timeoutMs: options.profile.timeoutMs,
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

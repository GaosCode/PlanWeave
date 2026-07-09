import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { ExecutorAdapterResult, OpencodeExecExecutorProfile, PackageWorkspaceRef } from "../types.js";
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
import { opencodeInvocation } from "./opencodeInvocation.js";
import { extractOpencodeSessionId, formatOpencodeErrorOutput, opencodeReport, parseOpencodeJsonOutput } from "./opencodeOutput.js";
import { appendReviewResultFileInstruction, assertReviewResultJsonReadable, reviewResultEnvironment } from "./reviewResultContract.js";
import { runStreamingCommandWithSessionCapture, type StreamedCommandResult } from "./streamingExecutor.js";
import { createTmuxSessionInfo, tmuxMetadataPatch, type TmuxSessionInfo } from "./tmuxExecutor.js";

async function runOpencodeStreamingCommand(options: {
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
    sessionIdFromOutput: extractOpencodeSessionId,
    onSessionId: options.onSessionId
  });
}

function executorFailureMessage(input: { executorName: string; result: StreamedCommandResult; limits: ExecutorRuntimeLimits }): string {
  if (input.result.limitExceeded) {
    return executorLimitFailureMessage({ executorName: input.executorName, limitExceeded: input.result.limitExceeded });
  }
  const opencodeError = formatOpencodeErrorOutput(input.result.stdout, input.result.stderr);
  if (opencodeError) {
    return `Executor '${input.executorName}' failed: ${opencodeError}`;
  }
  return input.result.timedOut
    ? `Executor '${input.executorName}' timed out after ${input.limits.timeoutMs}ms.`
    : input.result.stderr.trim() || `Executor '${input.executorName}' exited with code ${input.result.exitCode}.`;
}

export async function runOpencodeBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: OpencodeExecExecutorProfile;
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
  const reviewResultPath = options.claim.blockType === "review" ? join(run.runDir, "review-result.json") : null;
  const prompt = reviewResultPath
    ? appendReviewResultFileInstruction(options.prompt, {
        resultPath: reviewResultPath,
        reviewBlockRef: options.claim.ref,
        taskId: options.claim.taskId
      })
    : options.prompt;
  const invocation = opencodeInvocation(options.profile, prompt, executionCwd);
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
  let agentSessionId: string | null = null;
  const onSessionId = async (sessionId: string): Promise<void> => {
    if (agentSessionId) {
      return;
    }
    agentSessionId = sessionId;
    await finishRunMetadata(run.metadataPath, {
      agentSessionId: sessionId,
      opencodeSessionId: sessionId
    });
  };
  if (invocation.sessionId) {
    await onSessionId(invocation.sessionId);
  }
  const result = await runOpencodeStreamingCommand({
    command: options.profile.command,
    args: invocation.args,
    cwd: executionCwd,
    stdin: invocation.stdin,
    env: workspaceExecutorEnv(
      workspace,
      reviewResultPath
        ? reviewResultEnvironment({
            resultPath: reviewResultPath,
            reviewBlockRef: options.claim.ref,
            taskId: options.claim.taskId
          })
        : undefined
    ),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath: join(run.runDir, "stdout.md"),
    stderrPath: join(run.runDir, "stderr.log"),
    tmux,
    onSessionId
  });
  const jsonOutput = parseOpencodeJsonOutput(result.stdout);
  agentSessionId = agentSessionId ?? jsonOutput.sessionId ?? extractOpencodeSessionId(`${result.stdout}\n${result.stderr}`);
  if (jsonOutput.parsedAny || invocation.jsonMode) {
    await writeFile(join(run.runDir, "events.ndjson"), result.stdout, "utf8");
  }
  const structuredError = formatOpencodeErrorOutput(result.stdout, result.stderr) ?? jsonOutput.error;
  const failureReason =
    result.exitCode !== 0
      ? executorFailureMessage({ executorName: options.executorName, result, limits })
      : structuredError
        ? `Executor '${options.executorName}' returned an OpenCode error event: ${structuredError}`
        : null;
  await finishRunMetadata(run.metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: invocation.args,
    projectRoot: workspace.rootPath,
    executionCwd,
    sandbox: options.profile.sandbox ?? null,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: result.timedOut,
    agentSessionId,
    opencodeSessionId: agentSessionId,
    resumed: false,
    failureReason
  });
  if (result.exitCode !== 0) {
    throw new Error(failureReason ?? `Executor '${options.executorName}' exited with code ${result.exitCode}.`);
  }
  if (structuredError) {
    throw new Error(failureReason ?? `Executor '${options.executorName}' returned an OpenCode error event: ${structuredError}`);
  }
  if (options.claim.blockType === "review") {
    if (!reviewResultPath) {
      throw new Error(`Executor '${options.executorName}' did not prepare a review result path.`);
    }
    await assertReviewResultJsonReadable({ executorName: options.executorName, resultPath: reviewResultPath });
    return {
      kind: "review",
      resultPath: reviewResultPath,
      runId: run.runId,
      executor: options.executorName,
      adapter: "opencode-exec",
      agentSessionId,
      opencodeSessionId: agentSessionId,
      ...result
    };
  }
  const reportPath = join(run.runDir, "report.md");
  await writeFile(reportPath, opencodeReport(jsonOutput, result.stdout, result.stderr, agentSessionId), "utf8");
  return { kind: "block", reportPath, runId: run.runId, executor: options.executorName, adapter: "opencode-exec", agentSessionId, opencodeSessionId: agentSessionId, ...result };
}

export async function runOpencodeFeedback(options: {
  projectRoot: string;
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: OpencodeExecExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const invocation = opencodeInvocation(options.profile, options.claim.content, options.executionCwd);
  const limits = executorRuntimeLimits(options.profile);
  const tmux = await createTmuxSessionInfo({ runDir, runId, tmuxOwnerRunId: options.tmuxOwnerRunId, kind: "feedback", enabled: options.tmuxEnabled });
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: options.claim.feedbackId,
    sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
    taskId: options.claim.taskId,
    executor: options.executorName,
    adapter: "opencode-exec",
    projectRoot: options.projectRoot,
    executionCwd: options.executionCwd,
    startedAt,
    finishedAt: null,
    exitCode: null,
    command: options.profile.command,
    args: invocation.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: false,
    agentSessionId: null,
    opencodeSessionId: null,
    ...tmuxMetadataPatch(tmux)
  });
  let agentSessionId: string | null = null;
  const onSessionId = async (sessionId: string): Promise<void> => {
    if (agentSessionId) {
      return;
    }
    agentSessionId = sessionId;
    await finishRunMetadata(metadataPath, {
      agentSessionId: sessionId,
      opencodeSessionId: sessionId
    });
  };
  if (invocation.sessionId) {
    await onSessionId(invocation.sessionId);
  }
  const result = await runOpencodeStreamingCommand({
    command: options.profile.command,
    args: invocation.args,
    cwd: options.executionCwd,
    stdin: invocation.stdin,
    env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath: join(runDir, "stdout.md"),
    stderrPath: join(runDir, "stderr.log"),
    tmux,
    onSessionId
  });
  const jsonOutput = parseOpencodeJsonOutput(result.stdout);
  agentSessionId = agentSessionId ?? jsonOutput.sessionId ?? extractOpencodeSessionId(`${result.stdout}\n${result.stderr}`);
  if (jsonOutput.parsedAny || invocation.jsonMode) {
    await writeFile(join(runDir, "events.ndjson"), result.stdout, "utf8");
  }
  const structuredError = formatOpencodeErrorOutput(result.stdout, result.stderr) ?? jsonOutput.error;
  const failureReason =
    result.exitCode !== 0
      ? executorFailureMessage({ executorName: options.executorName, result, limits })
      : structuredError
        ? `Executor '${options.executorName}' returned an OpenCode error event: ${structuredError}`
        : null;
  await finishRunMetadata(metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: invocation.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: result.timedOut,
    agentSessionId,
    opencodeSessionId: agentSessionId,
    failureReason
  });
  if (result.exitCode !== 0) {
    throw new Error(failureReason ?? `Executor '${options.executorName}' exited with code ${result.exitCode}.`);
  }
  if (structuredError) {
    throw new Error(failureReason ?? `Executor '${options.executorName}' returned an OpenCode error event: ${structuredError}`);
  }
  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, opencodeReport(jsonOutput, result.stdout, result.stderr, agentSessionId), "utf8");
  return { kind: "feedback", reportPath, runId, executor: options.executorName, adapter: "opencode-exec", agentSessionId, opencodeSessionId: agentSessionId, ...result };
}

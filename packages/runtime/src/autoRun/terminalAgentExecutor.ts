import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { ClaudeCodeExecExecutorProfile, ExecutorAdapterResult, PackageWorkspaceRef, PiExecExecutorProfile } from "../types.js";
import {
  execWithStreaming,
  executorLimitFailureMessage,
  executorRuntimeLimits,
  finishRunMetadata,
  allocateRunId,
  prepareBlockRun,
  workspaceExecutionCwd,
  workspaceExecutorEnv,
  type BlockClaim,
  type ExecutorRuntimeLimits,
  type FeedbackClaim,
  type StreamingCommandResult
} from "./executorShared.js";
import { appendReviewResultFileInstruction, assertReviewResultJsonReadable, reviewResultEnvironment } from "./reviewResultContract.js";
import { createTmuxSessionInfo, tmuxMetadataPatch } from "./tmuxExecutor.js";

type TerminalAgentProfile = ClaudeCodeExecExecutorProfile | PiExecExecutorProfile;

async function streamedResult(options: {
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
  tmux: Awaited<ReturnType<typeof createTmuxSessionInfo>>;
}): Promise<StreamingCommandResult> {
  return execWithStreaming(options);
}

function throwIfFailed(input: { result: StreamingCommandResult; executorName: string; limits: ExecutorRuntimeLimits }): void {
  if (input.result.exitCode === 0) {
    return;
  }
  if (input.result.limitExceeded) {
    throw new Error(executorLimitFailureMessage({ executorName: input.executorName, limitExceeded: input.result.limitExceeded }));
  }
  throw new Error(
    input.result.timedOut
      ? `Executor '${input.executorName}' timed out after ${input.limits.timeoutMs}ms.`
      : input.result.stderr.trim() || `Executor '${input.executorName}' exited with code ${input.result.exitCode}.`
  );
}

export async function runTerminalAgentBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: TerminalAgentProfile;
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
  const reviewContract = reviewResultPath
    ? {
        resultPath: reviewResultPath,
        reviewBlockRef: options.claim.ref,
        taskId: options.claim.taskId
      }
    : null;
  const prompt = reviewContract ? appendReviewResultFileInstruction(options.prompt, reviewContract) : options.prompt;
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
  const result = await streamedResult({
    command: options.profile.command,
    args: options.profile.args,
    cwd: executionCwd,
    stdin: prompt,
    env: workspaceExecutorEnv(workspace, reviewContract ? reviewResultEnvironment(reviewContract) : undefined),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath,
    stderrPath,
    tmux
  });
  await finishRunMetadata(run.metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: options.profile.args,
    projectRoot: workspace.rootPath,
    executionCwd,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: result.timedOut,
    agentSessionId: null
  });
  throwIfFailed({ result, executorName: options.executorName, limits });
  if (options.claim.blockType === "review") {
    if (!reviewResultPath) {
      throw new Error(`Executor '${options.executorName}' did not prepare a review result path.`);
    }
    await assertReviewResultJsonReadable({ executorName: options.executorName, resultPath: reviewResultPath });
    return { kind: "review", resultPath: reviewResultPath, runId: run.runId, executor: options.executorName, adapter: options.profile.adapter, agentSessionId: null, ...result };
  }
  const reportPath = join(run.runDir, "report.md");
  await writeFile(reportPath, result.stdout, "utf8");
  return { kind: "block", reportPath, runId: run.runId, executor: options.executorName, adapter: options.profile.adapter, agentSessionId: null, ...result };
}

export async function runTerminalAgentFeedback(options: {
  projectRoot: string;
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: TerminalAgentProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const tmux = await createTmuxSessionInfo({ runDir, runId, tmuxOwnerRunId: options.tmuxOwnerRunId, kind: "feedback", enabled: options.tmuxEnabled });
  const limits = executorRuntimeLimits(options.profile);
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: options.claim.feedbackId,
    sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
    taskId: options.claim.taskId,
    executor: options.executorName,
    adapter: options.profile.adapter,
    projectRoot: options.projectRoot,
    executionCwd: options.executionCwd,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    command: options.profile.command,
    args: options.profile.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: false,
    agentSessionId: null,
    ...tmuxMetadataPatch(tmux)
  });
  const result = await streamedResult({
    command: options.profile.command,
    args: options.profile.args,
    cwd: options.executionCwd,
    stdin: options.claim.content,
    env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath: join(runDir, "stdout.md"),
    stderrPath: join(runDir, "stderr.log"),
    tmux
  });
  await finishRunMetadata(metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: result.timedOut
  });
  throwIfFailed({ result, executorName: options.executorName, limits });
  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, result.stdout, "utf8");
  return { kind: "feedback", reportPath, runId, executor: options.executorName, adapter: options.profile.adapter, agentSessionId: null, ...result };
}

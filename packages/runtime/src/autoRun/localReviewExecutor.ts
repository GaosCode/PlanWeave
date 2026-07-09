import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type {
  ExecutorAdapterResult,
  LocalReviewExecutorProfile,
  PackageWorkspaceRef
} from "../types.js";
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
import { createTmuxSessionInfo, tmuxMetadataPatch } from "./tmuxExecutor.js";

function executorFailureMessage(input: {
  executorName: string;
  result: StreamingCommandResult;
  limits: ExecutorRuntimeLimits;
}): string {
  if (input.result.limitExceeded) {
    return executorLimitFailureMessage({
      executorName: input.executorName,
      limitExceeded: input.result.limitExceeded
    });
  }
  return input.result.timedOut
    ? `Executor '${input.executorName}' timed out after ${input.limits.timeoutMs}ms.`
    : input.result.stderr.trim() ||
        `Executor '${input.executorName}' exited with code ${input.result.exitCode}.`;
}

export async function runLocalReviewBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: LocalReviewExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  if (options.claim.blockType !== "review") {
    throw new Error(
      `Executor '${options.executorName}' uses local-review and can only run review blocks.`
    );
  }
  const run = await prepareBlockRun({
    projectRoot: options.projectRoot,
    claim: options.claim,
    executorName: options.executorName,
    profile: options.profile,
    prompt: options.prompt
  });
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  const executionCwd = workspaceExecutionCwd(workspace);
  const { blockId } = parseBlockRef(options.claim.ref);
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
  const streamed = await execWithStreaming({
    command: options.profile.command,
    args: options.profile.args,
    cwd: executionCwd,
    stdin: options.prompt,
    env: workspaceExecutorEnv(workspace, {
      PLANWEAVE_REVIEW_BLOCK_REF: options.claim.ref,
      PLANWEAVE_TASK_ID: options.claim.taskId,
      PLANWEAVE_BLOCK_ID: blockId
    }),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath,
    stderrPath,
    tmux
  });
  await finishRunMetadata(run.metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: streamed.exitCode,
    command: options.profile.command,
    args: options.profile.args,
    projectRoot: workspace.rootPath,
    executionCwd,
    sandbox: options.profile.sandbox ?? null,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: streamed.timedOut,
    agentSessionId: null,
    codexSessionId: null,
    resumed: false
  });
  if (streamed.exitCode !== 0) {
    throw new Error(
      executorFailureMessage({ executorName: options.executorName, result: streamed, limits })
    );
  }
  const resultPath = join(run.runDir, "review-result.json");
  await writeJsonFile(resultPath, JSON.parse(streamed.stdout.trim()));
  return {
    kind: "review",
    resultPath,
    runId: run.runId,
    executor: options.executorName,
    adapter: "local-review",
    agentSessionId: null,
    codexSessionId: null,
    ...streamed
  };
}

export async function runLocalReviewFeedback(options: {
  projectRoot: string;
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: LocalReviewExecutorProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  const stdoutPath = join(runDir, "stdout.md");
  const stderrPath = join(runDir, "stderr.log");
  const limits = executorRuntimeLimits(options.profile);
  const startedAt = new Date().toISOString();
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const tmux = await createTmuxSessionInfo({
    runDir,
    runId,
    tmuxOwnerRunId: options.tmuxOwnerRunId,
    kind: "feedback",
    enabled: options.tmuxEnabled
  });
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: options.claim.feedbackId,
    sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
    taskId: options.claim.taskId,
    executor: options.executorName,
    adapter: "local-review",
    projectRoot: options.projectRoot,
    executionCwd: options.executionCwd,
    startedAt,
    finishedAt: null,
    exitCode: null,
    command: options.profile.command,
    args: options.profile.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: false,
    agentSessionId: null,
    codexSessionId: null,
    ...tmuxMetadataPatch(tmux)
  });
  const streamed = await execWithStreaming({
    command: options.profile.command,
    args: options.profile.args,
    cwd: options.executionCwd,
    stdin: options.claim.content,
    env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath,
    stderrPath,
    tmux
  });
  await finishRunMetadata(metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: streamed.exitCode,
    command: options.profile.command,
    args: options.profile.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: streamed.timedOut,
    agentSessionId: null,
    codexSessionId: null
  });
  if (streamed.exitCode !== 0) {
    throw new Error(
      executorFailureMessage({ executorName: options.executorName, result: streamed, limits })
    );
  }
  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, streamed.stdout, "utf8");
  return {
    kind: "feedback",
    reportPath,
    runId,
    executor: options.executorName,
    adapter: "local-review",
    agentSessionId: null,
    codexSessionId: null,
    ...streamed
  };
}

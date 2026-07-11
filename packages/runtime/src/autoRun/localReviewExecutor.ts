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
import type { CliProcessExecutor } from "./cliProcess.js";
import {
  materializeFeedbackArtifact,
  materializeReviewArtifact
} from "./runnerArtifactMaterialization.js";
import {
  executorLimitFailureMessage,
  executorRuntimeLimits,
  finalizeExecutorAttemptMetadata,
  finalizeExecutorCancellationOnError,
  finishRunMetadata,
  allocateRunId,
  prepareBlockRun,
  workspaceExecutionCwd,
  workspaceExecutorEnv,
  type BlockClaim,
  type ExecutorRuntimeLimits,
  type FeedbackClaim
} from "./executorShared.js";
import type { StreamedCommandResult } from "./streamingExecutor.js";
import { tmuxMetadataPatch } from "./tmuxExecutor.js";
import type { ArtifactReference } from "./runnerContractSchemas.js";

function executorFailureMessage(input: {
  executorName: string;
  result: StreamedCommandResult;
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
  signal?: AbortSignal;
  executeProcess: CliProcessExecutor;
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
    adapter: "local-review",
    profile: options.profile,
    prompt: options.prompt
  });
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  const executionCwd = workspaceExecutionCwd(workspace);
  const { blockId } = parseBlockRef(options.claim.ref);
  const stdoutPath = join(run.runDir, "stdout.md");
  const stderrPath = join(run.runDir, "stderr.log");
  const limits = executorRuntimeLimits(options.profile);
  const { tmux: _tmux, ...processResult } = await finalizeExecutorCancellationOnError({
    path: run.metadataPath,
    patch: {
      command: options.profile.command,
      args: options.profile.args,
      projectRoot: workspace.rootPath,
      executionCwd,
      sandbox: options.profile.sandbox ?? null,
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
      agentSessionId: null,
      codexSessionId: null,
      resumed: false
    },
    run: () =>
      options.executeProcess({
        command: options.profile.command,
        args: options.profile.args,
        cwd: executionCwd,
        stdin: options.prompt,
        env: workspaceExecutorEnv(workspace, {
          PLANWEAVE_REVIEW_BLOCK_REF: options.claim.ref,
          PLANWEAVE_TASK_ID: options.claim.taskId,
          PLANWEAVE_BLOCK_ID: blockId
        }),
        limits,
        stdoutPath,
        stderrPath,
        tmux: {
          runDir: run.runDir,
          runId: run.runId,
          ownerRunId: options.tmuxOwnerRunId,
          ref: options.claim.ref,
          kind: "block",
          enabled: options.tmuxEnabled
        },
        onTmuxReady: async (tmux) => finishRunMetadata(run.metadataPath, tmuxMetadataPatch(tmux)),
        signal: options.signal
      })
  });
  const streamed = { ...processResult, stdoutPath, stderrPath };
  const failureReason =
    streamed.exitCode === 0
      ? null
      : executorFailureMessage({ executorName: options.executorName, result: streamed, limits });
  const metadataPatch = {
    command: options.profile.command,
    args: options.profile.args,
    projectRoot: workspace.rootPath,
    executionCwd,
    sandbox: options.profile.sandbox ?? null,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    agentSessionId: null,
    codexSessionId: null,
    resumed: false
  };
  if (failureReason) {
    await finalizeExecutorAttemptMetadata({
      path: run.metadataPath,
      outcome: "failed",
      exitCode: streamed.exitCode,
      timedOut: streamed.timedOut,
      failureReason,
      patch: metadataPatch
    });
    throw new Error(failureReason);
  }
  const resultPath = join(run.runDir, "review-result.json");
  let artifactReference: ArtifactReference;
  try {
    artifactReference = await materializeReviewArtifact({
      ref: options.claim.ref,
      taskId: options.claim.taskId,
      reviewResult: JSON.parse(streamed.stdout.trim()),
      path: resultPath
    });
  } catch (error) {
    const reason = `Executor '${options.executorName}' produced an invalid review artifact: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await finalizeExecutorAttemptMetadata({
      path: run.metadataPath,
      outcome: "failed",
      exitCode: streamed.exitCode,
      timedOut: streamed.timedOut,
      failureReason: reason,
      patch: metadataPatch
    });
    throw new Error(reason);
  }
  await finalizeExecutorAttemptMetadata({
    path: run.metadataPath,
    outcome: "succeeded",
    exitCode: streamed.exitCode,
    timedOut: streamed.timedOut,
    failureReason: null,
    patch: { ...metadataPatch, artifactReference }
  });
  return {
    kind: "review",
    resultPath,
    runId: run.runId,
    executor: options.executorName,
    adapter: "local-review",
    agentId: null,
    runnerKind: null,
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
  signal?: AbortSignal;
  executeProcess: CliProcessExecutor;
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
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: options.claim.feedbackId,
    sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
    taskId: options.claim.taskId,
    executor: options.executorName,
    adapter: "local-review",
    agentId: null,
    runnerKind: null,
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
    codexSessionId: null
  });
  const { tmux: _tmux, ...processResult } = await finalizeExecutorCancellationOnError({
    path: metadataPath,
    patch: {
      command: options.profile.command,
      args: options.profile.args,
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
      agentSessionId: null,
      codexSessionId: null
    },
    run: () =>
      options.executeProcess({
        command: options.profile.command,
        args: options.profile.args,
        cwd: options.executionCwd,
        stdin: options.claim.content,
        env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
        limits,
        stdoutPath,
        stderrPath,
        tmux: {
          runDir,
          runId,
          ownerRunId: options.tmuxOwnerRunId,
          kind: "feedback",
          enabled: options.tmuxEnabled
        },
        onTmuxReady: async (tmux) => finishRunMetadata(metadataPath, tmuxMetadataPatch(tmux)),
        signal: options.signal
      })
  });
  const streamed = { ...processResult, stdoutPath, stderrPath };
  const failureReason =
    streamed.exitCode === 0
      ? null
      : executorFailureMessage({ executorName: options.executorName, result: streamed, limits });
  const metadataPatch = {
    command: options.profile.command,
    args: options.profile.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    agentSessionId: null,
    codexSessionId: null
  };
  if (failureReason) {
    await finalizeExecutorAttemptMetadata({
      path: metadataPath,
      outcome: "failed",
      exitCode: streamed.exitCode,
      timedOut: streamed.timedOut,
      failureReason,
      patch: metadataPatch
    });
    throw new Error(failureReason);
  }
  const reportPath = join(runDir, "feedback-report.md");
  let artifactReference: ArtifactReference;
  try {
    artifactReference = await materializeFeedbackArtifact({
      feedbackId: options.claim.feedbackId,
      sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
      taskId: options.claim.taskId,
      reportMarkdown: streamed.stdout,
      path: reportPath
    });
  } catch (error) {
    const reason = `Executor '${options.executorName}' produced an invalid feedback artifact: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await finalizeExecutorAttemptMetadata({
      path: metadataPath,
      outcome: "failed",
      exitCode: streamed.exitCode,
      timedOut: streamed.timedOut,
      failureReason: reason,
      patch: metadataPatch
    });
    throw new Error(reason);
  }
  await finalizeExecutorAttemptMetadata({
    path: metadataPath,
    outcome: "succeeded",
    exitCode: streamed.exitCode,
    timedOut: streamed.timedOut,
    failureReason: null,
    patch: { ...metadataPatch, artifactReference }
  });
  return {
    kind: "feedback",
    reportPath,
    runId,
    executor: options.executorName,
    adapter: "local-review",
    agentId: null,
    runnerKind: null,
    agentSessionId: null,
    codexSessionId: null,
    ...streamed
  };
}

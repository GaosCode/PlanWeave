import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type {
  AgentCliExecutorProfile,
  ExecutorAdapterResult,
  ExecutorIntegrationName,
  PackageWorkspaceRef
} from "../types.js";
import type { CliProcessExecutor } from "./cliProcess.js";
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
import {
  appendReviewResultFileInstruction,
  assertReviewResultJsonReadable,
  reviewResultEnvironment
} from "./reviewResultContract.js";
import {
  materializeFeedbackArtifact,
  materializeImplementationArtifact,
  materializeReviewArtifact
} from "./runnerArtifactMaterialization.js";
import type { StreamedCommandResult } from "./streamingExecutor.js";
import { tmuxMetadataPatch } from "./tmuxExecutor.js";
import type { ArtifactReference } from "./runnerContractSchemas.js";
import type { ExecutionWaveId } from "./runnerContractSchemas.js";

/** Command line produced by a protocol adapter for one agent process. */
export type TerminalAgentInvocation = {
  command: string;
  args: string[];
  stdin: string;
  /** Session id known before launch (e.g. OpenCode `-s`). */
  sessionId?: string | null;
  /** Protocol-specific flag (e.g. OpenCode JSON event mode). */
  jsonMode?: boolean;
};

/** Optional post-run interpretation produced by a protocol adapter. */
export type ProtocolInterpretation = {
  agentSessionId?: string | null;
  /** Fail the run even when exitCode is 0 (structured agent error events). */
  successFailureReason?: string | null;
  /** Override report body; default is stdout. */
  reportContent?: string;
};

type ProfileWithCommand = AgentCliExecutorProfile;

/**
 * Per-executor protocol differences. Shared lifecycle (run dir, tmux, streaming,
 * metadata, failure throw, report/review materialization) lives in the template.
 */
export type ProtocolAdapter<TProfile extends ProfileWithCommand> = {
  /** Adapter id written into metadata and ExecutorAdapterResult. */
  adapter: ExecutorIntegrationName;
  /**
   * Protocol-specific session metadata field mirrored next to agentSessionId
   * (e.g. codexSessionId / opencodeSessionId).
   */
  sessionMetadataKey?: "codexSessionId" | "opencodeSessionId";
  /**
   * How review results are obtained.
   * - result-file: agent writes PLANWEAVE_REVIEW_RESULT_PATH
   * - stdout-json: agent prints JSON on stdout; template writes review-result.json (codex)
   */
  reviewResultMode: "result-file" | "stdout-json";
  /**
   * Prepare the prompt before buildInvocation.
   * Default for result-file mode: append review-result file instruction on review blocks.
   * Codex overrides with identity (no injection).
   */
  preparePrompt?(input: {
    prompt: string;
    claim: BlockClaim;
    reviewResultPath: string | null;
  }): string;
  /** Whether PLANWEAVE_REVIEW_* env vars are set for review blocks. Default: true when reviewResultMode is result-file. */
  usesReviewResultEnvironment?: boolean;
  buildInvocation(input: {
    profile: TProfile;
    prompt: string;
    executionCwd: string;
  }): TerminalAgentInvocation;
  sessionIdFromOutput?(output: string): string | null;
  /**
   * When present, a failed first attempt with a known session id (and no output-limit
   * exceed) is retried via resume. Only used on block runs (not feedback).
   */
  buildResumeInvocation?(input: {
    profile: TProfile;
    sessionId: string;
    executionCwd: string;
  }): TerminalAgentInvocation;
  formatFailureMessage?(input: {
    executorName: string;
    result: StreamedCommandResult;
    limits: ExecutorRuntimeLimits;
  }): string;
  /**
   * Post-command hook: side effects (events.ndjson), session refinement, structured
   * success-path failures, and custom report content.
   */
  interpretResult?(input: {
    profile: TProfile;
    executorName: string;
    result: StreamedCommandResult;
    invocation: TerminalAgentInvocation;
    runDir: string;
    agentSessionId: string | null;
    resumed: boolean;
  }): Promise<ProtocolInterpretation> | ProtocolInterpretation;
  /** Extra finish-metadata fields (sandbox, role, resumed, failureReason, ...). */
  finishMetadata?(input: {
    kind: "block" | "feedback";
    profile: TProfile;
    invocation: TerminalAgentInvocation;
    agentSessionId: string | null;
    resumed: boolean;
    failureReason: string | null;
  }): Record<string, unknown>;
};

function defaultPreparePrompt(input: {
  prompt: string;
  claim: BlockClaim;
  reviewResultPath: string | null;
}): string {
  if (!input.reviewResultPath) {
    return input.prompt;
  }
  return appendReviewResultFileInstruction(input.prompt, {
    resultPath: input.reviewResultPath,
    reviewBlockRef: input.claim.ref,
    taskId: input.claim.taskId
  });
}

function defaultFailureMessage(input: {
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

function sessionResultFields(
  sessionMetadataKey: "codexSessionId" | "opencodeSessionId" | undefined,
  agentSessionId: string | null
): Record<string, string | null> {
  if (!sessionMetadataKey) {
    return { agentSessionId };
  }
  return { agentSessionId, [sessionMetadataKey]: agentSessionId };
}

type SharedRunOptions<TProfile extends ProfileWithCommand> = {
  executorName: string;
  profile: TProfile;
  protocol: ProtocolAdapter<TProfile>;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
  signal?: AbortSignal;
  executionWaveId?: ExecutionWaveId;
  executeProcess: CliProcessExecutor;
};

/**
 * Shared block lifecycle for terminal-agent executors.
 * Protocol-specific argv, session parsing, review shape, and report formatting live on `protocol`.
 */
export async function runTerminalAgentProtocolBlock<TProfile extends ProfileWithCommand>(
  options: SharedRunOptions<TProfile> & {
    projectRoot: PackageWorkspaceRef;
    claim: BlockClaim;
    prompt: string;
  }
): Promise<ExecutorAdapterResult> {
  const protocol = options.protocol;
  const executeProcess = options.executeProcess;
  const run = await prepareBlockRun({
    projectRoot: options.projectRoot,
    claim: options.claim,
    executorName: options.executorName,
    adapter: protocol.adapter,
    profile: options.profile,
    prompt: options.prompt,
    executionWaveId: options.executionWaveId
  });
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  const executionCwd = workspaceExecutionCwd(workspace);
  const reviewResultPath =
    options.claim.blockType === "review" ? join(run.runDir, "review-result.json") : null;
  const preparePrompt =
    protocol.preparePrompt ??
    (protocol.reviewResultMode === "result-file" ? defaultPreparePrompt : undefined);
  const prompt = preparePrompt
    ? preparePrompt({ prompt: options.prompt, claim: options.claim, reviewResultPath })
    : options.prompt;
  const usesReviewEnv =
    protocol.usesReviewResultEnvironment ?? protocol.reviewResultMode === "result-file";
  const reviewContract =
    reviewResultPath && usesReviewEnv
      ? {
          resultPath: reviewResultPath,
          reviewBlockRef: options.claim.ref,
          taskId: options.claim.taskId
        }
      : null;
  const invocation = protocol.buildInvocation({ profile: options.profile, prompt, executionCwd });
  const limits = executorRuntimeLimits(options.profile);
  let agentSessionId: string | null = null;
  const onSessionId = async (sessionId: string): Promise<void> => {
    if (agentSessionId) {
      return;
    }
    agentSessionId = sessionId;
    await finishRunMetadata(
      run.metadataPath,
      sessionResultFields(protocol.sessionMetadataKey, sessionId)
    );
  };
  if (invocation.sessionId) {
    await onSessionId(invocation.sessionId);
  }

  const env = workspaceExecutorEnv(
    workspace,
    reviewContract ? reviewResultEnvironment(reviewContract) : undefined
  );
  const { tmux: _tmux, ...result } = await finalizeExecutorCancellationOnError({
    path: run.metadataPath,
    patch: {
      command: invocation.command,
      args: invocation.args,
      projectRoot: workspace.rootPath,
      executionCwd,
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes
    },
    run: () =>
      executeProcess({
        command: invocation.command,
        args: invocation.args,
        cwd: executionCwd,
        stdin: invocation.stdin,
        env,
        limits,
        stdoutPath: join(run.runDir, "stdout.md"),
        stderrPath: join(run.runDir, "stderr.log"),
        tmux: {
          runDir: run.runDir,
          runId: run.runId,
          ownerRunId: options.tmuxOwnerRunId,
          ref: options.claim.ref,
          kind: "block",
          enabled: options.tmuxEnabled
        },
        sessionIdFromOutput: protocol.sessionIdFromOutput,
        onSessionId,
        onTmuxReady: async (tmux) => finishRunMetadata(run.metadataPath, tmuxMetadataPatch(tmux)),
        signal: options.signal
      })
  });

  let finalResult = result;
  let resumed = false;
  if (protocol.sessionIdFromOutput) {
    agentSessionId =
      agentSessionId ?? protocol.sessionIdFromOutput(`${result.stdout}\n${result.stderr}`);
  }

  if (
    protocol.buildResumeInvocation &&
    result.exitCode !== 0 &&
    agentSessionId &&
    !result.limitExceeded
  ) {
    const resumeInvocation = protocol.buildResumeInvocation({
      profile: options.profile,
      sessionId: agentSessionId,
      executionCwd
    });
    const { tmux: _resumeTmux, ...resumeResult } = await finalizeExecutorCancellationOnError({
      path: run.metadataPath,
      patch: {
        command: resumeInvocation.command,
        args: resumeInvocation.args,
        projectRoot: workspace.rootPath,
        executionCwd,
        timeoutMs: limits.timeoutMs,
        maxStdoutBytes: limits.maxStdoutBytes,
        maxStderrBytes: limits.maxStderrBytes,
        resumed: true
      },
      run: () =>
        executeProcess({
          command: resumeInvocation.command,
          args: resumeInvocation.args,
          cwd: executionCwd,
          stdin: resumeInvocation.stdin,
          env,
          limits,
          stdoutPath: join(run.runDir, "resume-stdout.md"),
          stderrPath: join(run.runDir, "resume-stderr.log"),
          tmux: {
            runDir: join(run.runDir, "resume"),
            runId: `${run.runId}-resume`,
            ownerRunId: options.tmuxOwnerRunId,
            ref: options.claim.ref,
            kind: "block",
            enabled: options.tmuxEnabled
          },
          sessionIdFromOutput: protocol.sessionIdFromOutput,
          onSessionId,
          signal: options.signal
        })
    });
    finalResult = {
      stdout: [result.stdout.trim(), "--- resume stdout ---", resumeResult.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
      stderr: [result.stderr.trim(), "--- resume stderr ---", resumeResult.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
      exitCode: resumeResult.exitCode,
      timedOut: result.timedOut || resumeResult.timedOut,
      limitExceeded: resumeResult.limitExceeded
    };
    if (protocol.sessionIdFromOutput) {
      agentSessionId =
        agentSessionId ??
        protocol.sessionIdFromOutput(`${resumeResult.stdout}\n${resumeResult.stderr}`);
    }
    resumed = true;
  }

  if (protocol.buildResumeInvocation) {
    // Codex always rewrites final stdout/stderr (including the non-resume path).
    await writeFile(join(run.runDir, "stdout.md"), finalResult.stdout, "utf8");
    await writeFile(join(run.runDir, "stderr.log"), finalResult.stderr, "utf8");
  }

  const interpretation =
    (await protocol.interpretResult?.({
      profile: options.profile,
      executorName: options.executorName,
      result: finalResult,
      invocation,
      runDir: run.runDir,
      agentSessionId,
      resumed
    })) ?? {};
  if (interpretation.agentSessionId !== undefined) {
    agentSessionId = interpretation.agentSessionId;
  }

  const formatFailure = protocol.formatFailureMessage ?? defaultFailureMessage;
  const exitFailure =
    finalResult.exitCode !== 0
      ? formatFailure({ executorName: options.executorName, result: finalResult, limits })
      : null;
  const failureReason = exitFailure ?? interpretation.successFailureReason ?? null;

  const metadataPatch = {
    command: invocation.command,
    args: invocation.args,
    projectRoot: workspace.rootPath,
    executionCwd,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    ...sessionResultFields(protocol.sessionMetadataKey, agentSessionId),
    ...(protocol.finishMetadata?.({
      kind: "block",
      profile: options.profile,
      invocation,
      agentSessionId,
      resumed,
      failureReason
    }) ?? {})
  };

  if (failureReason) {
    await finalizeExecutorAttemptMetadata({
      path: run.metadataPath,
      outcome: "failed",
      exitCode: finalResult.exitCode,
      timedOut: finalResult.timedOut,
      failureReason,
      patch: metadataPatch
    });
    throw new Error(failureReason);
  }

  const sessionFields = sessionResultFields(protocol.sessionMetadataKey, agentSessionId);
  const adapter = protocol.adapter;
  if (options.claim.blockType === "review") {
    if (!reviewResultPath) {
      const reason = `Executor '${options.executorName}' did not prepare a review result path.`;
      await finalizeExecutorAttemptMetadata({
        path: run.metadataPath,
        outcome: "failed",
        exitCode: finalResult.exitCode,
        timedOut: finalResult.timedOut,
        failureReason: reason,
        patch: metadataPatch
      });
      throw new Error(reason);
    }
    let artifactReference: ArtifactReference;
    try {
      let raw: unknown;
      if (protocol.reviewResultMode === "stdout-json") {
        raw = JSON.parse(finalResult.stdout.trim());
      } else {
        await assertReviewResultJsonReadable({
          executorName: options.executorName,
          resultPath: reviewResultPath
        });
        raw = await readJsonFile<unknown>(reviewResultPath);
      }
      artifactReference = await materializeReviewArtifact({
        ref: options.claim.ref,
        taskId: options.claim.taskId,
        reviewResult: raw,
        path: reviewResultPath
      });
    } catch (error) {
      const reason = `Executor '${options.executorName}' produced an invalid review artifact: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await finalizeExecutorAttemptMetadata({
        path: run.metadataPath,
        outcome: "failed",
        exitCode: finalResult.exitCode,
        timedOut: finalResult.timedOut,
        failureReason: reason,
        patch: metadataPatch
      });
      throw new Error(reason);
    }
    await finalizeExecutorAttemptMetadata({
      path: run.metadataPath,
      outcome: "succeeded",
      exitCode: finalResult.exitCode,
      timedOut: finalResult.timedOut,
      failureReason: null,
      patch: { ...metadataPatch, artifactReference }
    });
    return {
      kind: "review",
      resultPath: reviewResultPath,
      runId: run.runId,
      executor: options.executorName,
      adapter,
      agentId: options.profile.agent,
      runnerKind: options.profile.runner.transport,
      ...sessionFields,
      ...finalResult
    };
  }

  const reportPath = join(run.runDir, "report.md");
  let artifactReference: ArtifactReference;
  try {
    artifactReference = await materializeImplementationArtifact({
      ref: options.claim.ref,
      taskId: options.claim.taskId,
      reportMarkdown: interpretation.reportContent ?? finalResult.stdout,
      path: reportPath
    });
  } catch (error) {
    const reason = `Executor '${options.executorName}' produced an invalid implementation artifact: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await finalizeExecutorAttemptMetadata({
      path: run.metadataPath,
      outcome: "failed",
      exitCode: finalResult.exitCode,
      timedOut: finalResult.timedOut,
      failureReason: reason,
      patch: metadataPatch
    });
    throw new Error(reason);
  }
  await finalizeExecutorAttemptMetadata({
    path: run.metadataPath,
    outcome: "succeeded",
    exitCode: finalResult.exitCode,
    timedOut: finalResult.timedOut,
    failureReason: null,
    patch: { ...metadataPatch, artifactReference }
  });
  return {
    kind: "block",
    reportPath,
    runId: run.runId,
    executor: options.executorName,
    adapter,
    agentId: options.profile.agent,
    runnerKind: options.profile.runner.transport,
    ...sessionFields,
    ...finalResult
  };
}

/**
 * Shared feedback lifecycle for terminal-agent executors.
 * Resume is intentionally not applied to feedback runs.
 */
export async function runTerminalAgentProtocolFeedback<TProfile extends ProfileWithCommand>(
  options: SharedRunOptions<TProfile> & {
    projectRoot: string;
    executionCwd: string;
    planweaveHome: string;
    workspaceResultsDir: string;
    claim: FeedbackClaim;
  }
): Promise<ExecutorAdapterResult> {
  const protocol = options.protocol;
  const executeProcess = options.executeProcess;
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const invocation = protocol.buildInvocation({
    profile: options.profile,
    prompt: options.claim.content,
    executionCwd: options.executionCwd
  });
  const limits = executorRuntimeLimits(options.profile);
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: options.claim.feedbackId,
    sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
    taskId: options.claim.taskId,
    executor: options.executorName,
    adapter: protocol.adapter,
    agentId: options.profile.agent,
    runnerKind: options.profile.runner.transport,
    projectRoot: options.projectRoot,
    executionCwd: options.executionCwd,
    startedAt,
    finishedAt: null,
    exitCode: null,
    command: invocation.command,
    args: invocation.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: false,
    ...sessionResultFields(protocol.sessionMetadataKey, null)
  });

  let agentSessionId: string | null = null;
  const onSessionId = async (sessionId: string): Promise<void> => {
    if (agentSessionId) {
      return;
    }
    agentSessionId = sessionId;
    await finishRunMetadata(
      metadataPath,
      sessionResultFields(protocol.sessionMetadataKey, sessionId)
    );
  };
  if (invocation.sessionId) {
    await onSessionId(invocation.sessionId);
  }

  const { tmux: _tmux, ...result } = await finalizeExecutorCancellationOnError({
    path: metadataPath,
    patch: {
      command: invocation.command,
      args: invocation.args,
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes
    },
    run: () =>
      executeProcess({
        command: invocation.command,
        args: invocation.args,
        cwd: options.executionCwd,
        stdin: invocation.stdin,
        env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
        limits,
        stdoutPath: join(runDir, "stdout.md"),
        stderrPath: join(runDir, "stderr.log"),
        tmux: {
          runDir,
          runId,
          ownerRunId: options.tmuxOwnerRunId,
          kind: "feedback",
          enabled: options.tmuxEnabled
        },
        sessionIdFromOutput: protocol.sessionIdFromOutput,
        onSessionId,
        onTmuxReady: async (tmux) => finishRunMetadata(metadataPath, tmuxMetadataPatch(tmux)),
        signal: options.signal
      })
  });

  if (protocol.sessionIdFromOutput) {
    agentSessionId =
      agentSessionId ?? protocol.sessionIdFromOutput(`${result.stdout}\n${result.stderr}`);
  }

  const interpretation =
    (await protocol.interpretResult?.({
      profile: options.profile,
      executorName: options.executorName,
      result,
      invocation,
      runDir,
      agentSessionId,
      resumed: false
    })) ?? {};
  if (interpretation.agentSessionId !== undefined) {
    agentSessionId = interpretation.agentSessionId;
  }

  const formatFailure = protocol.formatFailureMessage ?? defaultFailureMessage;
  const exitFailure =
    result.exitCode !== 0
      ? formatFailure({ executorName: options.executorName, result, limits })
      : null;
  const failureReason = exitFailure ?? interpretation.successFailureReason ?? null;

  const metadataPatch = {
    command: invocation.command,
    args: invocation.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    ...sessionResultFields(protocol.sessionMetadataKey, agentSessionId),
    ...(protocol.finishMetadata?.({
      kind: "feedback",
      profile: options.profile,
      invocation,
      agentSessionId,
      resumed: false,
      failureReason
    }) ?? {})
  };

  if (failureReason) {
    await finalizeExecutorAttemptMetadata({
      path: metadataPath,
      outcome: "failed",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
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
      reportMarkdown: interpretation.reportContent ?? result.stdout,
      path: reportPath
    });
  } catch (error) {
    const reason = `Executor '${options.executorName}' produced an invalid feedback artifact: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await finalizeExecutorAttemptMetadata({
      path: metadataPath,
      outcome: "failed",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      failureReason: reason,
      patch: metadataPatch
    });
    throw new Error(reason);
  }
  await finalizeExecutorAttemptMetadata({
    path: metadataPath,
    outcome: "succeeded",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    failureReason: null,
    patch: { ...metadataPatch, artifactReference }
  });
  return {
    kind: "feedback",
    reportPath,
    runId,
    executor: options.executorName,
    adapter: protocol.adapter,
    agentId: options.profile.agent,
    runnerKind: options.profile.runner.transport,
    ...sessionResultFields(protocol.sessionMetadataKey, agentSessionId),
    ...result
  };
}

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type {
  ClaudeCodeExecExecutorProfile,
  ExecutorAdapterResult,
  ExecutorProfile,
  PackageWorkspaceRef,
  PiExecExecutorProfile
} from "../types.js";
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
import {
  appendReviewResultFileInstruction,
  assertReviewResultJsonReadable,
  reviewResultEnvironment
} from "./reviewResultContract.js";
import {
  runStreamingCommandWithSessionCapture,
  type StreamedCommandResult
} from "./streamingExecutor.js";
import { createTmuxSessionInfo, tmuxMetadataPatch } from "./tmuxExecutor.js";

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

type ProfileWithCommand = {
  adapter: string;
  command: string;
  args: string[];
};

/**
 * Per-executor protocol differences. Shared lifecycle (run dir, tmux, streaming,
 * metadata, failure throw, report/review materialization) lives in the template.
 */
export type ProtocolAdapter<TProfile extends ProfileWithCommand> = {
  /** Adapter id written into metadata and ExecutorAdapterResult. */
  adapter: TProfile["adapter"];
  /**
   * Protocol-specific session metadata field mirrored next to agentSessionId
   * (e.g. codexSessionId / opencodeSessionId).
   */
  sessionMetadataKey?: "codexSessionId" | "opencodeSessionId";
  /**
   * How review results are obtained.
   * - result-file: agent writes PLANWEAVE_REVIEW_RESULT_PATH (claude/pi/opencode)
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

async function streamCommand(options: {
  invocation: TerminalAgentInvocation;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdoutPath: string;
  stderrPath: string;
  tmux: Awaited<ReturnType<typeof createTmuxSessionInfo>>;
  sessionIdFromOutput?: (output: string) => string | null;
  onSessionId: (sessionId: string) => Promise<void>;
}): Promise<StreamedCommandResult> {
  return runStreamingCommandWithSessionCapture({
    command: options.invocation.command,
    args: options.invocation.args,
    cwd: options.cwd,
    stdin: options.invocation.stdin,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    tmux: options.tmux,
    sessionIdFromOutput: options.sessionIdFromOutput ?? (() => null),
    onSessionId: options.onSessionId
  });
}

type SharedRunOptions<TProfile extends ProfileWithCommand> = {
  executorName: string;
  profile: TProfile;
  protocol: ProtocolAdapter<TProfile>;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
};

/**
 * Shared block lifecycle for terminal-agent executors (codex / opencode / claude / pi).
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
  const run = await prepareBlockRun({
    projectRoot: options.projectRoot,
    claim: options.claim,
    executorName: options.executorName,
    profile: options.profile as ExecutorProfile,
    prompt: options.prompt
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
  const limits = executorRuntimeLimits(options.profile as ExecutorProfile);
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
  const result = await streamCommand({
    invocation,
    cwd: executionCwd,
    env,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath: join(run.runDir, "stdout.md"),
    stderrPath: join(run.runDir, "stderr.log"),
    tmux,
    sessionIdFromOutput: protocol.sessionIdFromOutput,
    onSessionId
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
    const resumeTmux = await createTmuxSessionInfo({
      runDir: join(run.runDir, "resume"),
      runId: `${run.runId}-resume`,
      tmuxOwnerRunId: options.tmuxOwnerRunId,
      ref: options.claim.ref,
      kind: "block",
      enabled: options.tmuxEnabled
    });
    const resumeResult = await streamCommand({
      invocation: resumeInvocation,
      cwd: executionCwd,
      env,
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
      stdoutPath: join(run.runDir, "resume-stdout.md"),
      stderrPath: join(run.runDir, "resume-stderr.log"),
      tmux: resumeTmux,
      sessionIdFromOutput: protocol.sessionIdFromOutput,
      onSessionId
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

  await finishRunMetadata(run.metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: finalResult.exitCode,
    command: invocation.command,
    args: invocation.args,
    projectRoot: workspace.rootPath,
    executionCwd,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: finalResult.timedOut,
    ...sessionResultFields(protocol.sessionMetadataKey, agentSessionId),
    ...(protocol.finishMetadata?.({
      kind: "block",
      profile: options.profile,
      invocation,
      agentSessionId,
      resumed,
      failureReason
    }) ?? {})
  });

  if (failureReason) {
    throw new Error(failureReason);
  }

  const sessionFields = sessionResultFields(protocol.sessionMetadataKey, agentSessionId);
  const adapter = protocol.adapter as ExecutorProfile["adapter"];
  if (options.claim.blockType === "review") {
    if (!reviewResultPath) {
      throw new Error(`Executor '${options.executorName}' did not prepare a review result path.`);
    }
    if (protocol.reviewResultMode === "stdout-json") {
      const parsed = JSON.parse(finalResult.stdout.trim());
      await writeJsonFile(reviewResultPath, parsed);
    } else {
      await assertReviewResultJsonReadable({
        executorName: options.executorName,
        resultPath: reviewResultPath
      });
    }
    return {
      kind: "review",
      resultPath: reviewResultPath,
      runId: run.runId,
      executor: options.executorName,
      adapter,
      ...sessionFields,
      ...finalResult
    };
  }

  const reportPath = join(run.runDir, "report.md");
  await writeFile(reportPath, interpretation.reportContent ?? finalResult.stdout, "utf8");
  return {
    kind: "block",
    reportPath,
    runId: run.runId,
    executor: options.executorName,
    adapter,
    ...sessionFields,
    ...finalResult
  };
}

/**
 * Shared feedback lifecycle for terminal-agent executors.
 * Resume is intentionally not applied (matches prior codex/opencode/claude/pi behavior).
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
  const limits = executorRuntimeLimits(options.profile as ExecutorProfile);
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
    adapter: protocol.adapter,
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
    ...sessionResultFields(protocol.sessionMetadataKey, null),
    ...tmuxMetadataPatch(tmux)
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

  const result = await streamCommand({
    invocation,
    cwd: options.executionCwd,
    env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    stdoutPath: join(runDir, "stdout.md"),
    stderrPath: join(runDir, "stderr.log"),
    tmux,
    sessionIdFromOutput: protocol.sessionIdFromOutput,
    onSessionId
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

  await finishRunMetadata(metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: invocation.command,
    args: invocation.args,
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    timedOut: result.timedOut,
    ...sessionResultFields(protocol.sessionMetadataKey, agentSessionId),
    ...(protocol.finishMetadata?.({
      kind: "feedback",
      profile: options.profile,
      invocation,
      agentSessionId,
      resumed: false,
      failureReason
    }) ?? {})
  });

  if (failureReason) {
    throw new Error(failureReason);
  }

  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, interpretation.reportContent ?? result.stdout, "utf8");
  return {
    kind: "feedback",
    reportPath,
    runId,
    executor: options.executorName,
    adapter: protocol.adapter as ExecutorProfile["adapter"],
    ...sessionResultFields(protocol.sessionMetadataKey, agentSessionId),
    ...result
  };
}

type SimpleTerminalProfile = ClaudeCodeExecExecutorProfile | PiExecExecutorProfile;

/** Protocol for claude-code / pi: profile argv as-is, review result file, no session capture. */
export function simpleTerminalProtocol(
  adapter: SimpleTerminalProfile["adapter"]
): ProtocolAdapter<SimpleTerminalProfile> {
  return {
    adapter,
    reviewResultMode: "result-file",
    buildInvocation({ profile, prompt }) {
      return { command: profile.command, args: profile.args, stdin: prompt };
    }
  };
}

/** Convenience wrapper for claude-code / pi integrations. */
export async function runTerminalAgentBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: SimpleTerminalProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolBlock({
    ...options,
    protocol: simpleTerminalProtocol(options.profile.adapter)
  });
}

/** Convenience wrapper for claude-code / pi integrations. */
export async function runTerminalAgentFeedback(options: {
  projectRoot: string;
  executionCwd: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: SimpleTerminalProfile;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
}): Promise<ExecutorAdapterResult> {
  return runTerminalAgentProtocolFeedback({
    ...options,
    protocol: simpleTerminalProtocol(options.profile.adapter)
  });
}

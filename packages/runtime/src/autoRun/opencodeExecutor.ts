import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { ExecutorAdapterResult, OpencodeExecExecutorProfile, PackageWorkspaceRef } from "../types.js";
import { finishRunMetadata, nextRunId, prepareBlockRun, type BlockClaim, type FeedbackClaim } from "./executorShared.js";
import { opencodeInvocation } from "./opencodeInvocation.js";
import { extractOpencodeSessionId, opencodeReport, parseOpencodeJsonOutput } from "./opencodeOutput.js";
import { appendReviewResultFileInstruction, reviewResultEnvironment } from "./reviewResultContract.js";
import { runStreamingCommandWithSessionCapture, type StreamedCommandResult } from "./streamingExecutor.js";
import { createTmuxSessionInfo, tmuxMetadataPatch, type TmuxSessionInfo } from "./tmuxExecutor.js";

async function runOpencodeStreamingCommand(options: {
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
    sessionIdFromOutput: extractOpencodeSessionId,
    onSessionId: options.onSessionId
  });
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
  const reviewResultPath = options.claim.blockType === "review" ? join(run.runDir, "review-result.json") : null;
  const prompt = reviewResultPath
    ? appendReviewResultFileInstruction(options.prompt, {
        resultPath: reviewResultPath,
        reviewBlockRef: options.claim.ref,
        taskId: options.claim.taskId
      })
    : options.prompt;
  const invocation = opencodeInvocation(options.profile, prompt, workspace.rootPath);
  const tmux = await createTmuxSessionInfo({ runDir: run.runDir, runId: run.runId, ref: options.claim.ref, kind: "block" });
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
  const result = await runOpencodeStreamingCommand({
    command: options.profile.command,
    args: invocation.args,
    cwd: workspace.rootPath,
    stdin: invocation.stdin,
    env: reviewResultPath
      ? reviewResultEnvironment({
          resultPath: reviewResultPath,
          reviewBlockRef: options.claim.ref,
          taskId: options.claim.taskId
        })
      : undefined,
    timeoutMs: options.profile.timeoutMs,
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
  await finishRunMetadata(run.metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: invocation.args,
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
  if (jsonOutput.error) {
    throw new Error(`Executor '${options.executorName}' returned an OpenCode error event: ${jsonOutput.error}`);
  }
  if (options.claim.blockType === "review") {
    if (!reviewResultPath) {
      throw new Error(`Executor '${options.executorName}' did not prepare a review result path.`);
    }
    try {
      await access(reviewResultPath, constants.R_OK);
    } catch {
      throw new Error(`Executor '${options.executorName}' did not create review result JSON at ${reviewResultPath}.`);
    }
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
  await writeFile(reportPath, opencodeReport(jsonOutput, result.stdout, result.stderr), "utf8");
  return { kind: "block", reportPath, runId: run.runId, executor: options.executorName, adapter: "opencode-exec", agentSessionId, opencodeSessionId: agentSessionId, ...result };
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
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const invocation = opencodeInvocation(options.profile, options.claim.content, options.projectRoot);
  const tmux = await createTmuxSessionInfo({ runDir, runId, kind: "feedback" });
  await writeJsonFile(metadataPath, {
    runId,
    executor: options.executorName,
    adapter: "opencode-exec",
    projectRoot: options.projectRoot,
    executionCwd: options.projectRoot,
    startedAt,
    finishedAt: null,
    exitCode: null,
    command: options.profile.command,
    args: invocation.args,
    timeoutMs: options.profile.timeoutMs ?? null,
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
  const result = await runOpencodeStreamingCommand({
    command: options.profile.command,
    args: invocation.args,
    cwd: options.projectRoot,
    stdin: invocation.stdin,
    timeoutMs: options.profile.timeoutMs,
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
  await finishRunMetadata(metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: invocation.args,
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
  if (jsonOutput.error) {
    throw new Error(`Executor '${options.executorName}' returned an OpenCode error event: ${jsonOutput.error}`);
  }
  const reportPath = join(runDir, "report.md");
  await writeFile(reportPath, opencodeReport(jsonOutput, result.stdout, result.stderr), "utf8");
  return { kind: "feedback", reportPath, runId, executor: options.executorName, adapter: "opencode-exec", agentSessionId, opencodeSessionId: agentSessionId, ...result };
}

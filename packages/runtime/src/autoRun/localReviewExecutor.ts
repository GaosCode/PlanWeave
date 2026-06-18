import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { ExecutorAdapterResult, LocalReviewExecutorProfile, PackageWorkspaceRef } from "../types.js";
import { execWithStreaming, finishRunMetadata, nextRunId, prepareBlockRun, workspaceExecutorEnv, type BlockClaim, type FeedbackClaim } from "./executorShared.js";
import { createTmuxSessionInfo, tmuxMetadataPatch } from "./tmuxExecutor.js";

export async function runLocalReviewBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: LocalReviewExecutorProfile;
  tmuxEnabled?: boolean;
}): Promise<ExecutorAdapterResult> {
  if (options.claim.blockType !== "review") {
    throw new Error(`Executor '${options.executorName}' uses local-review and can only run review blocks.`);
  }
  const run = await prepareBlockRun({
    projectRoot: options.projectRoot,
    claim: options.claim,
    executorName: options.executorName,
    profile: options.profile,
    prompt: options.prompt
  });
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  const { blockId } = parseBlockRef(options.claim.ref);
  const stdoutPath = join(run.runDir, "stdout.md");
  const stderrPath = join(run.runDir, "stderr.log");
  const tmux = await createTmuxSessionInfo({ runDir: run.runDir, runId: run.runId, ref: options.claim.ref, kind: "block", enabled: options.tmuxEnabled });
  await finishRunMetadata(run.metadataPath, tmuxMetadataPatch(tmux));
  const streamed = await execWithStreaming({
    command: options.profile.command,
    args: options.profile.args,
    cwd: workspace.rootPath,
    stdin: options.prompt,
    env: workspaceExecutorEnv(workspace, {
      PLANWEAVE_REVIEW_BLOCK_REF: options.claim.ref,
      PLANWEAVE_TASK_ID: options.claim.taskId,
      PLANWEAVE_BLOCK_ID: blockId
    }),
    timeoutMs: options.profile.timeoutMs,
    stdoutPath,
    stderrPath,
    tmux
  });
  const result = {
    stdout: await readFile(stdoutPath, "utf8"),
    stderr: await readFile(stderrPath, "utf8"),
    exitCode: streamed.exitCode,
    timedOut: streamed.timedOut
  };
  await finishRunMetadata(run.metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: options.profile.args,
    projectRoot: workspace.rootPath,
    executionCwd: workspace.rootPath,
    sandbox: options.profile.sandbox ?? null,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: result.timedOut,
    agentSessionId: null,
    codexSessionId: null,
    resumed: false
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.timedOut
        ? `Executor '${options.executorName}' timed out after ${options.profile.timeoutMs}ms.`
        : result.stderr.trim() || `Executor '${options.executorName}' exited with code ${result.exitCode}.`
    );
  }
  const resultPath = join(run.runDir, "review-result.json");
  await writeJsonFile(resultPath, JSON.parse(result.stdout.trim()));
  return { kind: "review", resultPath, runId: run.runId, executor: options.executorName, adapter: "local-review", agentSessionId: null, codexSessionId: null, ...result };
}

export async function runLocalReviewFeedback(options: {
  projectRoot: string;
  planweaveHome: string;
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: LocalReviewExecutorProfile;
  tmuxEnabled?: boolean;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  const metadataPath = join(runDir, "metadata.json");
  const stdoutPath = join(runDir, "stdout.md");
  const stderrPath = join(runDir, "stderr.log");
  const startedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const tmux = await createTmuxSessionInfo({ runDir, runId, kind: "feedback", enabled: options.tmuxEnabled });
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: options.claim.feedbackId,
    sourceReviewBlockRef: options.claim.sourceReviewBlockRef,
    taskId: options.claim.taskId,
    executor: options.executorName,
    adapter: "local-review",
    projectRoot: options.projectRoot,
    executionCwd: options.projectRoot,
    startedAt,
    finishedAt: null,
    exitCode: null,
    command: options.profile.command,
    args: options.profile.args,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: false,
    agentSessionId: null,
    codexSessionId: null,
    ...tmuxMetadataPatch(tmux)
  });
  const streamed = await execWithStreaming({
    command: options.profile.command,
    args: options.profile.args,
    cwd: options.projectRoot,
    stdin: options.claim.content,
    env: workspaceExecutorEnv({ planweaveHome: options.planweaveHome }),
    timeoutMs: options.profile.timeoutMs,
    stdoutPath,
    stderrPath,
    tmux
  });
  const result = {
    stdout: await readFile(stdoutPath, "utf8"),
    stderr: await readFile(stderrPath, "utf8"),
    exitCode: streamed.exitCode,
    timedOut: streamed.timedOut
  };
  await finishRunMetadata(metadataPath, {
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    command: options.profile.command,
    args: options.profile.args,
    timeoutMs: options.profile.timeoutMs ?? null,
    timedOut: result.timedOut,
    agentSessionId: null,
    codexSessionId: null
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
  return { kind: "feedback", reportPath, runId, executor: options.executorName, adapter: "local-review", agentSessionId: null, codexSessionId: null, ...result };
}

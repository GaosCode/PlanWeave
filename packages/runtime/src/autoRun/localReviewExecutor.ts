import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import type { ExecutorAdapterResult, LocalReviewExecutorProfile, PackageWorkspaceRef } from "../types.js";
import { execWithStdin, finishRunMetadata, nextRunId, prepareBlockRun, type BlockClaim, type FeedbackClaim } from "./executorShared.js";

export async function runLocalReviewBlock(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  prompt: string;
  executorName: string;
  profile: LocalReviewExecutorProfile;
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
  const result = await execWithStdin({
    command: options.profile.command,
    args: options.profile.args,
    cwd: workspace.rootPath,
    stdin: options.prompt,
    timeoutMs: options.profile.timeoutMs
  });
  await writeFile(join(run.runDir, "stdout.md"), result.stdout, "utf8");
  await writeFile(join(run.runDir, "stderr.log"), result.stderr, "utf8");
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
  workspaceResultsDir: string;
  claim: FeedbackClaim;
  executorName: string;
  profile: LocalReviewExecutorProfile;
}): Promise<ExecutorAdapterResult> {
  const runRoot = join(options.workspaceResultsDir, "feedback-runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "prompt.md"), options.claim.content, "utf8");
  const result = await execWithStdin({
    command: options.profile.command,
    args: options.profile.args,
    cwd: options.projectRoot,
    stdin: options.claim.content,
    timeoutMs: options.profile.timeoutMs
  });
  await writeFile(join(runDir, "stdout.md"), result.stdout, "utf8");
  await writeFile(join(runDir, "stderr.log"), result.stderr, "utf8");
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId,
    executor: options.executorName,
    adapter: "local-review",
    projectRoot: options.projectRoot,
    executionCwd: options.projectRoot,
    startedAt: null,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
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

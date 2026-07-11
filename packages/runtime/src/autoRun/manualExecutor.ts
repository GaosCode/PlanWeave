import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { canvasCommandFlagForWorkspace } from "../taskManager/canvasCommandScope.js";
import { writeJsonFile } from "../json.js";
import type { ExecutorAdapterResult } from "../types.js";
import { allocateRunId, prepareBlockRun, workspaceExecutionCwd } from "./executorShared.js";
import {
  executorProfileMismatch,
  type DirectExecutor,
  type ExecutorBlockInput,
  type ExecutorFeedbackInput
} from "./executorIntegration.js";

async function runManualBlock(input: ExecutorBlockInput): Promise<ExecutorAdapterResult> {
  if (input.profile.adapter !== "manual") {
    throw executorProfileMismatch("manual", input.profile);
  }
  const run = await prepareBlockRun({
    projectRoot: input.projectRoot,
    claim: input.claim,
    executorName: input.executorName,
    adapter: "manual",
    profile: input.profile,
    prompt: input.prompt
  });
  const workspace = await resolvePackageWorkspace(input.projectRoot);
  const canvasFlag = await canvasCommandFlagForWorkspace(workspace);
  return {
    kind: "manual",
    executor: input.executorName,
    adapter: "manual",
    agentId: null,
    runnerKind: null,
    promptPath: run.promptPath,
    runDir: run.runDir,
    runId: run.runId,
    nextCommand:
      input.claim.blockType === "review"
        ? `planweave submit-review${canvasFlag} ${input.claim.ref} --result <review-result.json>`
        : `planweave submit-result${canvasFlag} ${input.claim.ref} --report <report.md>`
  };
}

async function runManualFeedback(input: ExecutorFeedbackInput): Promise<ExecutorAdapterResult> {
  if (input.profile.adapter !== "manual") {
    throw executorProfileMismatch("manual", input.profile);
  }
  const canvasFlag = await canvasCommandFlagForWorkspace(input.workspace);
  const feedbackRoot = join(input.workspace.resultsDir, "feedback-runs");
  const runId = await allocateRunId(feedbackRoot);
  const runDir = join(feedbackRoot, runId);
  const promptPath = join(runDir, "feedback.md");
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  const nextCommand = `planweave submit-feedback${canvasFlag} --report <feedback-report.md>`;
  const executionCwd = workspaceExecutionCwd(input.workspace);
  await writeFile(promptPath, input.claim.content, "utf8");
  await writeJsonFile(metadataPath, {
    runId,
    feedbackId: input.claim.feedbackId,
    sourceReviewBlockRef: input.claim.sourceReviewBlockRef,
    taskId: input.claim.taskId,
    executor: input.executorName,
    adapter: "manual",
    agentId: null,
    runnerKind: null,
    projectRoot: input.workspace.rootPath,
    executionCwd,
    startedAt,
    finishedAt: null,
    exitCode: null,
    nextCommand
  });
  return {
    kind: "manual",
    executor: input.executorName,
    adapter: "manual",
    agentId: null,
    runnerKind: null,
    promptPath,
    runDir,
    runId,
    nextCommand
  };
}

export const manualExecutor: DirectExecutor = {
  adapter: "manual",
  builtinProfiles: {
    default: { adapter: "manual" },
    manual: { adapter: "manual" }
  },
  runBlock: runManualBlock,
  runFeedback: runManualFeedback
};

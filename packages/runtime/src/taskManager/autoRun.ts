import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecutorAdapter } from "../autoRun/executors.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { readJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import type {
  AutoRunLatestRunSummary,
  AutoRunStatus,
  AutoRunStepResult,
  ClaimScope,
  ClaimResult,
  ExecutionGraphSession,
  ExecutorAdapter,
  ExecutorProfile,
  PlanPackageManifest
} from "../types.js";
import { claimNext, getExecutionStatus, markBlockBlocked, renderPrompt, submitBlockResult, submitFeedback, submitReviewResult } from "./index.js";

type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
type SubmittedOrManualStep = Extract<AutoRunStepResult, { kind: "submitted" | "manual" }>;
type BlockedStep = { kind: "blocked"; claim: ClaimResult };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSummary(path: string): Promise<string> {
  if (!(await exists(path))) {
    return "";
  }
  return (await readFile(path, "utf8")).trim().slice(0, 400);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutorAdapter(value: unknown): value is ExecutorProfile["adapter"] {
  return value === "manual" || value === "codex-exec";
}

async function latestRunId(runRoot: string): Promise<string | null> {
  try {
    const entries = await readdir(runRoot, { withFileTypes: true });
    return (
      entries
        .filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
}

async function claimForBatchRef(options: {
  projectRoot: string;
  ref: string;
  session?: ExecutionGraphSession;
}): Promise<BlockClaim> {
  const manifest: PlanPackageManifest = options.session?.fileSnapshot.manifest ?? (await loadPackage(options.projectRoot)).manifest;
  const { taskId, blockId } = parseBlockRef(options.ref);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (task?.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  const block = task.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  return {
    kind: "block",
    ref: options.ref,
    taskId,
    blockId,
    blockType: block.type,
    reason: "claimed"
  };
}

async function executeBlockClaim(options: {
  projectRoot: string;
  claim: BlockClaim;
  executor: ExecutorAdapter;
  session?: ExecutionGraphSession;
}): Promise<SubmittedOrManualStep | BlockedStep> {
  const prompt = await renderPrompt({ projectRoot: options.projectRoot, ref: options.claim.ref, session: options.session });
  let adapterResult: Awaited<ReturnType<ExecutorAdapter["runBlock"]>>;
  try {
    adapterResult = await options.executor.runBlock({ claim: options.claim, prompt });
  } catch (error) {
    const reason = `Executor failed for ${options.claim.ref}: ${errorMessage(error)}`;
    const blocked = await markBlockBlocked({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      reason,
      session: options.session
    });
    return {
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: blocked.ref,
        reason: blocked.reason
      }
    };
  }
  if (adapterResult.kind === "manual") {
    return { kind: "manual", claim: options.claim, adapterResult };
  }
  if (options.claim.blockType === "review") {
    if (adapterResult.kind !== "review") {
      throw new Error("Executor adapter must return a review result for review block claims.");
    }
    const submitResult = await submitReviewResult({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      resultPath: adapterResult.resultPath,
      session: options.session
    });
    return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
  }
  if (adapterResult.kind !== "block") {
    throw new Error("Executor adapter must return a block report for implementation/check block claims.");
  }
  const submitResult = await submitBlockResult({
    projectRoot: options.projectRoot,
    ref: options.claim.ref,
    reportPath: adapterResult.reportPath,
    runId: adapterResult.runId,
    session: options.session
  });
  return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
}

export async function runAutoRunStep(options: {
  projectRoot: string;
  executor?: ExecutorAdapter;
  executorName?: string;
  parallel?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
}): Promise<AutoRunStepResult> {
  const claim = await claimNext({ projectRoot: options.projectRoot, parallel: options.parallel, scope: options.scope, session: options.session });
  if (claim.kind === "none") {
    return { kind: "idle", claim };
  }
  if (claim.kind === "blocked") {
    return { kind: "blocked", claim };
  }
  if (claim.kind === "batch") {
    const executor = options.executor ?? createExecutorAdapter({ projectRoot: options.projectRoot, executorName: options.executorName });
    const steps: SubmittedOrManualStep[] = [];
    for (const ref of claim.refs) {
      const blockClaim = await claimForBatchRef({ projectRoot: options.projectRoot, ref, session: options.session });
      const step = await executeBlockClaim({
        projectRoot: options.projectRoot,
        claim: blockClaim,
        executor,
        session: options.session
      });
      if (step.kind === "blocked") {
        return step;
      }
      steps.push(step);
    }
    return { kind: "batch_submitted", claim, steps };
  }

  const executor = options.executor ?? createExecutorAdapter({ projectRoot: options.projectRoot, executorName: options.executorName });
  if (claim.kind === "feedback") {
    let adapterResult: Awaited<ReturnType<ExecutorAdapter["runFeedback"]>>;
    try {
      adapterResult = await executor.runFeedback({ claim });
    } catch (error) {
      return {
        kind: "blocked",
        claim: {
          kind: "blocked",
          reason: `Executor failed for feedback: ${errorMessage(error)}`
        }
      };
    }
    if (adapterResult.kind === "manual") {
      return { kind: "manual", claim, adapterResult };
    }
    if (adapterResult.kind !== "feedback") {
      throw new Error("Executor adapter must return a feedback report for feedback claims.");
    }
    const submitResult = await submitFeedback({
      projectRoot: options.projectRoot,
      reportPath: adapterResult.reportPath,
      session: options.session
    });
    return { kind: "submitted", claim, adapterResult, submitResult };
  }

  return executeBlockClaim({ projectRoot: options.projectRoot, claim, executor, session: options.session });
}

export async function getAutoRunStatus(options: { projectRoot: string; session?: ExecutionGraphSession }): Promise<AutoRunStatus> {
  const { workspace } = await loadPackage(options.projectRoot);
  const executionStatus = await getExecutionStatus({ projectRoot: options.projectRoot, session: options.session });
  const latestRuns: AutoRunLatestRunSummary[] = [];

  for (const block of executionStatus.blocks) {
    const runRoot = join(workspace.resultsDir, block.taskId, "blocks", block.blockId, "runs");
    const runId = await latestRunId(runRoot);
    if (!runId) {
      continue;
    }
    const runDir = join(runRoot, runId);
    const metadataPath = join(runDir, "metadata.json");
    const metadata = (await exists(metadataPath)) ? await readJsonFile<Record<string, unknown>>(metadataPath) : {};
    const exitCode = typeof metadata.exitCode === "number" ? metadata.exitCode : null;
    const stderrSummary = await readSummary(join(runDir, "stderr.log"));
    latestRuns.push({
      ref: block.ref,
      taskId: block.taskId,
      blockId: block.blockId,
      runId,
      executor: typeof metadata.executor === "string" ? metadata.executor : null,
      adapter: isExecutorAdapter(metadata.adapter) ? metadata.adapter : null,
      status: block.status,
      stdoutSummary: await readSummary(join(runDir, "stdout.md")),
      stderrSummary,
      failureReason: exitCode !== null && exitCode !== 0 ? ((stderrSummary || block.reason) ?? null) : block.reason ?? null,
      promptPath: join(runDir, "prompt.md"),
      reportPath: (await exists(join(runDir, "report.md"))) ? join(runDir, "report.md") : null,
      metadataPath
    });
  }

  return {
    current: {
      refs: executionStatus.currentRefs,
      feedbackId: executionStatus.currentFeedbackId,
      reviewBlockRef: executionStatus.currentReviewBlockRef
    },
    latestRuns,
    warnings: executionStatus.warnings
  };
}

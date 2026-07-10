import { dirname } from "node:path";
import { createExecutorAdapter } from "../autoRun/executors.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  AutoRunStepResult,
  ClaimScope,
  ClaimResult,
  ExecutionGraphSession,
  ExecutorAdapter,
  PlanPackageManifest
} from "../types.js";
import type { PackageWorkspaceRef } from "../types.js";
import { patchFeedbackArtifact } from "./feedbackArtifacts.js";
import {
  claimNext,
  markBlockBlocked,
  releaseInProgressBlock,
  renderPrompt,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "./index.js";
import { updateTaskIndex } from "./resultIndex.js";
import { loadRuntime, loadRuntimeReadonly, refreshDerivedState } from "./runtimeContext.js";

type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
type SubmittedOrManualStep = Extract<AutoRunStepResult, { kind: "submitted" | "manual" }>;
type BlockedStep = { kind: "blocked"; claim: ClaimResult };
type BlockPipelineStage =
  | "Prompt rendering"
  | "Executor"
  | "Executor result validation"
  | "Implementation submission"
  | "Review submission"
  | "Batch claim preparation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markBlockPipelineFailure(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  stage: BlockPipelineStage;
  error: unknown;
  session?: ExecutionGraphSession;
}): Promise<BlockedStep> {
  const reason = `${options.stage} failed for ${options.ref}: ${errorMessage(options.error)}`;
  try {
    const blocked = await markBlockBlocked({
      projectRoot: options.projectRoot,
      ref: options.ref,
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
  } catch (cleanupError) {
    throw new AggregateError(
      [options.error, cleanupError],
      `${reason}; failed to mark the block blocked: ${errorMessage(cleanupError)}`
    );
  }
}

async function claimForBatchRef(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
}): Promise<BlockClaim> {
  const manifest: PlanPackageManifest =
    options.session?.fileSnapshot.manifest ?? (await loadPackage(options.projectRoot)).manifest;
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
    effectiveExecutor:
      block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? "default",
    reason: "claimed"
  };
}

/**
 * After a feedback executor throws, reopen the envelope and clear the active
 * feedback pointer so the same feedback can be re-claimed (mirrors markBlockBlocked).
 */
async function releaseFeedbackAfterFailure(options: {
  projectRoot: PackageWorkspaceRef;
  feedbackId: string;
  taskId: string;
  session?: ExecutionGraphSession;
}): Promise<void> {
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  await withCanvasLock(dirname(lockWorkspace.stateFile), async () => {
    const context = await loadRuntime({
      projectRoot: options.projectRoot,
      session: options.session
    });
    const { workspace, manifest } = context;
    let { state } = context;
    const feedback = state.feedback[options.feedbackId];
    if (!feedback) {
      throw new Error(`Cannot release unknown feedback '${options.feedbackId}'.`);
    }
    if (feedback.status === "in_progress") {
      await patchFeedbackArtifact(workspace, options.taskId, options.feedbackId, {
        status: "open"
      });
      await updateTaskIndex(workspace, options.taskId, (index) => ({
        ...index,
        feedbackStatusById: {
          ...(index.feedbackStatusById ?? {}),
          [options.feedbackId]: "open"
        }
      }));
      state.feedback[options.feedbackId] = {
        ...feedback,
        status: "open"
      };
    }
    if (state.currentFeedbackId === options.feedbackId) {
      state.currentFeedbackId = null;
    }
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
  });
}

async function executeBlockClaim(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executor: ExecutorAdapter;
  session?: ExecutionGraphSession;
}): Promise<SubmittedOrManualStep | BlockedStep> {
  let stage: BlockPipelineStage = "Prompt rendering";
  try {
    const prompt = await renderPrompt({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      session: options.session,
      includeSubmissionInstructions: false
    });
    stage = "Executor";
    const adapterResult = await options.executor.runBlock({ claim: options.claim, prompt });
    if (adapterResult.kind === "manual") {
      return { kind: "manual", claim: options.claim, adapterResult };
    }
    stage = "Executor result validation";
    if (options.claim.blockType === "review") {
      if (adapterResult.kind !== "review") {
        throw new Error("Executor adapter must return a review result for review block claims.");
      }
      stage = "Review submission";
      const submitResult = await submitReviewResult({
        projectRoot: options.projectRoot,
        ref: options.claim.ref,
        resultPath: adapterResult.resultPath,
        session: options.session
      });
      return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
    }
    if (adapterResult.kind !== "block") {
      throw new Error(
        "Executor adapter must return a block report for implementation block claims."
      );
    }
    stage = "Implementation submission";
    const submitResult = await submitBlockResult({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      reportPath: adapterResult.reportPath,
      runId: adapterResult.runId,
      session: options.session
    });
    return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
  } catch (error) {
    return markBlockPipelineFailure({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      stage,
      error,
      session: options.session
    });
  }
}

async function executeBatchRef(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  executor: ExecutorAdapter;
  session?: ExecutionGraphSession;
}): Promise<SubmittedOrManualStep | BlockedStep> {
  let claim: BlockClaim;
  try {
    claim = await claimForBatchRef(options);
  } catch (error) {
    return markBlockPipelineFailure({
      projectRoot: options.projectRoot,
      ref: options.ref,
      stage: "Batch claim preparation",
      error,
      session: options.session
    });
  }
  return executeBlockClaim({
    projectRoot: options.projectRoot,
    claim,
    executor: options.executor,
    session: options.session
  });
}

async function releaseBatchRefIfInProgress(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
}): Promise<void> {
  const context = await loadRuntimeReadonly({
    projectRoot: options.projectRoot,
    session: options.session
  });
  if (context.state.blocks[options.ref]?.status !== "in_progress") {
    return;
  }
  await releaseInProgressBlock(options);
}

export async function runAutoRunStep(options: {
  projectRoot: PackageWorkspaceRef;
  executor?: ExecutorAdapter;
  executorName?: string;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
  parallel?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
}): Promise<AutoRunStepResult> {
  let claim = await claimNext({
    projectRoot: options.projectRoot,
    parallel: options.parallel,
    scope: options.scope,
    session: options.session
  });
  if (claim.kind === "none" && claim.reason === "no_parallel_blocks") {
    claim = await claimNext({
      projectRoot: options.projectRoot,
      scope: options.scope,
      session: options.session
    });
  }
  if (claim.kind === "none") {
    return { kind: "idle", claim };
  }
  if (claim.kind === "blocked") {
    return { kind: "blocked", claim };
  }
  if (claim.kind === "batch" && claim.reason === "at_capacity") {
    // Streaming scheduler reports live holders without new work; do not re-dispatch them.
    return { kind: "idle", claim };
  }
  if (claim.kind === "batch") {
    const executor =
      options.executor ??
      createExecutorAdapter({
        projectRoot: options.projectRoot,
        executorName: options.executorName,
        runtime: { tmuxEnabled: options.tmuxEnabled, tmuxOwnerRunId: options.tmuxOwnerRunId }
      });
    const settled = await Promise.allSettled(
      claim.refs.map((ref) =>
        executeBatchRef({
          projectRoot: options.projectRoot,
          ref,
          executor,
          session: options.session
        })
      )
    );
    const steps: SubmittedOrManualStep[] = [];
    const blockedSteps: BlockedStep[] = [];
    const executionErrors: unknown[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        executionErrors.push(result.reason);
      } else if (result.value.kind === "blocked") {
        blockedSteps.push(result.value);
      } else {
        steps.push(result.value);
      }
    }
    if (blockedSteps.length === 0 && executionErrors.length === 0) {
      return { kind: "batch_submitted", claim, steps };
    }
    const cleanupResults = await Promise.allSettled(
      claim.refs.map((ref) =>
        releaseBatchRefIfInProgress({
          projectRoot: options.projectRoot,
          ref,
          session: options.session
        })
      )
    );
    const cleanupErrors = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (executionErrors.length > 0 || cleanupErrors.length > 0) {
      const errors = [...executionErrors, ...cleanupErrors];
      throw new AggregateError(
        errors,
        `Parallel Auto Run batch failed to settle cleanly: ${errors.map(errorMessage).join("; ")}`
      );
    }
    return blockedSteps[0];
  }

  const executor =
    options.executor ??
    createExecutorAdapter({
      projectRoot: options.projectRoot,
      executorName: options.executorName,
      runtime: { tmuxEnabled: options.tmuxEnabled, tmuxOwnerRunId: options.tmuxOwnerRunId }
    });
  if (claim.kind === "feedback") {
    let adapterResult: Awaited<ReturnType<ExecutorAdapter["runFeedback"]>>;
    try {
      adapterResult = await executor.runFeedback({ claim });
    } catch (error) {
      const reason = `Executor failed for feedback: ${errorMessage(error)}`;
      await releaseFeedbackAfterFailure({
        projectRoot: options.projectRoot,
        feedbackId: claim.feedbackId,
        taskId: claim.taskId,
        session: options.session
      });
      return {
        kind: "blocked",
        claim: {
          kind: "blocked",
          reason
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

  return executeBlockClaim({
    projectRoot: options.projectRoot,
    claim,
    executor,
    session: options.session
  });
}

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
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";

type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
type SubmittedOrManualStep = Extract<AutoRunStepResult, { kind: "submitted" | "manual" }>;
type BlockedStep = { kind: "blocked"; claim: ClaimResult };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const prompt = await renderPrompt({
    projectRoot: options.projectRoot,
    ref: options.claim.ref,
    session: options.session,
    includeSubmissionInstructions: false
  });
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
    throw new Error("Executor adapter must return a block report for implementation block claims.");
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
    const steps: SubmittedOrManualStep[] = [];
    const executedRefs = new Set<string>();
    for (const ref of claim.refs) {
      const blockClaim = await claimForBatchRef({
        projectRoot: options.projectRoot,
        ref,
        session: options.session
      });
      const step = await executeBlockClaim({
        projectRoot: options.projectRoot,
        claim: blockClaim,
        executor,
        session: options.session
      });
      if (step.kind === "blocked") {
        const remainingRefs = claim.refs.filter(
          (batchRef) => batchRef !== ref && !executedRefs.has(batchRef)
        );
        for (const remainingRef of remainingRefs) {
          await releaseInProgressBlock({
            projectRoot: options.projectRoot,
            ref: remainingRef,
            session: options.session
          });
        }
        return step;
      }
      executedRefs.add(ref);
      steps.push(step);
    }
    return { kind: "batch_submitted", claim, steps };
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

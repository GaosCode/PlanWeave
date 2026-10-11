import { dirname, join, resolve } from "node:path";
import { readVerifiedArtifactReference } from "../autoRun/artifactReferenceContract.js";
import { finalArtifactRelativePath } from "../autoRun/finalArtifactContract.js";
import {
  createExecutorAdapter,
  executorRunnerEvidenceForManifest,
  resolveExecutorRunnerEvidence
} from "../autoRun/executors.js";
import {
  ExecutorClaimRejectedError,
  ExecutorCancelledError,
  isExecutorCancelledError
} from "../autoRun/executorShared.js";
import { createExecutionWaveId, type ExecutionWaveId } from "../autoRun/runnerContractSchemas.js";
import {
  PackageExecutionStateConflictError,
  withExecutionStateLock
} from "./executionStateBoundary.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  AutoRunStepResult,
  AutoRunRunnerEvidence,
  BlockType,
  ClaimScope,
  ClaimResult,
  ExecutionGraphSession,
  ExecutorAdapter,
  ExecutorAdapterResult,
  PlanPackageManifest,
  RuntimeState
} from "../types.js";
import type { PackageWorkspaceRef } from "../types.js";
import { patchFeedbackArtifact } from "./feedbackArtifacts.js";
import { submitFeedbackFromBytes } from "./feedbackSubmission.js";
import { submitVerifiedBlockResult } from "./blockSubmission.js";
import {
  claimNext,
  markBlockBlocked,
  releaseInProgressBlock,
  renderPrompt,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "./index.js";
import { readImplementationRunMetadataFile } from "./implementationRunMetadata.js";
import { missingImplementationClaimIdentityReason } from "./implementationClaimIdentity.js";
import { updateTaskIndex } from "./resultIndex.js";
import { reviewResultSchema } from "./reviewResultContract.js";
import { submitReviewResultValue } from "./reviewSubmission.js";
import { loadRuntime, loadRuntimeReadonly, refreshDerivedState } from "./runtimeContext.js";

type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
type SubmittedOrManualStep = Extract<AutoRunStepResult, { kind: "submitted" | "manual" }>;
type BlockedStep = Extract<AutoRunStepResult, { kind: "blocked" }>;
type BlockPipelineStage =
  | "Prompt rendering"
  | "Executor"
  | "Executor result validation"
  | "Implementation submission"
  | "Review submission"
  | "Batch claim preparation";

type VerifiedSubmissionArtifact = {
  reference: Awaited<ReturnType<typeof readVerifiedArtifactReference>>["reference"];
  bytes: Buffer;
  reviewResult?: unknown;
};

type ExpectedArtifactIdentity =
  | { ref: string; taskId: string; blockId: string }
  | {
      feedbackId: string;
      sourceReviewBlockRef: string;
      taskId: string;
    };

function assertAcpMetadataIdentity(
  metadata: Record<string, unknown>,
  expected: ExpectedArtifactIdentity
): void {
  if ("ref" in expected) {
    if (
      metadata.ref !== expected.ref ||
      metadata.claimRef !== expected.ref ||
      metadata.taskId !== expected.taskId ||
      metadata.blockId !== expected.blockId
    ) {
      throw new Error("ACP artifact metadata does not identify the active block claim.");
    }
    return;
  }
  if (
    metadata.ref !== expected.sourceReviewBlockRef ||
    metadata.claimRef !== expected.sourceReviewBlockRef ||
    metadata.sourceReviewBlockRef !== expected.sourceReviewBlockRef ||
    metadata.feedbackId !== expected.feedbackId ||
    metadata.taskId !== expected.taskId
  ) {
    throw new Error("ACP artifact metadata does not identify the active feedback claim.");
  }
}

async function readExecutorSubmissionArtifact(options: {
  adapter: ExecutorAdapterResult["adapter"];
  runnerKind: ExecutorAdapterResult["runnerKind"];
  agentId: ExecutorAdapterResult["agentId"];
  artifactPath: string;
  runId: string | undefined;
  expectedKind: "implementation" | "review" | "feedback";
  expectedIdentity: ExpectedArtifactIdentity;
}): Promise<VerifiedSubmissionArtifact | null> {
  const isAcp = options.runnerKind === "acp";
  if (!isAcp && (options.adapter === undefined || options.adapter === "manual")) {
    return null;
  }
  // Executor attempt metadata for block/review/feedback runs reuses the implementation-run
  // family contract (typed identity + artifactReference; adapter/outcome via passthrough).
  const metadataPath = join(dirname(options.artifactPath), "metadata.json");
  const metadata = (await readImplementationRunMetadataFile(metadataPath)) as Record<
    string,
    unknown
  >;
  if (
    (!isAcp && metadata.adapter !== options.adapter) ||
    (isAcp &&
      (options.adapter !== undefined ||
        options.agentId === undefined ||
        options.agentId === null ||
        metadata.runnerKind !== "acp" ||
        metadata.agentId !== options.agentId)) ||
    metadata.outcome !== "succeeded" ||
    typeof options.runId !== "string" ||
    metadata.runId !== options.runId
  ) {
    throw new Error("Executor artifact metadata does not identify the successful adapter result.");
  }
  if (isAcp) {
    assertAcpMetadataIdentity(metadata, options.expectedIdentity);
  } else if ("ref" in options.expectedIdentity) {
    if (
      metadata.ref !== options.expectedIdentity.ref ||
      metadata.taskId !== options.expectedIdentity.taskId ||
      metadata.blockId !== options.expectedIdentity.blockId
    ) {
      throw new Error("Executor artifact metadata does not identify the active block claim.");
    }
  } else if (
    metadata.feedbackId !== options.expectedIdentity.feedbackId ||
    metadata.sourceReviewBlockRef !== options.expectedIdentity.sourceReviewBlockRef ||
    metadata.taskId !== options.expectedIdentity.taskId
  ) {
    throw new Error("Executor artifact metadata does not identify the active feedback claim.");
  }
  const verified = await readVerifiedArtifactReference({
    rootDir: dirname(options.artifactPath),
    value: metadata.artifactReference
  });
  const expectedPath = finalArtifactRelativePath(options.expectedKind);
  if (
    verified.reference.kind !== options.expectedKind ||
    verified.reference.relativePath !== expectedPath ||
    resolve(dirname(options.artifactPath), verified.reference.relativePath) !==
      resolve(options.artifactPath)
  ) {
    throw new Error(
      `Executor artifact reference does not identify the expected ${options.expectedKind} artifact.`
    );
  }
  return options.expectedKind === "review"
    ? {
        reference: verified.reference,
        bytes: verified.bytes,
        reviewResult: reviewResultSchema.parse(JSON.parse(verified.bytes.toString("utf8")))
      }
    : { reference: verified.reference, bytes: verified.bytes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownsWritableBlockClaim(
  state: RuntimeState,
  ref: string,
  submissionAttemptId: string | undefined,
  blockType: BlockType | undefined
): boolean {
  const current = state.blocks[ref];
  return (
    current?.status === "in_progress" &&
    state.currentRefs.includes(ref) &&
    !current.remoteOwnership &&
    (blockType !== "implementation" || submissionAttemptId !== undefined) &&
    (submissionAttemptId === undefined || current.submissionAttemptId === submissionAttemptId)
  );
}

async function runnerEvidence(options: {
  projectRoot: PackageWorkspaceRef;
  executorName: string;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<AutoRunRunnerEvidence> {
  return options.executionSnapshot
    ? executorRunnerEvidenceForManifest(options.executionSnapshot.manifest, options.executorName)
    : options.session
      ? executorRunnerEvidenceForManifest(
          options.session.fileSnapshot.manifest,
          options.executorName
        )
      : resolveExecutorRunnerEvidence(options);
}

async function markBlockPipelineFailure(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  submissionAttemptId?: string;
  stage: BlockPipelineStage;
  error: unknown;
  runnerEvidence?: AutoRunRunnerEvidence;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<BlockedStep> {
  const reason = `${options.stage} failed for ${options.ref}: ${errorMessage(options.error)}`;
  const { workspace } = await loadPackage(options.projectRoot);
  return withExecutionStateLock<BlockedStep>(options, dirname(workspace.stateFile), async () => {
    const current = await loadRuntimeReadonly(options).catch((cleanupError: unknown) => {
      throw new AggregateError(
        [options.error, cleanupError],
        `${reason}; failed to mark the block blocked: ${errorMessage(cleanupError)}`
      );
    });
    if (
      !ownsWritableBlockClaim(
        current.state,
        options.ref,
        options.submissionAttemptId,
        current.graph.blocksByRef.get(options.ref)?.type
      )
    )
      throw options.error;
    try {
      const blocked = await markBlockBlocked({ ...options, reason });
      return {
        kind: "blocked",
        claim: { kind: "blocked", ref: blocked.ref, reason: blocked.reason },
        ...(options.runnerEvidence ? { runnerEvidence: options.runnerEvidence } : {})
      };
    } catch (cleanupError) {
      throw new AggregateError(
        [options.error, cleanupError],
        `${reason}; failed to mark the block blocked: ${errorMessage(cleanupError)}`
      );
    }
  }).catch((cleanupError: unknown) => {
    if (cleanupError instanceof PackageExecutionStateConflictError) throw options.error;
    throw cleanupError;
  });
}

async function claimForBatchRef(options: {
  submissionAttemptId?: string;
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<BlockClaim> {
  const manifest: PlanPackageManifest =
    options.executionSnapshot?.manifest ??
    options.session?.fileSnapshot.manifest ??
    (await loadPackage(options.projectRoot)).manifest;
  const { taskId, blockId } = parseBlockRef(options.ref);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (task?.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  const block = task.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  if (block.type === "implementation" && !options.submissionAttemptId) {
    throw new ExecutorClaimRejectedError(missingImplementationClaimIdentityReason(options.ref));
  }
  return {
    kind: "block",
    ref: options.ref,
    taskId,
    blockId,
    blockType: block.type,
    ...(options.submissionAttemptId ? { submissionAttemptId: options.submissionAttemptId } : {}),
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
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<void> {
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  await withExecutionStateLock(options, dirname(lockWorkspace.stateFile), async () => {
    const context = await loadRuntime({
      projectRoot: options.projectRoot,
      executionSnapshot: options.executionSnapshot,
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
  runnerEvidence: AutoRunRunnerEvidence;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
  signal?: AbortSignal;
  executionWaveId?: ExecutionWaveId;
}): Promise<SubmittedOrManualStep | BlockedStep> {
  const submissionAttemptId = options.claim.submissionAttemptId;
  let stage: BlockPipelineStage = "Prompt rendering";
  try {
    if (options.claim.blockType === "implementation" && !submissionAttemptId) {
      throw new ExecutorClaimRejectedError(
        missingImplementationClaimIdentityReason(options.claim.ref)
      );
    }
    const prompt = await renderPrompt({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      executionSnapshot: options.executionSnapshot,
      session: options.session,
      includeSubmissionInstructions: false
    });
    stage = "Executor";
    const adapterResult = await options.executor.runBlock({
      claim: options.claim,
      prompt,
      ...(options.executionWaveId ? { executionWaveId: options.executionWaveId } : {})
    });
    if (adapterResult.kind === "manual") {
      return { kind: "manual", claim: options.claim, adapterResult };
    }
    if (options.signal?.aborted && adapterResult.runnerKind === "acp") {
      throw new ExecutorCancelledError("Executor result was cancelled before submission.");
    }
    stage = "Executor result validation";
    if (options.claim.blockType === "review") {
      if (adapterResult.kind !== "review") {
        throw new Error("Executor adapter must return a review result for review block claims.");
      }
      stage = "Review submission";
      const artifact = await readExecutorSubmissionArtifact({
        adapter: adapterResult.adapter,
        runnerKind: adapterResult.runnerKind,
        agentId: adapterResult.agentId,
        artifactPath: adapterResult.resultPath,
        runId: adapterResult.runId,
        expectedKind: "review",
        expectedIdentity: {
          ref: options.claim.ref,
          taskId: options.claim.taskId,
          blockId: options.claim.blockId
        }
      });
      const submissionOptions = {
        projectRoot: options.projectRoot,
        ref: options.claim.ref,
        resultPath: adapterResult.resultPath,
        executionSnapshot: options.executionSnapshot,
        session: options.session
      };
      const submitResult = artifact
        ? await submitReviewResultValue(submissionOptions, artifact.reviewResult)
        : await submitReviewResult(submissionOptions);
      return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
    }
    if (adapterResult.kind !== "block") {
      throw new Error(
        "Executor adapter must return a block report for implementation block claims."
      );
    }
    stage = "Implementation submission";
    const artifact = await readExecutorSubmissionArtifact({
      adapter: adapterResult.adapter,
      runnerKind: adapterResult.runnerKind,
      agentId: adapterResult.agentId,
      artifactPath: adapterResult.reportPath,
      runId: adapterResult.runId,
      expectedKind: "implementation",
      expectedIdentity: {
        ref: options.claim.ref,
        taskId: options.claim.taskId,
        blockId: options.claim.blockId
      }
    });
    const submissionOptions = {
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      reportPath: adapterResult.reportPath,
      runId: adapterResult.runId,
      submissionAttemptId,
      executionSnapshot: options.executionSnapshot,
      session: options.session
    };
    const submitResult = artifact
      ? await submitVerifiedBlockResult(submissionOptions, artifact)
      : await submitBlockResult(submissionOptions);
    return { kind: "submitted", claim: options.claim, adapterResult, submitResult };
  } catch (error) {
    if (error instanceof ExecutorClaimRejectedError) throw error;
    if (isExecutorCancelledError(error)) {
      const { workspace } = await loadPackage(options.projectRoot);
      return withExecutionStateLock(options, dirname(workspace.stateFile), async () => {
        const current = await loadRuntimeReadonly({
          projectRoot: options.projectRoot,
          executionSnapshot: options.executionSnapshot,
          session: options.session
        });
        if (
          !ownsWritableBlockClaim(
            current.state,
            options.claim.ref,
            submissionAttemptId,
            current.graph.blocksByRef.get(options.claim.ref)?.type
          )
        )
          throw error;
        await releaseInProgressBlock({
          projectRoot: options.projectRoot,
          ref: options.claim.ref,
          executionSnapshot: options.executionSnapshot,
          session: options.session
        });
        throw error;
      }).catch((cleanupError: unknown) => {
        if (cleanupError instanceof PackageExecutionStateConflictError) throw error;
        throw cleanupError;
      });
    }
    return markBlockPipelineFailure({
      projectRoot: options.projectRoot,
      ref: options.claim.ref,
      submissionAttemptId,
      stage,
      error,
      runnerEvidence: options.runnerEvidence,
      executionSnapshot: options.executionSnapshot,
      session: options.session
    });
  }
}

async function executeBatchRef(options: {
  submissionAttemptId?: string;
  projectRoot: PackageWorkspaceRef;
  ref: string;
  executor: ExecutorAdapter;
  executorName?: string;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
  signal?: AbortSignal;
  executionWaveId: ExecutionWaveId;
}): Promise<SubmittedOrManualStep | BlockedStep> {
  let claim: BlockClaim;
  try {
    claim = await claimForBatchRef(options);
  } catch (error) {
    if (error instanceof ExecutorClaimRejectedError) throw error;
    return markBlockPipelineFailure({
      projectRoot: options.projectRoot,
      ref: options.ref,
      submissionAttemptId: options.submissionAttemptId,
      stage: "Batch claim preparation",
      error,
      executionSnapshot: options.executionSnapshot,
      session: options.session
    });
  }
  return executeBlockClaim({
    projectRoot: options.projectRoot,
    claim,
    executor: options.executor,
    runnerEvidence: await runnerEvidence({
      projectRoot: options.projectRoot,
      executorName: options.executorName ?? claim.effectiveExecutor,
      executionSnapshot: options.executionSnapshot,
      session: options.session
    }),
    executionSnapshot: options.executionSnapshot,
    session: options.session,
    signal: options.signal,
    executionWaveId: options.executionWaveId
  });
}

async function releaseBatchRefIfInProgress(options: {
  submissionAttemptId?: string;
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<void> {
  const { workspace } = await loadPackage(options.projectRoot);
  await withExecutionStateLock(options, dirname(workspace.stateFile), async () => {
    const context = await loadRuntimeReadonly({
      projectRoot: options.projectRoot,
      executionSnapshot: options.executionSnapshot,
      session: options.session
    });
    if (
      !ownsWritableBlockClaim(
        context.state,
        options.ref,
        options.submissionAttemptId,
        context.graph.blocksByRef.get(options.ref)?.type
      )
    )
      return;
    await releaseInProgressBlock(options);
  });
}

export async function runAutoRunStep(options: {
  projectRoot: PackageWorkspaceRef;
  executor?: ExecutorAdapter;
  executorName?: string;
  tmuxEnabled?: boolean;
  tmuxOwnerRunId?: string;
  signal?: AbortSignal;
  cliSignal?: AbortSignal;
  timeoutMs?: number;
  desktopRunId?: string;
  runSessionId?: string;
  interactionBroker?: import("../autoRun/liveControl.js").RunnerInteractionBroker;
  interactionObserver?: import("../autoRun/runnerInteractionObserver.js").RunnerInteractionObserver;
  acpRecovery?: import("../autoRun/acpRunRecovery.js").AcpRunRecoveryExecution;
  parallel?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<AutoRunStepResult> {
  options = {
    ...options,
    projectRoot:
      options.executionSnapshot?.workspace ?? (await resolvePackageWorkspace(options.projectRoot))
  };
  let claim = await claimNext({
    projectRoot: options.projectRoot,
    parallel: options.parallel,
    scope: options.scope,
    executionSnapshot: options.executionSnapshot,
    session: options.session
  });
  if (claim.kind === "none" && claim.reason === "no_parallel_blocks") {
    claim = await claimNext({
      projectRoot: options.projectRoot,
      scope: options.scope,
      executionSnapshot: options.executionSnapshot,
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
    const executionWaveId = createExecutionWaveId();
    const executor =
      options.executor ??
      createExecutorAdapter({
        executionSnapshot: options.executionSnapshot,
        projectRoot: options.projectRoot,
        executorName: options.executorName,
        runtime: {
          tmuxEnabled: options.tmuxEnabled,
          tmuxOwnerRunId: options.tmuxOwnerRunId,
          signal: options.signal,
          cliSignal: options.cliSignal,
          timeoutMs: options.timeoutMs,
          desktopRunId: options.desktopRunId,
          runSessionId: options.runSessionId,
          interactionBroker: options.interactionBroker,
          interactionObserver: options.interactionObserver,
          acpRecovery: options.acpRecovery
        }
      });
    const settled = await Promise.allSettled(
      claim.refs.map((ref) =>
        executeBatchRef({
          projectRoot: options.projectRoot,
          ref,
          submissionAttemptId: claim.submissionAttemptIds?.[ref],
          executor,
          executorName: options.executorName,
          executionSnapshot: options.executionSnapshot,
          session: options.session,
          signal: options.signal,
          executionWaveId
        })
      )
    );
    const steps: SubmittedOrManualStep[] = [];
    const blockedSteps: BlockedStep[] = [];
    const executionErrors: unknown[] = [];
    const rejectedRefs = new Set<string>();
    for (const [index, result] of settled.entries()) {
      if (result.status === "rejected") {
        executionErrors.push(result.reason);
        if (result.reason instanceof ExecutorClaimRejectedError)
          rejectedRefs.add(claim.refs[index]);
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
      claim.refs
        .filter((ref) => !rejectedRefs.has(ref))
        .map((ref) =>
          releaseBatchRefIfInProgress({
            projectRoot: options.projectRoot,
            ref,
            submissionAttemptId: claim.submissionAttemptIds?.[ref],
            executionSnapshot: options.executionSnapshot,
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
      executionSnapshot: options.executionSnapshot,
      projectRoot: options.projectRoot,
      executorName: options.executorName,
      runtime: {
        tmuxEnabled: options.tmuxEnabled,
        tmuxOwnerRunId: options.tmuxOwnerRunId,
        signal: options.signal,
        cliSignal: options.cliSignal,
        timeoutMs: options.timeoutMs,
        desktopRunId: options.desktopRunId,
        runSessionId: options.runSessionId,
        interactionBroker: options.interactionBroker,
        interactionObserver: options.interactionObserver,
        acpRecovery: options.acpRecovery
      }
    });
  if (claim.kind === "feedback") {
    const selectedRunnerEvidence = await runnerEvidence({
      projectRoot: options.projectRoot,
      executorName: options.executorName ?? claim.effectiveExecutor,
      executionSnapshot: options.executionSnapshot,
      session: options.session
    });
    try {
      const adapterResult = await executor.runFeedback({ claim });
      if (adapterResult.kind === "manual") {
        return { kind: "manual", claim, adapterResult };
      }
      if (adapterResult.kind !== "feedback") {
        throw new Error("Executor adapter must return a feedback report for feedback claims.");
      }
      if (options.signal?.aborted && adapterResult.runnerKind === "acp") {
        throw new ExecutorCancelledError("Executor result was cancelled before submission.");
      }
      const artifact = await readExecutorSubmissionArtifact({
        adapter: adapterResult.adapter,
        runnerKind: adapterResult.runnerKind,
        agentId: adapterResult.agentId,
        artifactPath: adapterResult.reportPath,
        runId: adapterResult.runId,
        expectedKind: "feedback",
        expectedIdentity: {
          feedbackId: claim.feedbackId,
          sourceReviewBlockRef: claim.sourceReviewBlockRef,
          taskId: claim.taskId
        }
      });
      const submissionOptions = {
        projectRoot: options.projectRoot,
        reportPath: adapterResult.reportPath,
        executionSnapshot: options.executionSnapshot,
        session: options.session
      };
      const submitResult = artifact
        ? await submitFeedbackFromBytes(submissionOptions, artifact.bytes)
        : await submitFeedback(submissionOptions);
      return { kind: "submitted", claim, adapterResult, submitResult };
    } catch (error) {
      if (isExecutorCancelledError(error)) {
        await releaseFeedbackAfterFailure({
          projectRoot: options.projectRoot,
          feedbackId: claim.feedbackId,
          taskId: claim.taskId,
          executionSnapshot: options.executionSnapshot,
          session: options.session
        }).catch((cleanupError: unknown) => {
          if (cleanupError instanceof PackageExecutionStateConflictError) throw error;
          throw cleanupError;
        });
        throw error;
      }
      const reason = `Executor failed for feedback: ${errorMessage(error)}`;
      await releaseFeedbackAfterFailure({
        projectRoot: options.projectRoot,
        feedbackId: claim.feedbackId,
        taskId: claim.taskId,
        executionSnapshot: options.executionSnapshot,
        session: options.session
      }).catch((cleanupError: unknown) => {
        if (cleanupError instanceof PackageExecutionStateConflictError) throw error;
        throw cleanupError;
      });
      return {
        kind: "blocked",
        claim: {
          kind: "blocked",
          reason
        },
        runnerEvidence: selectedRunnerEvidence
      };
    }
  }

  return executeBlockClaim({
    projectRoot: options.projectRoot,
    claim,
    executor,
    runnerEvidence: await runnerEvidence({
      projectRoot: options.projectRoot,
      executorName: options.executorName ?? claim.effectiveExecutor,
      executionSnapshot: options.executionSnapshot,
      session: options.session
    }),
    executionSnapshot: options.executionSnapshot,
    session: options.session,
    signal: options.signal
  });
}

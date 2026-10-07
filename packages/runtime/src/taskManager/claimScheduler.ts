import { dirname } from "node:path";
import { withExecutionStateLock } from "./executionStateBoundary.js";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  BlockType,
  ClaimResult,
  ClaimScope,
  CompiledExecutionGraph,
  ExecutionGraphSession,
  PackageWorkspaceRef
} from "../types.js";
import { claimDispatchedBlock } from "./claimBlockDispatch.js";
import { buildClaimReadiness, type ClaimCandidate } from "./claimReadiness.js";
import { applyCurrentReviewResumeClaim } from "./blockStatusMutations.js";
import { patchFeedbackArtifact } from "./feedbackArtifacts.js";
import { createProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import { updateTaskIndex } from "./resultIndex.js";
import { loadRuntimeReadonly, refreshDerivedState } from "./runtimeContext.js";
import { missingImplementationClaimIdentityReason } from "./implementationClaimIdentity.js";
import {
  markClaimed,
  claimedBlockState,
  getBlock,
  effectiveBlockExecutor,
  inProgressBlockRefs,
  normalizeClaimScope,
  validateClaimScope
} from "./selectors.js";

function withoutCurrentRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.filter((currentRef) => currentRef !== ref);
}

function effectiveExecutorsForRefs(
  refs: string[],
  graph: CompiledExecutionGraph,
  defaultExecutor?: string
): Record<string, string> {
  return Object.fromEntries(
    refs.map((ref) => [ref, effectiveBlockExecutor(graph, ref, defaultExecutor)])
  );
}

export async function claimNext(options: {
  projectRoot: PackageWorkspaceRef;
  parallel?: boolean;
  blockType?: BlockType;
  dryRun?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<ClaimResult> {
  if (options.dryRun === true) {
    return claimNextUnlocked({ ...options, dryRun: true });
  }

  // Resolve workspace path for the lock without writing; the locked body reloads state.
  const workspace = await resolvePackageWorkspace(options.projectRoot);
  return withExecutionStateLock(options, dirname(workspace.stateFile), async () =>
    claimNextUnlocked({ ...options, dryRun: false })
  );
}

async function claimNextUnlocked(options: {
  projectRoot: PackageWorkspaceRef;
  parallel?: boolean;
  blockType?: BlockType;
  dryRun?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<ClaimResult> {
  const dryRun = options.dryRun === true;
  const context = await loadRuntimeReadonly(options);
  let { state } = context;
  const { graph, manifest, workspace } = context;
  const scope = normalizeClaimScope(options.scope);
  const blockType = options.blockType;
  const invalidScope = validateClaimScope(scope, graph);
  if (invalidScope) {
    return invalidScope;
  }
  const projectGuard = await createProjectGraphClaimGuard(context);
  const readiness = buildClaimReadiness({ graph, manifest, state, scope, blockType, projectGuard });

  if (
    !dryRun &&
    readiness.claimOrder.kind === "currentBlock" &&
    readiness.claimOrder.result.blockType === "implementation" &&
    !state.blocks[readiness.claimOrder.ref].submissionAttemptId
  ) {
    return {
      kind: "blocked",
      ref: readiness.claimOrder.ref,
      reason: missingImplementationClaimIdentityReason(readiness.claimOrder.ref)
    };
  }
  if (!dryRun && JSON.stringify(context.rawState) !== JSON.stringify(state)) {
    await writeState(workspace.stateFile, state);
  }

  if (readiness.claimOrder.kind === "blocked") {
    return readiness.claimOrder.result;
  }
  if (readiness.claimOrder.kind === "feedback") {
    const { feedbackId, feedback, taskId } = readiness.claimOrder;
    if (dryRun) {
      return readiness.claimOrder.result;
    }
    await patchFeedbackArtifact(workspace, taskId, feedbackId, { status: "in_progress" });
    await updateTaskIndex(workspace, taskId, (index) => ({
      ...index,
      feedbackStatusById: {
        ...(index.feedbackStatusById ?? {}),
        [feedbackId]: "in_progress"
      }
    }));
    feedback.status = "in_progress";
    state.currentFeedbackId = feedbackId;
    state.currentReviewBlockRef = feedback.sourceReviewBlockRef;
    state.currentRefs = withoutCurrentRef(state.currentRefs, feedback.sourceReviewBlockRef);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return readiness.claimOrder.result;
  }

  if (readiness.claimOrder.kind === "currentReview") {
    if (dryRun) {
      return readiness.claimOrder.result;
    }
    applyCurrentReviewResumeClaim(state, readiness.claimOrder.ref, {
      clearCurrentFeedback: readiness.claimOrder.clearCurrentFeedback
    });
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return readiness.claimOrder.result;
  }

  // Sequential mode keeps the current-block short-circuit. Parallel mode streams/backfills
  // capacity while live work remains (do not re-return currentBlock as a barrier).
  if (!options.parallel && readiness.claimOrder.kind === "currentBlock") {
    return {
      ...readiness.claimOrder.result,
      ...(readiness.claimOrder.result.blockType === "implementation"
        ? { submissionAttemptId: state.blocks[readiness.claimOrder.ref].submissionAttemptId }
        : {})
    };
  }

  const claimCandidate = async (
    candidate: ClaimCandidate,
    retainedRefs: readonly string[] = []
  ): Promise<ClaimResult> => {
    if (dryRun) {
      return candidate.result;
    }
    markClaimed(state, candidate.ref, graph);
    if (retainedRefs.length > 0) {
      state.currentRefs = [
        ...retainedRefs,
        ...state.currentRefs.filter((ref) => !retainedRefs.includes(ref))
      ];
    }
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return {
      ...candidate.result,
      ...(candidate.result.blockType === "implementation"
        ? { submissionAttemptId: state.blocks[candidate.ref].submissionAttemptId }
        : {})
    };
  };

  const claimSequentialReviewBlock = async (
    retainedRefs: readonly string[] = []
  ): Promise<ClaimResult | null> => {
    const candidate = readiness.sequentialReviewCandidates[0];
    return candidate ? claimCandidate(candidate, retainedRefs) : null;
  };

  if (options.parallel) {
    if (!manifest.execution.parallel.enabled) {
      return { kind: "blocked", reason: "Parallel execution is disabled by the Plan Package." };
    }
    const retained = inProgressBlockRefs(graph, state);
    const capacity = manifest.execution.parallel.maxConcurrent - retained.length;
    if (capacity <= 0) {
      return {
        kind: "batch",
        refs: retained,
        effectiveExecutors: effectiveExecutorsForRefs(
          retained,
          graph,
          manifest.execution.defaultExecutor
        ),
        reason: "at_capacity"
      };
    }
    const selected = readiness.parallelBatchRefs;
    if (selected.length === 0) {
      const reviewClaim = await claimSequentialReviewBlock(retained);
      if (reviewClaim) {
        if (dryRun && reviewClaim.kind === "block" && reviewClaim.blockType === "review") {
          return {
            ...reviewClaim,
            requestedMode: "parallel",
            parallelFallbackReason: "review_requires_sequential_claim",
            nextParallelClaimable: []
          };
        }
        return reviewClaim;
      }
      if (retained.length > 0) {
        // Live implementations remain, but no implementation or review can use the free slot.
        // Keep currentRefs intact and let a streaming caller wait for the next completion.
        return {
          kind: "batch",
          refs: retained,
          effectiveExecutors: effectiveExecutorsForRefs(
            retained,
            graph,
            manifest.execution.defaultExecutor
          ),
          reason: "at_capacity"
        };
      }
      if (readiness.firstProjectBlockedResult) {
        return readiness.firstProjectBlockedResult;
      }
      state.currentRefs = [];
      if (!dryRun) {
        await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      }
      return {
        kind: "none",
        reason: "no_parallel_blocks",
        nextSequentialClaimable: readiness.scopedNextSequentialClaimable
      };
    }
    if (dryRun) {
      return {
        kind: "batch",
        refs: selected,
        effectiveExecutors: effectiveExecutorsForRefs(
          selected,
          graph,
          manifest.execution.defaultExecutor
        )
      };
    }
    for (const ref of selected) {
      state.blocks[ref] = claimedBlockState(state.blocks[ref], getBlock(graph, ref).type);
      if (graph.blocksByRef.get(ref)?.type === "review") {
        state.currentReviewBlockRef = ref;
      }
    }
    // Union retained in_progress with newly claimed; never drop a live ref.
    state.currentRefs = [...retained, ...selected.filter((ref) => !retained.includes(ref))];
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return {
      kind: "batch",
      // Return only newly claimed refs so Auto Run does not re-dispatch live work.
      refs: selected,
      submissionAttemptIds: Object.fromEntries(
        selected.flatMap((ref) => {
          const attemptId = state.blocks[ref].submissionAttemptId;
          return getBlock(graph, ref).type === "implementation" && attemptId
            ? [[ref, attemptId]]
            : [];
        })
      ),
      effectiveExecutors: effectiveExecutorsForRefs(
        selected,
        graph,
        manifest.execution.defaultExecutor
      )
    };
  }

  // Sequential claim is task-closed-loop: finish a ready review gate before
  // starting another task's implementation. Parallel keeps implementation priority,
  // then fills remaining capacity with at most one ready review.
  const reviewClaim = await claimSequentialReviewBlock();
  if (reviewClaim) {
    return reviewClaim;
  }

  const implementationClaim = readiness.sequentialImplementationCandidates[0];
  if (implementationClaim) {
    return claimCandidate(implementationClaim);
  }

  if (readiness.firstProjectBlockedResult) {
    return readiness.firstProjectBlockedResult;
  }

  if (readiness.firstBlockedResult) {
    return readiness.firstBlockedResult;
  }

  if (!dryRun) {
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
  }
  return { kind: "none", reason: "no_claimable_blocks" };
}

export async function claimBlock(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  dispatch?: boolean;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<ClaimResult> {
  if (options.dispatch) {
    return claimDispatchedBlock(options);
  }
  return claimNext({
    projectRoot: options.projectRoot,
    scope: { kind: "block", blockRef: options.ref },
    executionSnapshot: options.executionSnapshot,
    session: options.session
  });
}

export async function claimTask(options: {
  projectRoot: PackageWorkspaceRef;
  taskId: string;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<ClaimResult> {
  return claimNext({
    projectRoot: options.projectRoot,
    scope: { kind: "task", taskId: options.taskId },
    executionSnapshot: options.executionSnapshot,
    session: options.session
  });
}

export async function claimBlockType(options: {
  projectRoot: PackageWorkspaceRef;
  blockType: BlockType;
  session?: ExecutionGraphSession;
  executionSnapshot?: import("../package/packageExecutionSnapshot.js").PackageExecutionSnapshot;
}): Promise<ClaimResult> {
  return claimNext({
    projectRoot: options.projectRoot,
    blockType: options.blockType,
    executionSnapshot: options.executionSnapshot,
    session: options.session
  });
}

import { dirname } from "node:path";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { loadPackage } from "../package/loadPackage.js";
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
import { patchFeedbackArtifact } from "./feedbackArtifacts.js";
import { createProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import { updateTaskIndex } from "./resultIndex.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import {
  markClaimed,
  effectiveBlockExecutor,
  inProgressImplementationRefs,
  normalizeClaimScope,
  validateClaimScope
} from "./selectors.js";

function withCurrentRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.includes(ref) ? currentRefs : [...currentRefs, ref];
}

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
}): Promise<ClaimResult> {
  if (options.dryRun === true) {
    return claimNextUnlocked({ ...options, dryRun: true });
  }

  // Resolve workspace path for the lock without writing; the locked body reloads state.
  const { workspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(workspace.stateFile), async () =>
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
}): Promise<ClaimResult> {
  const context = await loadRuntime(options);
  let { state } = context;
  const { graph, manifest, workspace } = context;
  const scope = normalizeClaimScope(options.scope);
  const blockType = options.blockType;
  const dryRun = options.dryRun === true;
  const invalidScope = validateClaimScope(scope, graph);
  if (invalidScope) {
    return invalidScope;
  }
  const projectGuard = await createProjectGraphClaimGuard(context);
  const readiness = buildClaimReadiness({ graph, manifest, state, scope, blockType, projectGuard });

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
    state.blocks[readiness.claimOrder.ref] = {
      ...state.blocks[readiness.claimOrder.ref],
      pendingFeedbackId: null
    };
    state.currentRefs = withCurrentRef(state.currentRefs, readiness.claimOrder.ref);
    if (readiness.claimOrder.clearCurrentFeedback) {
      state.currentFeedbackId = null;
    }
    state.currentReviewBlockRef = readiness.claimOrder.ref;
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return readiness.claimOrder.result;
  }

  // Sequential mode keeps the current-block short-circuit. Parallel mode streams/backfills
  // capacity while live work remains (do not re-return currentBlock as a barrier).
  if (!options.parallel && readiness.claimOrder.kind === "currentBlock") {
    return readiness.claimOrder.result;
  }

  const claimCandidate = async (candidate: ClaimCandidate): Promise<ClaimResult> => {
    if (dryRun) {
      return candidate.result;
    }
    markClaimed(state, candidate.ref, graph);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return candidate.result;
  };

  const claimSequentialReviewBlock = async (): Promise<ClaimResult | null> => {
    const candidate = readiness.sequentialReviewCandidates[0];
    return candidate ? claimCandidate(candidate) : null;
  };

  if (options.parallel) {
    if (!manifest.execution.parallel.enabled) {
      return { kind: "blocked", reason: "Parallel execution is disabled by the Plan Package." };
    }
    const retained = inProgressImplementationRefs(graph, state);
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
      if (retained.length > 0) {
        // Live work remains; do not clear currentRefs or re-dispatch retained refs.
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
      const reviewClaim = await claimSequentialReviewBlock();
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
      state.blocks[ref] = { ...state.blocks[ref], status: "in_progress" };
    }
    // Union retained in_progress with newly claimed; never drop a live ref.
    state.currentRefs = [...retained, ...selected.filter((ref) => !retained.includes(ref))];
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return {
      kind: "batch",
      // Return only newly claimed refs so Auto Run does not re-dispatch live work.
      refs: selected,
      effectiveExecutors: effectiveExecutorsForRefs(
        selected,
        graph,
        manifest.execution.defaultExecutor
      )
    };
  }

  const implementationClaim = readiness.sequentialImplementationCandidates[0];
  if (implementationClaim) {
    return claimCandidate(implementationClaim);
  }

  const reviewClaim = await claimSequentialReviewBlock();
  if (reviewClaim) {
    return reviewClaim;
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
}): Promise<ClaimResult> {
  if (options.dispatch) {
    return claimDispatchedBlock(options);
  }
  return claimNext({
    projectRoot: options.projectRoot,
    scope: { kind: "block", blockRef: options.ref },
    session: options.session
  });
}

export async function claimTask(options: {
  projectRoot: PackageWorkspaceRef;
  taskId: string;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  return claimNext({
    projectRoot: options.projectRoot,
    scope: { kind: "task", taskId: options.taskId },
    session: options.session
  });
}

export async function claimBlockType(options: {
  projectRoot: PackageWorkspaceRef;
  blockType: BlockType;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  return claimNext({
    projectRoot: options.projectRoot,
    blockType: options.blockType,
    session: options.session
  });
}

import { dirname } from "node:path";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  BlockStatus,
  ExecutionGraphSession,
  PackageWorkspaceRef,
  RuntimeState
} from "../types.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import {
  clearRemoteBlockOperationState,
  withoutRemoteBlockOwnership
} from "./remoteOwnershipTransitions.js";
import { clearReviewCompletionReason } from "./resultIndex.js";
import { blockDependenciesCompleted, getBlock, openFeedbackForReview } from "./selectors.js";

/**
 * Shared currentReview resume claim side effects for local claimNext and remote claim.
 * Clears pendingFeedbackId, binds currentRefs / currentReviewBlockRef, and optionally
 * clears a resolved currentFeedbackId pointer.
 */
export function applyCurrentReviewResumeClaim(
  state: RuntimeState,
  ref: string,
  options: { clearCurrentFeedback: boolean }
): void {
  const blockState = state.blocks[ref];
  if (!blockState) {
    throw new Error(`Block '${ref}' does not exist in runtime state.`);
  }
  state.blocks[ref] = {
    ...blockState,
    pendingFeedbackId: null
  };
  state.currentRefs = state.currentRefs.includes(ref)
    ? state.currentRefs
    : [...state.currentRefs, ref];
  if (options.clearCurrentFeedback) {
    state.currentFeedbackId = null;
  }
  state.currentReviewBlockRef = ref;
}

async function withLockedRuntime<T>(
  options: { projectRoot: PackageWorkspaceRef; session?: ExecutionGraphSession },
  fn: (context: Awaited<ReturnType<typeof loadRuntime>>) => Promise<T>
): Promise<T> {
  const { workspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(workspace.stateFile), async () => fn(await loadRuntime(options)));
}

export async function markBlockBlocked(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  reason: string;
  session?: ExecutionGraphSession;
}) {
  return withLockedRuntime(options, async (context) => {
    const { workspace, manifest, graph } = context;
    const block = getBlock(graph, options.ref);
    if (!options.reason.trim()) {
      throw new Error("mark-blocked requires a non-empty reason.");
    }
    context.state.blocks[options.ref] = {
      ...withoutRemoteBlockOwnership(context.state.blocks[options.ref], "blocked"),
      blockedReason: options.reason.trim()
    };
    if (block.type === "review" && openFeedbackForReview(context.state, options.ref)) {
      throw new Error("Cannot mark a review block blocked while it has open feedback.");
    }
    context.state.currentRefs = context.state.currentRefs.filter((ref) => ref !== options.ref);
    await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
    return { ref: options.ref, status: "blocked" as BlockStatus, reason: options.reason.trim() };
  });
}

export async function markBlockDiverged(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  reason: string;
  session?: ExecutionGraphSession;
}) {
  return withLockedRuntime(options, async (context) => {
    const { workspace, manifest, graph } = context;
    const block = getBlock(graph, options.ref);
    if (!options.reason.trim()) {
      throw new Error("mark-diverged requires a non-empty reason.");
    }
    const taskId = graph.blockTaskByRef.get(options.ref);
    const current = context.state.blocks[options.ref];
    context.state.blocks[options.ref] = {
      ...(current.remoteOwnership
        ? { ...current, remoteInterruption: undefined, remoteOperationReceipt: undefined }
        : clearRemoteBlockOperationState(current)),
      status: "diverged",
      divergenceReason: options.reason.trim(),
      ...(block.type === "review"
        ? {
            activeFeedbackId: null,
            pendingFeedbackId: null,
            completionReason: null,
            passedWorkRevision: null
          }
        : {})
    };
    if (block.type === "review" && taskId) {
      await clearReviewCompletionReason(workspace, taskId, options.ref);
    }
    context.state.currentRefs = context.state.currentRefs.filter((ref) => ref !== options.ref);
    await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
    return { ref: options.ref, status: "diverged" as BlockStatus, reason: options.reason.trim() };
  });
}

export async function unblockBlock(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  reason: string;
  allowAlreadyCompleted?: boolean;
  session?: ExecutionGraphSession;
}) {
  return withLockedRuntime(options, async (context) => {
    const { workspace, manifest, graph } = context;
    getBlock(graph, options.ref);
    if (!options.reason.trim()) {
      throw new Error("unblock requires a non-empty reason.");
    }
    const current = context.state.blocks[options.ref];
    if (current?.status !== "blocked") {
      if (options.allowAlreadyCompleted && current?.status === "completed") {
        return {
          ref: options.ref,
          status: current.status,
          reason: options.reason.trim()
        };
      }
      throw new Error(`Block '${options.ref}' is not blocked.`);
    }
    const nextStatus = blockDependenciesCompleted(graph, context.state, options.ref)
      ? "ready"
      : "planned";
    context.state.blocks[options.ref] = {
      ...withoutRemoteBlockOwnership(current, nextStatus),
      blockedReason: null
    };
    await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
    return {
      ref: options.ref,
      status: context.state.blocks[options.ref].status,
      reason: options.reason.trim()
    };
  });
}

/** Return an unstarted parallel-batch sibling from in_progress to a claimable status. */
export async function releaseInProgressBlock(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
}) {
  return withLockedRuntime(options, async (context) => {
    const { workspace, manifest, graph } = context;
    getBlock(graph, options.ref);
    const current = context.state.blocks[options.ref];
    if (current?.status !== "in_progress") {
      throw new Error(`Block '${options.ref}' is not in_progress.`);
    }
    if (current.remoteOwnership) {
      throw new Error(
        `Remote-owned block '${options.ref}' cannot be released without its operation identity.`
      );
    }
    const nextStatus = blockDependenciesCompleted(graph, context.state, options.ref)
      ? "ready"
      : "planned";
    context.state.blocks[options.ref] = {
      ...withoutRemoteBlockOwnership(current, nextStatus),
      blockedReason: null
    };
    context.state.currentRefs = context.state.currentRefs.filter((ref) => ref !== options.ref);
    await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
    return { ref: options.ref, status: context.state.blocks[options.ref].status };
  });
}

export async function resolveBlockDivergence(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  reason: string;
  session?: ExecutionGraphSession;
}) {
  return withLockedRuntime(options, async (context) => {
    const { workspace, manifest, graph } = context;
    const block = getBlock(graph, options.ref);
    const current = context.state.blocks[options.ref];
    if (current?.status !== "diverged") {
      throw new Error(`Block '${options.ref}' is not diverged.`);
    }
    if (!options.reason.trim()) {
      throw new Error("resolve-divergence requires a non-empty reason.");
    }
    const taskId = graph.blockTaskByRef.get(options.ref);
    context.state.blocks[options.ref] = {
      ...withoutRemoteBlockOwnership(
        current,
        blockDependenciesCompleted(graph, context.state, options.ref) ? "ready" : "planned"
      ),
      divergenceReason: null,
      ...(block.type === "review"
        ? {
            activeFeedbackId: null,
            pendingFeedbackId: null,
            completionReason: null,
            passedWorkRevision: null
          }
        : {})
    };
    if (block.type === "review" && taskId) {
      await clearReviewCompletionReason(workspace, taskId, options.ref);
    }
    await writeState(workspace.stateFile, refreshDerivedState(manifest, context.state));
    return {
      ref: options.ref,
      status: context.state.blocks[options.ref].status,
      reason: options.reason.trim()
    };
  });
}

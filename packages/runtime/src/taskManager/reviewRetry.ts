import { dirname } from "node:path";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  ClaimScope,
  ManifestReviewBlock,
  PackageWorkspaceRef,
  PlanPackageManifest,
  RetryReviewResult
} from "../types.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { clearReviewCompletionReason } from "./resultIndex.js";
import { blockDependenciesCompleted, blockInScope } from "./selectors.js";

export async function resetMaxCycleReviewsForRetry(options: {
  projectRoot: PackageWorkspaceRef;
  scope: ClaimScope;
}): Promise<{ refs: string[] }> {
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(lockWorkspace.stateFile), async () => {
    const context = await loadRuntime({ projectRoot: options.projectRoot });
    const { workspace, manifest, graph, state } = context;
    const refs: string[] = [];

    for (const ref of graph.blockRefsInManifestOrder) {
      const block = graph.blocksByRef.get(ref);
      const blockState = state.blocks[ref];
      if (
        block?.type !== "review" ||
        blockState?.completionReason !== "max_cycles_reached" ||
        !blockInScope(ref, graph, options.scope)
      ) {
        continue;
      }
      refs.push(ref);
      const taskId = graph.blockTaskByRef.get(ref);
      state.blocks[ref] = {
        ...blockState,
        status: blockDependenciesCompleted(graph, state, ref) ? "ready" : "planned",
        activeFeedbackId: null,
        pendingFeedbackId: null,
        blockedReason: null,
        completionReason: null,
        passedWorkRevision: null
      };
      if (taskId) {
        await clearReviewCompletionReason(workspace, taskId, ref);
      }
    }

    if (refs.length > 0) {
      const resetRefs = new Set(refs);
      for (const [feedbackId, feedback] of Object.entries(state.feedback)) {
        if (resetRefs.has(feedback.sourceReviewBlockRef)) {
          delete state.feedback[feedbackId];
        }
      }
      if (state.currentFeedbackId && !state.feedback[state.currentFeedbackId]) {
        state.currentFeedbackId = null;
      }
      if (state.currentReviewBlockRef && resetRefs.has(state.currentReviewBlockRef)) {
        state.currentReviewBlockRef = null;
      }
      state.currentRefs = state.currentRefs.filter((ref) => !resetRefs.has(ref));
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    }

    return { refs };
  });
}

function requireMaxFeedbackCycles(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("retry-review --max-feedback-cycles must be a non-negative integer.");
  }
  return value;
}

function updateReviewBlockMaxCycles(
  manifest: PlanPackageManifest,
  ref: string,
  maxFeedbackCycles: number
): PlanPackageManifest {
  const [taskId, blockId] = ref.split("#");
  let found = false;
  const nodes = manifest.nodes.map((node) => {
    if (node.type !== "task" || node.id !== taskId) {
      return node;
    }
    return {
      ...node,
      blocks: node.blocks.map((block) => {
        if (block.id !== blockId) {
          return block;
        }
        if (block.type !== "review") {
          throw new Error(`Block '${ref}' is not a review block.`);
        }
        found = true;
        return {
          ...block,
          review: {
            ...block.review,
            maxFeedbackCycles
          }
        } satisfies ManifestReviewBlock;
      })
    };
  });
  if (!found) {
    throw new Error(`Review block '${ref}' does not exist.`);
  }
  return { ...manifest, nodes };
}

export async function retryReview(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  maxFeedbackCycles: number;
}): Promise<RetryReviewResult> {
  const maxFeedbackCycles = requireMaxFeedbackCycles(options.maxFeedbackCycles);
  const context = await loadRuntime({ projectRoot: options.projectRoot });
  const { workspace, manifest, graph } = context;
  const block = graph.blocksByRef.get(options.ref);
  if (!block) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  if (block.type !== "review") {
    throw new Error(`Block '${options.ref}' is not a review block.`);
  }

  await writeJsonFile(
    workspace.manifestFile,
    updateReviewBlockMaxCycles(manifest, options.ref, maxFeedbackCycles)
  );
  const reset = await resetMaxCycleReviewsForRetry({
    projectRoot: workspace,
    scope: { kind: "block", blockRef: options.ref }
  });
  const updated = await loadRuntime({ projectRoot: workspace });
  const status = updated.state.blocks[options.ref]?.status ?? "planned";
  return {
    ref: options.ref,
    status,
    maxFeedbackCycles,
    reset: reset.refs.includes(options.ref)
  };
}

import { writeState } from "../state.js";
import type { ClaimScope, PackageWorkspaceRef } from "../types.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { blockDependenciesCompleted, blockInScope } from "./selectors.js";

export async function resetMaxCycleReviewsForRetry(options: {
  projectRoot: PackageWorkspaceRef;
  scope: ClaimScope;
}): Promise<{ refs: string[] }> {
  const context = await loadRuntime({ projectRoot: options.projectRoot });
  const { workspace, manifest, graph, state } = context;
  const refs: string[] = [];

  for (const ref of graph.blockRefsInManifestOrder) {
    const block = graph.blocksByRef.get(ref);
    const blockState = state.blocks[ref];
    if (block?.type !== "review" || blockState?.completionReason !== "max_cycles_reached" || !blockInScope(ref, graph, options.scope)) {
      continue;
    }
    refs.push(ref);
    state.blocks[ref] = {
      ...blockState,
      status: blockDependenciesCompleted(graph, state, ref) ? "ready" : "planned",
      activeFeedbackId: null,
      blockedReason: null,
      completionReason: null
    };
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
}

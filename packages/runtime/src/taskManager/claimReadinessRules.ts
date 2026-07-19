import { requireMapValue } from "../graph/requireMapValue.js";
import type {
  BlockType,
  ClaimScope,
  CompiledExecutionGraph,
  RuntimeState,
  ValidationIssue
} from "../types.js";
import type { ProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import {
  blockDependenciesCompleted,
  blockInScope,
  canClaimReviewBlock,
  getBlock,
  isActiveFeedbackStatus,
  requireBlockState,
  taskDependenciesSatisfied
} from "./selectors.js";

export const noProjectGraphBlockers: ProjectGraphClaimGuard = {
  blockersForTask: () => [],
  blockerReasonForTask: () => null
};

export function projectBlockerReason(
  projectGuard: ProjectGraphClaimGuard,
  taskId: string | undefined
): string | null {
  return taskId ? projectGuard.blockerReasonForTask(taskId) : null;
}

export function projectBlockers(
  projectGuard: ProjectGraphClaimGuard,
  taskId: string | undefined
): string[] {
  return taskId ? projectGuard.blockersForTask(taskId) : [];
}

export function currentClaimBlockedReason(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): string | null {
  const activeFeedback = Object.entries(state.feedback).find(([, feedback]) =>
    isActiveFeedbackStatus(feedback.status)
  );
  if (activeFeedback) {
    return `Default claims are blocked by current feedback '${activeFeedback[0]}'.`;
  }
  const inProgressReview = graph.blockRefsInManifestOrder.find((ref) => {
    const block = getBlock(graph, ref);
    return block.type === "review" && requireBlockState(state, ref).status === "in_progress";
  });
  if (inProgressReview) {
    return `Default claims are blocked by current review block '${inProgressReview}'.`;
  }
  const inProgressBlock = graph.blockRefsInManifestOrder.find((ref) => {
    const block = getBlock(graph, ref);
    return block.type !== "review" && requireBlockState(state, ref).status === "in_progress";
  });
  return inProgressBlock
    ? `Default claims are blocked by current block '${inProgressBlock}'.`
    : null;
}

export function blockMatchesClaimFilter(
  ref: string,
  graph: CompiledExecutionGraph,
  scope: ClaimScope,
  blockType: BlockType | undefined
): boolean {
  // Callers walk manifest-order refs; missing graph entity is invariant, not filter miss.
  const block = getBlock(graph, ref);
  return blockInScope(ref, graph, scope) && (!blockType || block.type === blockType);
}

export function blockReadyWithoutProjectBlockers(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  ref: string
): boolean {
  // Manifest-order / known package refs: missing graph or state is internal corruption.
  const taskId = requireMapValue(graph.blockTaskByRef, ref, "blockTaskByRef");
  const block = getBlock(graph, ref);
  if (
    requireBlockState(state, ref).status !== "ready" ||
    !taskDependenciesSatisfied(graph, state, taskId)
  ) {
    return false;
  }
  return block.type === "review"
    ? canClaimReviewBlock(graph, state, ref)
    : blockDependenciesCompleted(graph, state, ref);
}

export function reviewMaxCycleWarnings(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): ValidationIssue[] {
  return graph.blockRefsInManifestOrder
    .filter((ref) => requireBlockState(state, ref).completionReason === "max_cycles_reached")
    .map((ref) => ({
      code: "review_max_cycles_reached",
      message: `Review block '${ref}' reached max feedback cycles without passing.`,
      path: ref
    }));
}

import { createHash } from "node:crypto";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import type {
  ClaimResult,
  ClaimScope,
  CompiledExecutionGraph,
  FeedbackEnvelopeState,
  FeedbackStatus,
  ManifestBlock,
  ManifestTaskNode,
  RuntimeState
} from "../types.js";

export function getTask(graph: CompiledExecutionGraph, taskId: string): ManifestTaskNode {
  const task = graph.tasksById.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  return task;
}

export function getBlock(graph: CompiledExecutionGraph, ref: string): ManifestBlock {
  const block = graph.blocksByRef.get(ref);
  if (!block) {
    throw new Error(`Block '${ref}' does not exist.`);
  }
  return block;
}

export function taskDependenciesSatisfied(graph: CompiledExecutionGraph, state: RuntimeState, taskId: string): boolean {
  return (graph.taskDependenciesByTask.get(taskId) ?? []).every((dependency) => state.tasks[dependency]?.status === "implemented");
}

export function blockDependenciesCompleted(graph: CompiledExecutionGraph, state: RuntimeState, ref: string): boolean {
  return (graph.blockDependenciesByRef.get(ref) ?? []).every((dependency) => state.blocks[dependency]?.status === "completed");
}

export function isActiveFeedbackStatus(status: FeedbackStatus | undefined): boolean {
  return status === "open" || status === "in_progress";
}

export function activeOpenFeedback(state: RuntimeState): Array<[string, FeedbackEnvelopeState]> {
  return Object.entries(state.feedback).filter(([, feedback]) => isActiveFeedbackStatus(feedback.status));
}

export function claimResultForBlock(ref: string, graph: CompiledExecutionGraph, reason: "claimed" | "current" | "feedback_resolved"): ClaimResult {
  const { taskId, blockId } = parseBlockRef(ref);
  const block = getBlock(graph, ref);
  return {
    kind: "block",
    ref,
    taskId,
    blockId,
    blockType: block.type,
    reason
  };
}

export function normalizeClaimScope(scope?: ClaimScope): ClaimScope {
  return scope ?? { kind: "project" };
}

export function validateClaimScope(scope: ClaimScope, graph: CompiledExecutionGraph): ClaimResult | null {
  if (scope.kind === "task" && !graph.tasksById.has(scope.taskId)) {
    return { kind: "blocked", reason: `Task '${scope.taskId}' does not exist.` };
  }
  if (scope.kind === "block" && !graph.blocksByRef.has(scope.blockRef)) {
    return { kind: "blocked", reason: `Block '${scope.blockRef}' does not exist.` };
  }
  return null;
}

export function blockInScope(ref: string, graph: CompiledExecutionGraph, scope: ClaimScope): boolean {
  if (scope.kind === "project") {
    return true;
  }
  if (scope.kind === "block") {
    return ref === scope.blockRef;
  }
  return graph.blockTaskByRef.get(ref) === scope.taskId;
}

export function feedbackInScope(feedback: FeedbackEnvelopeState, graph: CompiledExecutionGraph, scope: ClaimScope): boolean {
  return blockInScope(feedback.sourceReviewBlockRef, graph, scope);
}

export function requiredImplementationRefs(graph: CompiledExecutionGraph, taskId: string): string[] {
  return (graph.blocksByTask.get(taskId) ?? []).filter((ref) => {
    const block = graph.blocksByRef.get(ref);
    return block?.type === "implementation";
  });
}

export function requiredReviewRefs(graph: CompiledExecutionGraph, taskId: string): string[] {
  return (graph.blocksByTask.get(taskId) ?? []).filter((ref) => {
    const block = graph.blocksByRef.get(ref);
    return block?.type === "review" && block.review.required;
  });
}

export function computeWorkRevision(graph: CompiledExecutionGraph, state: RuntimeState, reviewBlockRef: string): string {
  const taskId = graph.blockTaskByRef.get(reviewBlockRef);
  if (!taskId) {
    throw new Error(`Review block '${reviewBlockRef}' does not belong to a task.`);
  }
  const material = {
    runs: requiredImplementationRefs(graph, taskId).map((ref) => [ref, state.blocks[ref]?.lastRunId ?? null]),
    feedback: Object.entries(state.feedback)
      .filter(([, feedback]) => feedback.sourceReviewBlockRef === reviewBlockRef)
      .map(([feedbackId, feedback]) => [feedbackId, feedback.latestSubmissionId])
  };
  return `rev-${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12)}`;
}

export function canClaimReviewBlock(graph: CompiledExecutionGraph, state: RuntimeState, ref: string): boolean {
  const block = graph.blocksByRef.get(ref);
  if (block?.type !== "review" || !block.review.required) {
    return false;
  }
  const taskId = graph.blockTaskByRef.get(ref);
  if (!taskId) {
    return false;
  }
  if (activeOpenFeedback(state).some(([, feedback]) => graph.blockTaskByRef.get(feedback.sourceReviewBlockRef) === taskId)) {
    return false;
  }
  if (!requiredImplementationRefs(graph, taskId).every((blockRef) => state.blocks[blockRef]?.status === "completed")) {
    return false;
  }
  const workRevision = computeWorkRevision(graph, state, ref);
  return state.blocks[ref]?.passedWorkRevision !== workRevision;
}

export function markClaimed(state: RuntimeState, ref: string, graph: CompiledExecutionGraph): void {
  state.blocks[ref] = { ...state.blocks[ref], status: "in_progress" };
  state.currentRefs = [ref];
  const block = getBlock(graph, ref);
  if (block.type === "review") {
    state.currentReviewBlockRef = ref;
  }
}

export function openFeedbackForReview(state: RuntimeState, reviewBlockRef: string): [string, FeedbackEnvelopeState] | null {
  return (
    Object.entries(state.feedback).find(
      ([, feedback]) => feedback.sourceReviewBlockRef === reviewBlockRef && (feedback.status === "open" || feedback.status === "in_progress")
    ) ?? null
  );
}

import { createHash } from "node:crypto";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { requireMapValue } from "../graph/requireMapValue.js";
import type {
  BlockState,
  ClaimResult,
  ClaimScope,
  CompiledExecutionGraph,
  FeedbackEnvelopeState,
  FeedbackStatus,
  ManifestBlock,
  ManifestTaskNode,
  RuntimeState,
  TaskState
} from "../types.js";

/**
 * Trusted task-manager access after `loadRuntime` / `loadRuntimeReadonly`
 * (graph compile + `ensureStateForManifest` reconciliation).
 *
 * Use:
 * - `getTask` / `getBlock` for graph entities when the id/ref is required for the op
 *   (user-supplied or already validated). Missing entity → public "does not exist".
 * - `requireMapValue` for compiled graph **index** keys guaranteed by T-002 init.
 * - `requireTaskState` / `requireBlockState` for `state.tasks` / `state.blocks` when
 *   the key is a manifest-order / graph-index member (guaranteed after reconcile).
 *
 * Do not use required accessors for public probes, orphan inspection, or optional
 * historical fields (`lastRunId`, `latestReviewAttemptId`, etc.).
 */

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

/**
 * Require task runtime state that reconciliation guarantees for graph tasks.
 * Missing entry means corrupt in-memory RuntimeState, not a normal planned task.
 */
export function requireTaskState(state: RuntimeState, taskId: string): TaskState {
  const taskState = state.tasks[taskId];
  if (taskState === undefined) {
    throw new Error(
      `Internal runtime invariant violated: missing task state for '${taskId}' after load/reconcile.`
    );
  }
  return taskState;
}

/**
 * Require block runtime state that reconciliation guarantees for graph block refs.
 * Missing entry means corrupt in-memory RuntimeState, not a normal planned block.
 */
export function requireBlockState(state: RuntimeState, ref: string): BlockState {
  const blockState = state.blocks[ref];
  if (blockState === undefined) {
    throw new Error(
      `Internal runtime invariant violated: missing block state for '${ref}' after load/reconcile.`
    );
  }
  return blockState;
}

export function taskDependenciesSatisfied(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  taskId: string
): boolean {
  return requireMapValue(graph.taskDependenciesByTask, taskId, "taskDependenciesByTask").every(
    (dependency) => requireTaskState(state, dependency).status === "implemented"
  );
}

export function blockDependenciesCompleted(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  ref: string
): boolean {
  return requireMapValue(graph.blockDependenciesByRef, ref, "blockDependenciesByRef").every(
    (dependency) => requireBlockState(state, dependency).status === "completed"
  );
}

export function isActiveFeedbackStatus(status: FeedbackStatus | undefined): boolean {
  return status === "open" || status === "in_progress";
}

export function activeOpenFeedback(state: RuntimeState): Array<[string, FeedbackEnvelopeState]> {
  return Object.entries(state.feedback).filter(([, feedback]) =>
    isActiveFeedbackStatus(feedback.status)
  );
}

export function claimResultForBlock(
  ref: string,
  graph: CompiledExecutionGraph,
  reason: "claimed" | "current" | "feedback_resolved" | "dispatched",
  defaultExecutor?: string
): ClaimResult {
  const { taskId, blockId } = parseBlockRef(ref);
  const block = getBlock(graph, ref);
  return {
    kind: "block",
    ref,
    taskId,
    blockId,
    blockType: block.type,
    effectiveExecutor: effectiveBlockExecutor(graph, ref, defaultExecutor),
    reason
  };
}

export function effectiveBlockExecutor(
  graph: CompiledExecutionGraph,
  ref: string,
  defaultExecutor?: string
): string {
  const block = getBlock(graph, ref);
  const taskId = requireMapValue(graph.blockTaskByRef, ref, "blockTaskByRef");
  const task = requireMapValue(graph.tasksById, taskId, "tasksById");
  return block.executor ?? task.executor ?? defaultExecutor ?? "default";
}

export function effectiveFeedbackExecutor(
  graph: CompiledExecutionGraph,
  sourceReviewBlockRef: string,
  defaultExecutor?: string
): string {
  const taskId = graph.blockTaskByRef.get(sourceReviewBlockRef);
  if (!taskId) {
    return effectiveBlockExecutor(graph, sourceReviewBlockRef, defaultExecutor);
  }
  const implementationExecutors = [
    ...new Set(
      requiredImplementationRefs(graph, taskId).map((ref) =>
        effectiveBlockExecutor(graph, ref, defaultExecutor)
      )
    )
  ];
  if (implementationExecutors.length === 1) {
    return implementationExecutors[0];
  }
  return effectiveBlockExecutor(graph, sourceReviewBlockRef, defaultExecutor);
}

export function normalizeClaimScope(scope?: ClaimScope): ClaimScope {
  return scope ?? { kind: "project" };
}

export function validateClaimScope(
  scope: ClaimScope,
  graph: CompiledExecutionGraph
): ClaimResult | null {
  if (scope.kind === "task" && !graph.tasksById.has(scope.taskId)) {
    return { kind: "blocked", reason: `Task '${scope.taskId}' does not exist.` };
  }
  if (scope.kind === "block" && !graph.blocksByRef.has(scope.blockRef)) {
    return { kind: "blocked", reason: `Block '${scope.blockRef}' does not exist.` };
  }
  return null;
}

export function blockInScope(
  ref: string,
  graph: CompiledExecutionGraph,
  scope: ClaimScope
): boolean {
  if (scope.kind === "project") {
    return true;
  }
  if (scope.kind === "block") {
    return ref === scope.blockRef;
  }
  return graph.blockTaskByRef.get(ref) === scope.taskId;
}

export function feedbackInScope(
  feedback: FeedbackEnvelopeState,
  graph: CompiledExecutionGraph,
  scope: ClaimScope
): boolean {
  return blockInScope(feedback.sourceReviewBlockRef, graph, scope);
}

export function requiredImplementationRefs(
  graph: CompiledExecutionGraph,
  taskId: string
): string[] {
  return requireMapValue(graph.blocksByTask, taskId, "blocksByTask").filter((ref) => {
    const block = requireMapValue(graph.blocksByRef, ref, "blocksByRef");
    return block.type === "implementation";
  });
}

export function requiredReviewRefs(graph: CompiledExecutionGraph, taskId: string): string[] {
  return requireMapValue(graph.blocksByTask, taskId, "blocksByTask").filter((ref) => {
    const block = requireMapValue(graph.blocksByRef, ref, "blocksByRef");
    return block.type === "review" && block.review.required;
  });
}

export function computeWorkRevision(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  reviewBlockRef: string
): string {
  const taskId = requireMapValue(graph.blockTaskByRef, reviewBlockRef, "blockTaskByRef");
  const material = {
    runs: requiredImplementationRefs(graph, taskId).map((ref) => [
      ref,
      requireBlockState(state, ref).lastRunId ?? null
    ]),
    feedback: Object.entries(state.feedback)
      .filter(([, feedback]) => feedback.sourceReviewBlockRef === reviewBlockRef)
      .map(([feedbackId, feedback]) => [feedbackId, feedback.latestSubmissionId])
  };
  return `rev-${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12)}`;
}

export function canClaimReviewBlock(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  ref: string
): boolean {
  // Public probe: free-form / external candidates may not exist in the graph.
  const block = graph.blocksByRef.get(ref);
  if (block?.type !== "review" || !block.review.required) {
    return false;
  }
  const taskId = graph.blockTaskByRef.get(ref);
  if (!taskId) {
    return false;
  }
  if (
    activeOpenFeedback(state).some(
      ([, feedback]) => graph.blockTaskByRef.get(feedback.sourceReviewBlockRef) === taskId
    )
  ) {
    return false;
  }
  if (
    !requiredImplementationRefs(graph, taskId).every(
      (blockRef) => requireBlockState(state, blockRef).status === "completed"
    )
  ) {
    return false;
  }
  const workRevision = computeWorkRevision(graph, state, ref);
  return requireBlockState(state, ref).passedWorkRevision !== workRevision;
}

export function refsConflict(
  graph: CompiledExecutionGraph,
  leftRef: string,
  rightRef: string
): boolean {
  if (leftRef === rightRef) {
    return false;
  }
  const leftTaskId = graph.blockTaskByRef.get(leftRef);
  const rightTaskId = graph.blockTaskByRef.get(rightRef);
  if (!leftTaskId || !rightTaskId) {
    return true;
  }
  if (
    leftTaskId === rightTaskId ||
    graph.taskReachable(leftTaskId, rightTaskId) ||
    graph.taskReachable(rightTaskId, leftTaskId)
  ) {
    return true;
  }
  return false;
}

export function inProgressImplementationRefs(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): string[] {
  // currentRefs are reconciled to package block refs after load.
  return state.currentRefs.filter((ref) => {
    if (requireBlockState(state, ref).status !== "in_progress") {
      return false;
    }
    return getBlock(graph, ref).type === "implementation";
  });
}

export function canDispatchImplementationBlock(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  ref: string,
  options: {
    maxConcurrent: number;
    selectedRefs?: readonly string[];
  }
): boolean {
  // Public probe: free-form / external candidates may not exist in the graph.
  const taskId = graph.blockTaskByRef.get(ref);
  const block = graph.blocksByRef.get(ref);
  if (!taskId || block?.type !== "implementation") {
    return false;
  }
  if (requireBlockState(state, ref).status !== "ready") {
    return false;
  }
  if (
    !taskDependenciesSatisfied(graph, state, taskId) ||
    !blockDependenciesCompleted(graph, state, ref)
  ) {
    return false;
  }
  const selectedRefs = options.selectedRefs ?? [];
  const runningRefs = inProgressImplementationRefs(graph, state);
  if (runningRefs.length + selectedRefs.length >= options.maxConcurrent) {
    return false;
  }
  const conflictsWithCurrent = state.currentRefs.some(
    (currentRef) =>
      requireBlockState(state, currentRef).status === "in_progress" &&
      refsConflict(graph, ref, currentRef)
  );
  const conflictsWithSelected = selectedRefs.some((selectedRef) =>
    refsConflict(graph, ref, selectedRef)
  );
  return !conflictsWithCurrent && !conflictsWithSelected;
}

export function markClaimed(state: RuntimeState, ref: string, graph: CompiledExecutionGraph): void {
  const blockState = requireBlockState(state, ref);
  state.blocks[ref] = { ...blockState, status: "in_progress" };
  state.currentRefs = [ref];
  const block = getBlock(graph, ref);
  if (block.type === "review") {
    state.currentReviewBlockRef = ref;
  }
}

export function openFeedbackForReview(
  state: RuntimeState,
  reviewBlockRef: string
): [string, FeedbackEnvelopeState] | null {
  return (
    Object.entries(state.feedback).find(
      ([, feedback]) =>
        feedback.sourceReviewBlockRef === reviewBlockRef &&
        (feedback.status === "open" || feedback.status === "in_progress")
    ) ?? null
  );
}

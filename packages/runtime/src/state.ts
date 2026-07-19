import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { optionalStat } from "./fs/optionalFile.js";
import { compileTaskGraph } from "./graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "./json.js";
import { runtimeStateSchema } from "./schema/runtimeState.js";
import type {
  BlockState,
  BlockStatus,
  CompiledExecutionGraph,
  PlanPackageManifest,
  RuntimeState,
  TaskState
} from "./types.js";

export function createEmptyState(): RuntimeState {
  return {
    currentRefs: [],
    currentFeedbackId: null,
    currentReviewBlockRef: null,
    tasks: {},
    blocks: {},
    feedback: {}
  };
}

export async function readState(stateFile: string): Promise<RuntimeState> {
  if (!(await optionalStat(stateFile))) {
    return createEmptyState();
  }
  const raw = await readJsonFile<unknown>(stateFile);
  const parsed = runtimeStateSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Runtime state at ${stateFile} is invalid: ${details}. Run \`planweave doctor\` to inspect, or restore the file.`
    );
  }
  return parsed.data;
}

export async function writeState(stateFile: string, state: RuntimeState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeJsonFile(stateFile, state);
}

function defaultBlockStatus(
  ref: string,
  graph: CompiledExecutionGraph,
  state: RuntimeState
): BlockStatus {
  const taskId = graph.blockTaskByRef.get(ref);
  if (!taskId || !taskDependenciesSatisfied(taskId, graph, state)) {
    return "planned";
  }
  const dependencies = graph.blockDependenciesByRef.get(ref) ?? [];
  return dependencies.every((dependency) => state.blocks[dependency]?.status === "completed")
    ? "ready"
    : "planned";
}

function taskDependenciesSatisfied(
  taskId: string,
  graph: CompiledExecutionGraph,
  state: RuntimeState
): boolean {
  return (graph.taskDependenciesByTask.get(taskId) ?? []).every(
    (dependency) => state.tasks[dependency]?.status === "implemented"
  );
}

function hasOpenFeedbackForTask(
  taskId: string,
  graph: CompiledExecutionGraph,
  state: RuntimeState
): boolean {
  return Object.values(state.feedback).some((feedback) => {
    if (feedback.status !== "open" && feedback.status !== "in_progress") {
      return false;
    }
    const sourceTask = graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
    return sourceTask === taskId;
  });
}

function hasStartedBlock(block: BlockState | undefined): boolean {
  return Boolean(block && block.status !== "planned" && block.status !== "ready");
}

function aggregateTaskStatus(
  taskId: string,
  graph: CompiledExecutionGraph,
  state: RuntimeState
): TaskState {
  const refs = graph.blocksByTask.get(taskId) ?? [];
  const blocks = refs.map((ref) => state.blocks[ref]).filter(Boolean);
  const openFeedbackCount = Object.values(state.feedback).filter((feedback) => {
    const sourceTask = graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
    return (
      sourceTask === taskId && (feedback.status === "open" || feedback.status === "in_progress")
    );
  }).length;

  if (!taskDependenciesSatisfied(taskId, graph, state)) {
    return { status: "planned", openFeedbackCount };
  }
  if (blocks.some((block) => block.status === "in_progress") || openFeedbackCount > 0) {
    return { status: "in_progress", openFeedbackCount };
  }
  const requiredNonReviewComplete = refs
    .filter((ref) => {
      const block = graph.blocksByRef.get(ref);
      return block?.type === "implementation";
    })
    .every((ref) => state.blocks[ref]?.status === "completed");
  const requiredReviewsPassed = refs
    .filter((ref) => graph.blocksByRef.get(ref)?.type === "review")
    .every((ref) => {
      const block = graph.blocksByRef.get(ref);
      return (
        block?.type !== "review" ||
        !block.review.required ||
        state.blocks[ref]?.completionReason === "passed"
      );
    });
  if (requiredNonReviewComplete && requiredReviewsPassed) {
    return { status: "implemented", openFeedbackCount };
  }
  return {
    status: refs.some((ref) => hasStartedBlock(state.blocks[ref])) ? "in_progress" : "ready",
    openFeedbackCount
  };
}

/**
 * Reconcile a schema-validated RuntimeState to the current package graph.
 *
 * Callers must pass trusted state only (`readState` output or `createEmptyState()`).
 * This function does not re-validate JSON shapes; it only repairs manifest drift:
 * - prune current/review/feedback refs that left the package
 * - drop block/task records not in the manifest (by rebuilding from the graph)
 * - seed missing blocks and re-derive planned/ready status and task aggregates
 */
export function ensureStateForManifest(
  manifest: PlanPackageManifest,
  state: RuntimeState
): RuntimeState {
  const graph = compileTaskGraph(manifest);
  const validBlockRefs = new Set(graph.blockRefsInManifestOrder);

  // Manifest-drift: drop current refs that no longer exist in the package graph.
  const currentRefs = state.currentRefs.filter((ref) => validBlockRefs.has(ref));

  // Manifest-drift: keep only feedback whose source review block still exists.
  const feedback: RuntimeState["feedback"] = {};
  for (const [feedbackId, feedbackState] of Object.entries(state.feedback)) {
    if (validBlockRefs.has(feedbackState.sourceReviewBlockRef)) {
      feedback[feedbackId] = feedbackState;
    }
  }

  const currentFeedback =
    state.currentFeedbackId !== null ? feedback[state.currentFeedbackId] : undefined;
  // Drop pointer when the feedback envelope was pruned or is no longer active work.
  const currentFeedbackId =
    state.currentFeedbackId !== null &&
    currentFeedback !== undefined &&
    (currentFeedback.status === "open" || currentFeedback.status === "in_progress")
      ? state.currentFeedbackId
      : null;

  // Manifest-drift: drop review pointer when the review block left the package.
  const currentReviewBlockRef =
    state.currentReviewBlockRef !== null && validBlockRefs.has(state.currentReviewBlockRef)
      ? state.currentReviewBlockRef
      : null;

  const next: RuntimeState = {
    currentRefs,
    currentFeedbackId,
    currentReviewBlockRef,
    tasks: {},
    blocks: {},
    feedback
  };

  for (const ref of graph.blockRefsInManifestOrder) {
    // Missing key = block newly added to the manifest (seed defaults).
    const existing = state.blocks[ref];
    next.blocks[ref] = existing ?? {
      status: defaultBlockStatus(ref, graph, next),
      lastRunId: null
    };
    if (next.blocks[ref].status === "planned" || next.blocks[ref].status === "ready") {
      next.blocks[ref] = {
        ...next.blocks[ref],
        status: defaultBlockStatus(ref, graph, next)
      };
    }
  }

  for (const taskId of graph.taskNodesInManifestOrder) {
    next.tasks[taskId] = aggregateTaskStatus(taskId, graph, next);
  }

  // Promote planned→ready to a fixed point. A single pass is wrong when a task appears
  // earlier in manifest order than its depends_on targets: those targets are still
  // "planned" mid-pass, so the dependent is skipped and never revisited.
  const maxPromotePasses = graph.taskNodesInManifestOrder.length + 1;
  for (let pass = 0; pass < maxPromotePasses; pass += 1) {
    let changed = false;
    for (const taskId of graph.taskNodesInManifestOrder) {
      if (!taskDependenciesSatisfied(taskId, graph, next)) {
        continue;
      }
      for (const ref of graph.blocksByTask.get(taskId) ?? []) {
        const block = graph.blocksByRef.get(ref);
        const blockState = next.blocks[ref];
        if (!block || blockState.status !== "planned") {
          continue;
        }
        if (
          (graph.blockDependenciesByRef.get(ref) ?? []).every(
            (dependency) => next.blocks[dependency]?.status === "completed"
          )
        ) {
          if (block.type === "review" && hasOpenFeedbackForTask(taskId, graph, next)) {
            continue;
          }
          next.blocks[ref] = { ...blockState, status: "ready" };
          changed = true;
        }
      }
      const previousTaskStatus = next.tasks[taskId]?.status;
      next.tasks[taskId] = aggregateTaskStatus(taskId, graph, next);
      if (previousTaskStatus !== next.tasks[taskId].status) {
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return next;
}

export function taskNodes(manifest: PlanPackageManifest) {
  const graph = compileTaskGraph(manifest);
  return graph.taskNodesInManifestOrder
    .map((taskId) => graph.tasksById.get(taskId))
    .filter((task) => task !== undefined);
}

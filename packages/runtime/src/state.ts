import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { optionalStat } from "./fs/optionalFile.js";
import { compileTaskGraph } from "./graph/compileTaskGraph.js";
import { readJsonFile, writeJsonFile } from "./json.js";
import type {
  BlockState,
  BlockStatus,
  CompiledExecutionGraph,
  FeedbackEnvelopeState,
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
  return readJsonFile<RuntimeState>(stateFile);
}

export async function writeState(stateFile: string, state: RuntimeState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeJsonFile(stateFile, state);
}

function defaultBlockStatus(ref: string, graph: CompiledExecutionGraph, state: RuntimeState): BlockStatus {
  const taskId = graph.blockTaskByRef.get(ref);
  if (!taskId || !taskDependenciesSatisfied(taskId, graph, state)) {
    return "planned";
  }
  const dependencies = graph.blockDependenciesByRef.get(ref) ?? [];
  return dependencies.every((dependency) => state.blocks[dependency]?.status === "completed") ? "ready" : "planned";
}

function taskDependenciesSatisfied(taskId: string, graph: CompiledExecutionGraph, state: RuntimeState): boolean {
  return (graph.taskDependenciesByTask.get(taskId) ?? []).every((dependency) => state.tasks[dependency]?.status === "implemented");
}

function hasOpenFeedbackForTask(taskId: string, graph: CompiledExecutionGraph, state: RuntimeState): boolean {
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

function aggregateTaskStatus(taskId: string, graph: CompiledExecutionGraph, state: RuntimeState): TaskState {
  const refs = graph.blocksByTask.get(taskId) ?? [];
  const blocks = refs.map((ref) => state.blocks[ref]).filter(Boolean);
  const openFeedbackCount = Object.values(state.feedback).filter((feedback) => {
    const sourceTask = graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
    return sourceTask === taskId && (feedback.status === "open" || feedback.status === "in_progress");
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
      return block?.type !== "review" || !block.review.required || state.blocks[ref]?.completionReason === "passed";
    });
  if (requiredNonReviewComplete && requiredReviewsPassed) {
    return { status: "implemented", openFeedbackCount };
  }
  return { status: refs.some((ref) => hasStartedBlock(state.blocks[ref])) ? "in_progress" : "ready", openFeedbackCount };
}

export function ensureStateForManifest(manifest: PlanPackageManifest, state: RuntimeState): RuntimeState {
  const graph = compileTaskGraph(manifest);
  const validTaskIds = new Set(graph.taskNodesInManifestOrder);
  const validBlockRefs = new Set(graph.blockRefsInManifestOrder);
  const currentRefs = Array.isArray(state.currentRefs) ? state.currentRefs.filter((ref) => typeof ref === "string") : [];
  const feedback = state.feedback ?? {};
  const currentFeedback = state.currentFeedbackId ? feedback[state.currentFeedbackId] : null;
  const next: RuntimeState = {
    currentRefs: currentRefs.filter((ref) => validBlockRefs.has(ref)),
    currentFeedbackId:
      state.currentFeedbackId && currentFeedback && (currentFeedback.status === "open" || currentFeedback.status === "in_progress")
        ? state.currentFeedbackId
        : null,
    currentReviewBlockRef:
      state.currentReviewBlockRef && validBlockRefs.has(state.currentReviewBlockRef) ? state.currentReviewBlockRef : null,
    tasks: {},
    blocks: {},
    feedback: {}
  };

  for (const [feedbackId, feedbackState] of Object.entries(feedback)) {
    if (validBlockRefs.has(feedbackState.sourceReviewBlockRef)) {
      next.feedback[feedbackId] = feedbackState as FeedbackEnvelopeState;
    }
  }

  for (const ref of graph.blockRefsInManifestOrder) {
    const existing = state.blocks?.[ref] as BlockState | undefined;
    next.blocks[ref] = existing ?? { status: defaultBlockStatus(ref, graph, next), lastRunId: null };
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
      if ((graph.blockDependenciesByRef.get(ref) ?? []).every((dependency) => next.blocks[dependency]?.status === "completed")) {
        if (block.type === "review" && hasOpenFeedbackForTask(taskId, graph, next)) {
          continue;
        }
        next.blocks[ref] = { ...blockState, status: "ready" };
      }
    }
    next.tasks[taskId] = aggregateTaskStatus(taskId, graph, next);
  }

  return next;
}

export function taskNodes(manifest: PlanPackageManifest) {
  const graph = compileTaskGraph(manifest);
  return graph.taskNodesInManifestOrder.map((taskId) => graph.tasksById.get(taskId)).filter((task) => task !== undefined);
}

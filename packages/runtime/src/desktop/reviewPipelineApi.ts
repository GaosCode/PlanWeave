import { optionalReadFile } from "../fs/optionalFile.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import {
  buildPlanPackageManifestChangeMutation,
  removePromptSideEffect,
  writePromptSideEffects
} from "../graph/mutation.js";
import { loadPackage } from "../package/loadPackage.js";
import { executePlanGraphCommand, type PlanGraphCommandResult } from "../plangraph/index.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { invalidateDesktopProjectProjection } from "./graph/projectProjectionModel.js";
import type {
  GraphEditResult,
  ManifestBlock,
  ManifestReviewBlock,
  ManifestTaskNode,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ReviewTriggerCondition
} from "../types.js";
import type {
  DesktopReviewPipeline,
  DesktopReviewPipelineStepInput,
  DesktopUpdateReviewPipelineInput
} from "./types.js";

async function readOptionalFile(path: string): Promise<string> {
  return (await optionalReadFile(path, "utf8")) ?? "";
}

function reviewRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function nextReviewBlockId(task: ManifestTaskNode, used: Set<string>): string {
  let index = task.blocks.filter((block) => block.type === "review").length + 1;
  while (used.has(`R-${String(index).padStart(3, "0")}`)) {
    index += 1;
  }
  const id = `R-${String(index).padStart(3, "0")}`;
  used.add(id);
  return id;
}

function defaultPrompt(title: string): string {
  return `# ${title}\n\nReview the completed work and return passed or needs_changes feedback.`;
}

function promptPath(taskId: string, blockId: string): string {
  return `nodes/${taskId}/blocks/${blockId}.prompt.md`;
}

async function graphEditResult(
  projectRoot: PackageWorkspaceRef,
  result: PlanGraphCommandResult
): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  return {
    ok: result.ok && graph.diagnostics.errors.length === 0,
    affectedTasks: result.ok ? result.affected.tasks : [],
    diagnostics: result.ok ? graph.diagnostics.errors : result.diagnostics,
    graph
  };
}

function normalizeTrigger(value: ReviewTriggerCondition | undefined): ReviewTriggerCondition {
  return value ?? "after_required_work_completed";
}

function normalizeStep(options: {
  task: ManifestTaskNode;
  existing: Map<string, ManifestReviewBlock>;
  usedBlockIds: Set<string>;
  step: DesktopReviewPipelineStepInput;
  fallbackDependency: string | null;
}): ManifestReviewBlock {
  const blockId =
    options.step.blockId?.trim() || nextReviewBlockId(options.task, options.usedBlockIds);
  options.usedBlockIds.add(blockId);
  const existing = options.existing.get(blockId);
  return {
    id: blockId,
    type: "review",
    title: requireNonEmpty(options.step.title, "Review step title"),
    prompt: existing?.prompt ?? promptPath(options.task.id, blockId),
    depends_on: options.fallbackDependency ? [options.fallbackDependency] : [],
    executor: existing?.executor,
    review: {
      required: options.step.enabled,
      maxFeedbackCycles: Math.max(0, Math.trunc(options.step.maxFeedbackCycles)),
      preset: requireNonEmpty(options.step.preset, "Review preset"),
      triggerCondition: normalizeTrigger(options.step.triggerCondition),
      inputContext: requireNonEmpty(options.step.inputContext, "Review input context"),
      passCriteria: requireNonEmpty(options.step.passCriteria, "Review pass criteria"),
      feedbackFormat: requireNonEmpty(options.step.feedbackFormat, "Review feedback format"),
      hook: options.step.hook
    }
  };
}

function reviewBlocks(task: ManifestTaskNode): ManifestReviewBlock[] {
  return task.blocks.filter((block): block is ManifestReviewBlock => block.type === "review");
}

export async function getReviewPipeline(
  projectRoot: PackageWorkspaceRef,
  taskId: string
): Promise<DesktopReviewPipeline> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = graph.tasksById.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  const steps = await Promise.all(
    reviewBlocks(task).map(async (block) => ({
      blockRef: reviewRef(task.id, block.id),
      blockId: block.id,
      title: block.title,
      enabled: block.review.required,
      preset: block.review.preset ?? "general",
      triggerCondition: normalizeTrigger(block.review.triggerCondition),
      inputContext: block.review.inputContext ?? "latest implementation reports",
      passCriteria: block.review.passCriteria ?? "All acceptance criteria are satisfied.",
      feedbackFormat:
        block.review.feedbackFormat ?? "Actionable feedback for implementation blocks.",
      maxFeedbackCycles: block.review.maxFeedbackCycles,
      hook: block.review.hook,
      promptMarkdown: await readOptionalFile(
        await resolvePackagePath(workspace.packageDir, block.prompt)
      )
    }))
  );
  return {
    taskId: task.id,
    taskTitle: task.title,
    packageDefaults: {
      maxFeedbackCycles: manifest.review.maxFeedbackCycles,
      completionPolicy: manifest.review.completionPolicy
    },
    steps
  };
}

export async function updateReviewPipeline(
  projectRoot: PackageWorkspaceRef,
  taskId: string,
  input: DesktopUpdateReviewPipelineInput
): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const mutation = buildReviewPipelineMutation(manifest, taskId, input);
  const result = await executePlanGraphCommand({
    projectRoot,
    command: {
      type: "updateReviewPipeline",
      taskId: mutation.taskId,
      packageDefaults: mutation.packageDefaults,
      reviewBlocks: mutation.reviewBlocks,
      promptMarkdownByBlockId: mutation.promptMarkdownByBlockId
    }
  });
  invalidateDesktopProjectProjection(projectRoot);
  return graphEditResult(projectRoot, result);
}

type BuiltReviewPipelineMutation = {
  taskId: string;
  packageDefaults: { maxFeedbackCycles: number; completionPolicy: "strict" };
  reviewBlocks: ManifestReviewBlock[];
  promptMarkdownByBlockId: Array<{ blockId: string; markdown: string }>;
  nextManifest: ReturnType<typeof buildPlanPackageManifestChangeMutation>["nextManifest"];
  sideEffects: ReturnType<typeof buildPlanPackageManifestChangeMutation>["sideEffects"];
};

function buildReviewPipelineMutation(
  manifest: PlanPackageManifest,
  taskId: string,
  input: DesktopUpdateReviewPipelineInput
): BuiltReviewPipelineMutation {
  const graph = compileTaskGraph(manifest);
  const task = graph.tasksById.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }

  const existingReviews = new Map(reviewBlocks(task).map((block) => [block.id, block]));
  const usedBlockIds = new Set(task.blocks.map((block) => block.id));
  const nonReviewBlocks = task.blocks.filter((block) => block.type !== "review");
  const nextReviewBlocks: ManifestReviewBlock[] = [];
  let fallbackDependency = nonReviewBlocks.at(-1)?.id ?? null;

  for (const step of input.steps) {
    if (step.blockId && !existingReviews.has(step.blockId)) {
      throw new Error(`Review block '${task.id}#${step.blockId}' does not exist.`);
    }
    const block = normalizeStep({
      task,
      existing: existingReviews,
      usedBlockIds,
      step,
      fallbackDependency
    });
    nextReviewBlocks.push(block);
    fallbackDependency = block.id;
  }

  const promptMarkdownByBlockId: Array<{ blockId: string; markdown: string }> = [];
  for (const [index, block] of nextReviewBlocks.entries()) {
    const promptMarkdown = input.steps[index]?.promptMarkdown.trim() || defaultPrompt(block.title);
    promptMarkdownByBlockId.push({
      blockId: block.id,
      markdown: promptMarkdown.endsWith("\n") ? promptMarkdown : `${promptMarkdown}\n`
    });
  }
  const packageDefaults = {
    maxFeedbackCycles: Math.max(
      0,
      Math.trunc(input.packageDefaults?.maxFeedbackCycles ?? manifest.review.maxFeedbackCycles)
    ),
    completionPolicy: input.packageDefaults?.completionPolicy ?? manifest.review.completionPolicy
  };
  const reviewPromptPaths = new Set(nextReviewBlocks.map((block) => block.prompt));
  const removedPrompts = task.blocks
    .filter((block) => block.type === "review" && !reviewPromptPaths.has(block.prompt))
    .map((block) => removePromptSideEffect(block.prompt));
  const promptMarkdownByBlockIdMap = new Map(
    promptMarkdownByBlockId.map((item) => [item.blockId, item.markdown])
  );
  const sideEffects = [
    ...removedPrompts,
    ...nextReviewBlocks.flatMap((block) =>
      writePromptSideEffects(block.prompt, promptMarkdownByBlockIdMap.get(block.id) ?? "")
    )
  ];
  const nextTask: ManifestTaskNode = {
    ...task,
    blocks: [...task.blocks.filter((block) => block.type !== "review"), ...nextReviewBlocks]
  };
  const nextManifest = {
    ...manifest,
    review: { ...packageDefaults },
    nodes: manifest.nodes.map((node) =>
      node.type === "task" && node.id === task.id ? nextTask : node
    )
  };
  return {
    taskId: task.id,
    packageDefaults,
    reviewBlocks: nextReviewBlocks,
    promptMarkdownByBlockId,
    nextManifest,
    sideEffects
  };
}

export async function bulkApplyReviewPipeline(
  projectRoot: PackageWorkspaceRef,
  updates: Array<{ taskId: string; input: DesktopUpdateReviewPipelineInput }>
): Promise<GraphEditResult> {
  if (updates.length === 0) {
    throw new Error("updates must contain at least one review pipeline update.");
  }
  const { manifest } = await loadPackage(projectRoot);
  let nextManifest = manifest;
  const sideEffects: ReturnType<typeof buildPlanPackageManifestChangeMutation>["sideEffects"] = [];
  const affectedTasks: string[] = [];
  for (const update of updates) {
    const mutation = buildReviewPipelineMutation(nextManifest, update.taskId, update.input);
    nextManifest = mutation.nextManifest;
    sideEffects.push(...mutation.sideEffects);
    affectedTasks.push(mutation.taskId);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
      affectedTasks,
      sideEffects
    })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { manifestSchema } from "../schema/manifest.js";
import type {
  GraphEditResult,
  ManifestBlock,
  ManifestReviewBlock,
  ManifestTaskNode,
  PlanPackageManifest,
  ReviewTriggerCondition,
  ValidationIssue
} from "../types.js";
import type { DesktopReviewPipeline, DesktopReviewPipelineStepInput, DesktopUpdateReviewPipelineInput } from "./types.js";

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
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

function normalizeTrigger(value: ReviewTriggerCondition | undefined): ReviewTriggerCondition {
  return value ?? "after_required_work_completed";
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function validationIssues(manifest: PlanPackageManifest): ValidationIssue[] {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return parsed.error.issues.map((item) =>
      issue("manifest_schema_invalid", item.message, item.path.length > 0 ? item.path.join(".") : "manifest.json")
    );
  }
  return compileTaskGraph(manifest).diagnostics.errors;
}

function graphEditResult(manifest: PlanPackageManifest, affectedTasks: string[], diagnostics: ValidationIssue[] = []): GraphEditResult {
  const graph = compileTaskGraph(manifest);
  const allDiagnostics = [...diagnostics, ...graph.diagnostics.errors];
  return {
    ok: allDiagnostics.length === 0,
    affectedTasks: [...new Set(affectedTasks)],
    diagnostics: allDiagnostics,
    graph
  };
}

async function writeReviewPipelineManifest(options: {
  manifestFile: string;
  manifest: PlanPackageManifest;
  affectedTasks: string[];
}): Promise<GraphEditResult> {
  const diagnostics = validationIssues(options.manifest);
  if (diagnostics.length > 0) {
    return graphEditResult(options.manifest, options.affectedTasks, diagnostics);
  }
  await writeJsonFile(options.manifestFile, options.manifest);
  return graphEditResult(options.manifest, options.affectedTasks);
}

function normalizeStep(options: {
  task: ManifestTaskNode;
  existing: Map<string, ManifestReviewBlock>;
  usedBlockIds: Set<string>;
  step: DesktopReviewPipelineStepInput;
  fallbackDependency: string | null;
}): ManifestReviewBlock {
  const blockId = options.step.blockId?.trim() || nextReviewBlockId(options.task, options.usedBlockIds);
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

export async function getReviewPipeline(projectRoot: string, taskId: string): Promise<DesktopReviewPipeline> {
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
      inputContext: block.review.inputContext ?? "latest implementation and check reports",
      passCriteria: block.review.passCriteria ?? "All acceptance criteria are satisfied.",
      feedbackFormat: block.review.feedbackFormat ?? "Actionable feedback for implementation blocks.",
      maxFeedbackCycles: block.review.maxFeedbackCycles,
      hook: block.review.hook,
      promptMarkdown: await readOptionalFile(await resolvePackagePath(workspace.packageDir, block.prompt))
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
  projectRoot: string,
  taskId: string,
  input: DesktopUpdateReviewPipelineInput
): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = graph.tasksById.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  if (input.steps.length === 0) {
    throw new Error("Review pipeline must contain at least one review step.");
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

  const nextTask: ManifestTaskNode = {
    ...task,
    blocks: [...(nonReviewBlocks as ManifestBlock[]), ...nextReviewBlocks]
  };
  const nextManifest: PlanPackageManifest = {
    ...manifest,
    review: {
      maxFeedbackCycles: Math.max(
        0,
        Math.trunc(input.packageDefaults?.maxFeedbackCycles ?? manifest.review.maxFeedbackCycles)
      ),
      completionPolicy: input.packageDefaults?.completionPolicy ?? manifest.review.completionPolicy
    },
    nodes: manifest.nodes.map((node) => (node.type === "task" && node.id === taskId ? nextTask : node))
  };
  const result = await writeReviewPipelineManifest({
    manifestFile: workspace.manifestFile,
    manifest: nextManifest,
    affectedTasks: [task.id]
  });
  if (!result.ok) {
    return result;
  }

  const nextIds = new Set(nextReviewBlocks.map((block) => block.id));
  for (const block of reviewBlocks(task)) {
    if (!nextIds.has(block.id)) {
      await rm(await resolvePackagePath(workspace.packageDir, block.prompt), { force: true });
    }
  }
  for (const [index, block] of nextReviewBlocks.entries()) {
    const promptMarkdown = input.steps[index]?.promptMarkdown.trim() || defaultPrompt(block.title);
    const path = await resolvePackagePath(workspace.packageDir, block.prompt, { forWrite: true });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, promptMarkdown.endsWith("\n") ? promptMarkdown : `${promptMarkdown}\n`, "utf8");
  }
  return result;
}

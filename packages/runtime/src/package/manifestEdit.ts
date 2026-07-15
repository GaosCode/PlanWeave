import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { executePlanGraphCommand, type PlanGraphCommandResult } from "../plangraph/index.js";
import type {
  EditBlockInput,
  EditBlockResult,
  EditTaskInput,
  EditTaskResult,
  PlanPackageManifest
} from "../types.js";
import { loadPackage } from "./loadPackage.js";

function taskUpdatedFields(options: EditTaskInput): string[] {
  const fields: string[] = [];
  if (options.title !== undefined) {
    fields.push("title");
  }
  if (options.promptMarkdown !== undefined) {
    fields.push("prompt");
  }
  if (options.executor !== undefined) {
    fields.push("executor");
  }
  if (options.acceptance !== undefined) {
    fields.push("acceptance");
  }
  return fields;
}

function blockUpdatedFields(manifest: PlanPackageManifest, options: EditBlockInput): string[] {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  const block = task?.type === "task" ? task.blocks.find((item) => item.id === blockId) : undefined;
  if (!block) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  const fields: string[] = [];
  if (options.title !== undefined) {
    fields.push("title");
  }
  if (options.promptMarkdown !== undefined) {
    fields.push("prompt");
  }
  if (options.executor !== undefined) {
    fields.push("executor");
  }
  if (options.dependsOn !== undefined) {
    fields.push("depends_on");
  }
  if (block.type === "implementation") {
    if (options.sharedResources !== undefined) {
      fields.push("parallel.sharedResources");
    }
  } else {
    if (options.reviewRequired !== undefined) {
      fields.push("review.required");
    }
    if (options.maxFeedbackCycles !== undefined) {
      fields.push("review.maxFeedbackCycles");
    }
    if (options.reviewHook !== undefined) {
      fields.push("review.hook");
    }
  }
  return fields;
}

async function graphEditResult(
  projectRoot: EditTaskInput["projectRoot"],
  commandResult: PlanGraphCommandResult
) {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  return {
    ok: commandResult.ok && graph.diagnostics.errors.length === 0,
    affectedTasks: commandResult.ok ? commandResult.affected.tasks : [],
    diagnostics: commandResult.ok ? graph.diagnostics.errors : commandResult.diagnostics,
    graph
  };
}

export async function editTask(options: EditTaskInput): Promise<EditTaskResult> {
  const updatedFields = taskUpdatedFields(options);
  const commandResult = await executePlanGraphCommand({
    projectRoot: options.projectRoot,
    command: {
      type: "updateTaskFields",
      taskId: options.taskId,
      fields: {
        title: options.title,
        promptMarkdown: options.promptMarkdown,
        executor: options.executor,
        acceptance: options.acceptance
      }
    }
  });
  return {
    ...(await graphEditResult(options.projectRoot, commandResult)),
    taskId: options.taskId,
    updatedFields
  };
}

export async function editBlock(options: EditBlockInput): Promise<EditBlockResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const { taskId, blockId } = parseBlockRef(options.ref);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  const block = task?.type === "task" ? task.blocks.find((item) => item.id === blockId) : undefined;
  if (!block) {
    throw new Error(`Block '${options.ref}' does not exist.`);
  }
  const updatedFields = blockUpdatedFields(manifest, options);
  const commandResult = await executePlanGraphCommand({
    projectRoot: options.projectRoot,
    command: {
      type: "updateBlockFields",
      blockRef: options.ref,
      fields: {
        title: options.title,
        promptMarkdown: options.promptMarkdown,
        executor: options.executor,
        dependsOn: options.dependsOn,
        sharedResources: options.sharedResources,
        reviewRequired: options.reviewRequired,
        maxFeedbackCycles: options.maxFeedbackCycles,
        reviewHook: options.reviewHook
      }
    }
  });
  return {
    ...(await graphEditResult(options.projectRoot, commandResult)),
    ref: options.ref,
    taskId,
    blockId,
    blockType: block.type,
    updatedFields
  };
}

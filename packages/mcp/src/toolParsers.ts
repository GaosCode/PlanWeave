import {
  blockRefFromArgs,
  jsonToolResult,
  nonEmptyString,
  parseProjectCanvasArgs,
  readObjectArgs
} from "./toolHelpers.js";
import {
  parseCreateTaskToolArgs,
  parseUpdateBlockToolArgs,
  parseUpdateReviewPipelineToolArgs,
  parseUpdateTaskToolArgs
} from "./toolInputSchemas.js";
import {
  parseBlockDependenciesInput,
  parseBlockPlanningInput,
  parseCanvasExecutionPolicyInput,
  parseCreateBlockInput,
  parseProjectTaskRefs,
  parseTaskAcceptanceInput
} from "./toolStructuredEditSchemas.js";
import type { RuntimeGateway } from "./toolTypes.js";

export {
  parseCreateTaskToolArgs,
  parseUpdateBlockToolArgs,
  parseUpdateReviewPipelineToolArgs,
  parseUpdateTaskToolArgs
};

export {
  parseBlockDependenciesInput,
  parseBlockPlanningInput,
  parseCanvasExecutionPolicyInput,
  parseCreateBlockInput,
  parseProjectTaskRefs,
  parseTaskAcceptanceInput
};

export function requiredMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("markdown or promptMarkdown must be a string.");
  }
  return value;
}

export async function readPrompt(args: unknown, gateway: RuntimeGateway) {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseProjectCanvasArgs(record);
  const target = nonEmptyString(record.target, "target");
  if (target === "project") {
    return jsonToolResult({ target, markdown: await gateway.readProjectPrompt(projectId) });
  }
  if (target === "task") {
    const task = await gateway.getTaskDetail(
      projectId,
      nonEmptyString(record.taskId, "taskId"),
      canvasId
    );
    return jsonToolResult({
      target,
      taskId: task.taskId,
      markdown: task.promptMarkdown,
      promptMissing: task.promptMissing
    });
  }
  if (target === "block") {
    const block = await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId);
    return jsonToolResult({
      target,
      blockRef: block.ref,
      markdown: record.rendered === true ? block.promptSurfaceMarkdown : block.promptMarkdown,
      promptMissing: block.promptMissing,
      rendered: record.rendered === true
    });
  }
  throw new Error("target must be one of: project, task, block.");
}

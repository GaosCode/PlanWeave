import { summarizeRefreshPrompts } from "../toolExportResults.js";
import {
  blockRefFromArgs,
  jsonToolResult,
  nonEmptyString,
  optionalNonEmptyString,
  parseProjectArgs,
  parseProjectCanvasArgs,
  readObjectArgs,
  summarizeGraphEdit
} from "../toolHelpers.js";
import { readPrompt, requiredMarkdown } from "../toolParsers.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";
import type { RuntimeGateway } from "../toolTypes.js";

export const contentToolHandlers = {
  read_prompt: async (args, gateway) => readPrompt(args, gateway),
  list_package_files: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult(
      await gateway.listPackageFiles(
        projectId,
        canvasId,
        parseOptionalPositiveInteger(record.limit, "limit"),
        optionalNonEmptyString(record.cursor, "cursor")
      )
    );
  },
  read_package_file: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      file: await gateway.readPackageFile(
        projectId,
        canvasId,
        nonEmptyString(record.path, "path"),
        parseOptionalPositiveInteger(record.maxBytes, "maxBytes")
      )
    });
  },
  read_prompt_source: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      prompt: await gateway.readPromptSource(projectId, canvasId, {
        target: parsePromptSourceTarget(record.target),
        taskId: optionalNonEmptyString(record.taskId, "taskId"),
        blockRef: optionalNonEmptyString(record.blockRef, "blockRef"),
        maxBytes: parseOptionalPositiveInteger(record.maxBytes, "maxBytes")
      })
    });
  },
  get_rendered_prompt: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      prompt: await gateway.readRenderedPrompt(
        projectId,
        canvasId,
        nonEmptyString(record.ref, "ref"),
        parseOptionalPositiveInteger(record.maxBytes, "maxBytes")
      )
    });
  },
  get_prompt_sources: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      promptSources: await gateway.getPromptSources(
        projectId,
        canvasId,
        nonEmptyString(record.ref, "ref")
      )
    });
  },
  write_task_prompt: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.updateTask(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), {
        promptMarkdown: requiredMarkdown(record.markdown)
      })
    );
  },
  write_prompt_source: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const target = parsePromptSourceTarget(record.target);
    if (target === "project") {
      return jsonToolResult({
        markdown: await gateway.updateProjectPrompt(projectId, requiredMarkdown(record.markdown))
      });
    }
    if (target === "task") {
      return graphEditResult(
        await gateway.updateTask(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), {
          promptMarkdown: requiredMarkdown(record.markdown)
        })
      );
    }
    return graphEditResult(
      await gateway.updateBlock(projectId, canvasId, blockRefFromArgs(record), {
        promptMarkdown: requiredMarkdown(record.markdown)
      })
    );
  },
  write_block_prompt: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.updateBlock(projectId, canvasId, blockRefFromArgs(record), {
        promptMarkdown: requiredMarkdown(record.markdown)
      })
    );
  },
  update_project_prompt: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId } = parseProjectArgs(record);
    return jsonToolResult({
      markdown: await gateway.updateProjectPrompt(projectId, requiredMarkdown(record.markdown))
    });
  },
  refresh_prompts: async (args, gateway) => refreshPrompts(args, gateway, false),
  refresh_prompts_summary: async (args, gateway) => refreshPrompts(args, gateway, false),
  refresh_prompts_full_debug: async (args, gateway) => refreshPrompts(args, gateway, true)
} satisfies PlanweavePartialToolHandlerRegistry;

async function refreshPrompts(args: unknown, gateway: RuntimeGateway, includeFullDetails: boolean) {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseProjectCanvasArgs(record);
  return jsonToolResult({
    refresh: summarizeRefreshPrompts(
      await gateway.refreshPrompts(projectId, canvasId),
      includeFullDetails
    )
  });
}

function graphEditResult(result: Awaited<ReturnType<RuntimeGateway["updateTask"]>>) {
  return jsonToolResult({ edit: summarizeGraphEdit(result) });
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function parsePromptSourceTarget(value: unknown): "project" | "task" | "block" {
  const target = parseEnum(value, "target", ["project", "task", "block"] as const);
  if (!target) {
    throw new Error("target is required.");
  }
  return target;
}

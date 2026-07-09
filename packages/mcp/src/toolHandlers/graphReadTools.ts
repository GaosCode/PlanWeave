import { summarizeBlockDetail } from "../toolBlockSummary.js";
import {
  blockRefFromArgs,
  jsonToolResult,
  nonEmptyString,
  optionalNonEmptyString,
  parseGetPromptArgs,
  parseProjectCanvasArgs,
  parseReadonlyProjectCanvasArgs,
  parseSearchProjectArgs,
  readObjectArgs,
  sanitizeLocalPaths,
  sanitizeValidationIssues
} from "../toolHelpers.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";
import type { RuntimeGateway } from "../toolTypes.js";

function summarizeProjectGraph(graph: Awaited<ReturnType<RuntimeGateway["getProjectGraph"]>>) {
  return {
    ...graph,
    contentIncluded: false as const,
    tasks: graph.tasks.map((task) => {
      const { promptMarkdown, ...rest } = task;
      return {
        ...rest,
        promptMarkdownAvailable: !task.promptMissing,
        promptMarkdownBytes: Buffer.byteLength(promptMarkdown, "utf8")
      };
    })
  };
}

export const graphReadToolHandlers = {
  get_status: async (args, gateway) => {
    const { projectId, canvasId } = parseReadonlyProjectCanvasArgs(args);
    const status = await gateway.getStatus(projectId, canvasId);
    return jsonToolResult({ ...status, warnings: sanitizeValidationIssues(status.warnings) });
  },
  get_prompt: async (args, gateway) => {
    const { projectId, canvasId, ref } = parseGetPromptArgs(args);
    const prompt = await gateway.getPrompt(projectId, canvasId, ref);
    return jsonToolResult({
      projectId,
      canvasId: prompt.canvasId,
      ref,
      markdown: prompt.markdown
    });
  },
  search_project: async (args, gateway) => {
    const { projectId, search } = parseSearchProjectArgs(args);
    const searchResult = await gateway.searchProject(projectId, search);
    return jsonToolResult({
      ...searchResult,
      results: searchResult.results.map((result) => ({
        ...result,
        title: sanitizeLocalPaths(result.title),
        excerpt: sanitizeLocalPaths(result.excerpt),
        match: result.match
          ? {
              ...result.match,
              excerpt: sanitizeLocalPaths(result.match.excerpt)
            }
          : undefined
      })),
      diagnostics: sanitizeValidationIssues(searchResult.diagnostics)
    });
  },
  list_ready_blocks: async (args, gateway) => {
    const { projectId, canvasId } = parseReadonlyProjectCanvasArgs(args);
    return jsonToolResult(await gateway.listReadyBlocks(projectId, canvasId));
  },
  preview_execution_graph: async (args, gateway) => {
    const { projectId, canvasId } = parseProjectCanvasArgs(args);
    return jsonToolResult({
      graph: summarizeProjectGraph(await gateway.getProjectGraph(projectId, canvasId))
    });
  },
  get_project_graph: async (args, gateway) => {
    const { projectId, canvasId } = parseProjectCanvasArgs(args);
    return jsonToolResult({
      graph: summarizeProjectGraph(await gateway.getProjectGraph(projectId, canvasId))
    });
  },
  get_project_graph_full_debug: async (args, gateway) => {
    const { projectId, canvasId } = parseProjectCanvasArgs(args);
    return jsonToolResult({
      graph: await gateway.getProjectGraph(projectId, canvasId),
      heavy: true
    });
  },
  get_graph_summary: async (args, gateway) => {
    const { projectId, canvasId, limit, cursor } = parseGraphReadArgs(args);
    return jsonToolResult({
      graph: await gateway.inspectGraph(projectId, canvasId, { view: "summary", limit, cursor })
    });
  },
  list_tasks: async (args, gateway) => {
    const { projectId, canvasId, limit, cursor } = parseGraphReadArgs(args);
    return jsonToolResult({
      graph: await gateway.inspectGraph(projectId, canvasId, { view: "tasks", limit, cursor })
    });
  },
  get_graph_slice: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId, limit } = parseGraphReadArgs(record);
    if (record.cursor !== undefined) {
      throw new Error("get_graph_slice does not support cursor pagination.");
    }
    return jsonToolResult({
      graph: await gateway.inspectGraph(projectId, canvasId, {
        view: "slice",
        taskId: nonEmptyString(record.taskId, "taskId"),
        limit
      })
    });
  },
  validate_graph_quality: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      graphQuality: await gateway.validateGraphQuality(
        projectId,
        canvasId,
        parseGraphQualityOptions(record)
      )
    });
  },
  validate_execution_readiness: async (args, gateway) => {
    const { projectId, canvasId } = parseProjectCanvasArgs(args);
    return jsonToolResult({
      readiness: await gateway.validateExecutionReadiness(projectId, canvasId)
    });
  },
  get_task_detail: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      task: await gateway.getTaskDetail(
        projectId,
        nonEmptyString(record.taskId, "taskId"),
        canvasId
      )
    });
  },
  get_block_detail: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const block = await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId);
    return jsonToolResult({
      block: record.view === "summary" ? summarizeBlockDetail(block) : block
    });
  },
  get_block_summary: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      block: summarizeBlockDetail(
        await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId)
      )
    });
  },
  get_block_detail_full_debug: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      block: await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId)
    });
  },
  get_review_pipeline: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return jsonToolResult({
      reviewPipeline: await gateway.getReviewPipeline(
        projectId,
        nonEmptyString(record.taskId, "taskId"),
        canvasId
      )
    });
  }
} satisfies PlanweavePartialToolHandlerRegistry;

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function parseGraphReadArgs(args: unknown): {
  projectId: string;
  canvasId?: string;
  limit?: number;
  cursor?: string;
} {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseProjectCanvasArgs(record);
  return {
    projectId,
    canvasId,
    limit: parseOptionalPositiveInteger(record.limit, "limit"),
    cursor: optionalNonEmptyString(record.cursor, "cursor")
  };
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

function parseGraphQualityOptions(record: Record<string, unknown>) {
  return {
    reviewPolicy: parseEnum(record.reviewPolicy, "reviewPolicy", [
      "none",
      "risk-based",
      "required"
    ] as const),
    gatePolicy: parseEnum(record.gatePolicy, "gatePolicy", ["none", "required"] as const),
    heuristics: parseEnum(record.heuristics, "heuristics", ["on", "off"] as const),
    strict: record.strict === true
  };
}

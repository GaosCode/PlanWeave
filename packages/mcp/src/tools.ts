import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authoringRules, exampleFiles } from "./toolDocs.js";
import {
  blockRefFromArgs,
  explainValidationReport,
  jsonToolResult,
  nonEmptyString,
  parseGetPromptArgs,
  parseGetSchemaArgs,
  parsePackageFiles,
  parseProjectArgs,
  parseProjectCanvasArgs,
  parseReadonlyProjectCanvasArgs,
  parseSearchProjectArgs,
  readObjectArgs,
  sanitizeProject,
  sanitizeLocalPaths,
  sanitizeValidationIssues,
  summarizeGraphEdit
} from "./toolHelpers.js";
import {
  parseBlockDependenciesInput,
  parseBlockPlanningInput,
  parseCreateBlockInput,
  parseCreateTaskInput,
  parseProjectTaskRefs,
  parseReviewPipelineInput,
  parseTaskAcceptanceInput,
  parseUpdateInput,
  readPrompt,
  requiredMarkdown
} from "./toolParsers.js";
import { runtimeGateway } from "./toolRuntime.js";
import { planweaveToolNames, type PlanweaveToolName, type RuntimeGateway } from "./toolTypes.js";

export { planweaveToolNames, type PlanweaveToolName, type RuntimeGateway };

export async function handlePlanweaveTool(
  name: PlanweaveToolName,
  args: unknown,
  gateway: RuntimeGateway = runtimeGateway
): Promise<CallToolResult> {
  switch (name) {
    case "get_schema": {
      const { topic } = parseGetSchemaArgs(args);
      const documents = gateway.getSchemaDocuments();
      return jsonToolResult({ topic: topic ?? null, documents: topic ? { [topic]: documents[topic] } : documents });
    }
    case "get_authoring_rules":
      return jsonToolResult({ rules: [...authoringRules] });
    case "get_plan_package_example":
      return jsonToolResult({ files: exampleFiles, notes: ["Use import_plan_package with files[] to create a project from this example."] });
    case "list_projects": {
      const projects = await gateway.listProjects();
      return jsonToolResult({ projects: projects.map(sanitizeProject) });
    }
    case "open_project": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ project: sanitizeProject(await gateway.openProject(projectId)) });
    }
    case "init_project": {
      const record = readObjectArgs(args);
      return jsonToolResult({ project: sanitizeProject(await gateway.initProject(nonEmptyString(record.name, "name"))) });
    }
    case "create_canvas": {
      const record = readObjectArgs(args);
      const { projectId } = parseProjectArgs(record);
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
      return jsonToolResult({ canvas: await gateway.createCanvas(projectId, name) });
    }
    case "get_project_overview": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ project: sanitizeProject(await gateway.getProjectOverview(projectId)) });
    }
    case "validate_project": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult(await gateway.validateProject(projectId));
    }
    case "explain_validation_errors": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult(explainValidationReport(await gateway.validateProject(projectId)));
    }
    case "get_status": {
      const { projectId, canvasId } = parseReadonlyProjectCanvasArgs(args);
      const status = await gateway.getStatus(projectId, canvasId);
      return jsonToolResult({ ...status, warnings: sanitizeValidationIssues(status.warnings) });
    }
    case "get_prompt": {
      const { projectId, canvasId, ref } = parseGetPromptArgs(args);
      const prompt = await gateway.getPrompt(projectId, canvasId, ref);
      return jsonToolResult({
        projectId,
        canvasId: prompt.canvasId,
        ref,
        markdown: prompt.markdown
      });
    }
    case "search_project": {
      const { projectId, search } = parseSearchProjectArgs(args);
      const searchResult = await gateway.searchProject(projectId, search);
      return jsonToolResult({
        ...searchResult,
        results: searchResult.results.map((result) => ({
          ...result,
          title: sanitizeLocalPaths(result.title),
          excerpt: sanitizeLocalPaths(result.excerpt)
        })),
        diagnostics: sanitizeValidationIssues(searchResult.diagnostics)
      });
    }
    case "list_ready_blocks": {
      const { projectId, canvasId } = parseReadonlyProjectCanvasArgs(args);
      return jsonToolResult(await gateway.listReadyBlocks(projectId, canvasId));
    }
    case "preview_execution_graph":
    case "get_project_graph": {
      const { projectId, canvasId } = parseProjectCanvasArgs(args);
      return jsonToolResult({ graph: await gateway.getProjectGraph(projectId, canvasId) });
    }
    case "get_task_detail": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ task: await gateway.getTaskDetail(projectId, nonEmptyString(record.taskId, "taskId"), canvasId) });
    }
    case "get_block_detail": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ block: await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId) });
    }
    case "get_review_pipeline": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ reviewPipeline: await gateway.getReviewPipeline(projectId, nonEmptyString(record.taskId, "taskId"), canvasId) });
    }
    case "update_review_pipeline": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(
        await gateway.updateReviewPipeline(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), parseReviewPipelineInput(record))
      );
    }
    case "create_task": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.createTask(projectId, canvasId, parseCreateTaskInput(record)));
    }
    case "update_task": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.updateTask(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), parseUpdateInput(record)));
    }
    case "update_task_acceptance": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(
        await gateway.updateTaskAcceptance(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), parseTaskAcceptanceInput(record))
      );
    }
    case "remove_task": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.removeTask(projectId, canvasId, nonEmptyString(record.taskId, "taskId")));
    }
    case "create_block": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.createBlock(projectId, canvasId, parseCreateBlockInput(record)));
    }
    case "update_block": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.updateBlock(projectId, canvasId, blockRefFromArgs(record), parseUpdateInput(record)));
    }
    case "update_block_planning": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.updateBlockPlanning(projectId, canvasId, blockRefFromArgs(record), parseBlockPlanningInput(record)));
    }
    case "update_block_dependencies": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.updateBlockDependencies(projectId, canvasId, blockRefFromArgs(record), parseBlockDependenciesInput(record)));
    }
    case "remove_block": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.removeBlock(projectId, canvasId, blockRefFromArgs(record)));
    }
    case "add_dependency":
    case "remove_dependency": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const operation = name === "add_dependency" ? gateway.addDependency : gateway.removeDependency;
      return graphEditResult(await operation(projectId, canvasId, nonEmptyString(record.fromTaskId, "fromTaskId"), nonEmptyString(record.toTaskId, "toTaskId")));
    }
    case "add_canvas_dependency":
    case "remove_canvas_dependency": {
      const record = readObjectArgs(args);
      const { projectId } = parseProjectArgs(record);
      const operation = name === "add_canvas_dependency" ? gateway.addCanvasDependency : gateway.removeCanvasDependency;
      return projectGraphEditResult(
        await operation(projectId, nonEmptyString(record.fromCanvasId, "fromCanvasId"), nonEmptyString(record.toCanvasId, "toCanvasId"))
      );
    }
    case "add_cross_task_dependency":
    case "remove_cross_task_dependency": {
      const record = readObjectArgs(args);
      const { projectId } = parseProjectArgs(record);
      const { from, to } = parseProjectTaskRefs(record);
      const operation = name === "add_cross_task_dependency" ? gateway.addCrossTaskDependency : gateway.removeCrossTaskDependency;
      return projectGraphEditResult(await operation(projectId, from, to));
    }
    case "read_prompt":
      return readPrompt(args, gateway);
    case "write_task_prompt": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(
        await gateway.updateTask(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), {
          promptMarkdown: requiredMarkdown(record.markdown)
        })
      );
    }
    case "write_block_prompt": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(
        await gateway.updateBlock(projectId, canvasId, blockRefFromArgs(record), {
          promptMarkdown: requiredMarkdown(record.markdown)
        })
      );
    }
    case "update_project_prompt": {
      const record = readObjectArgs(args);
      const { projectId } = parseProjectArgs(record);
      return jsonToolResult({ markdown: await gateway.updateProjectPrompt(projectId, requiredMarkdown(record.markdown)) });
    }
    case "refresh_prompts": {
      const { projectId, canvasId } = parseProjectCanvasArgs(args);
      return jsonToolResult({ refresh: await gateway.refreshPrompts(projectId, canvasId) });
    }
    case "export_plan_package": {
      const { projectId, canvasId } = parseProjectCanvasArgs(args);
      return jsonToolResult({ planPackage: await gateway.exportPlanPackage(projectId, canvasId) });
    }
    case "export_project": {
      const { projectId } = parseProjectArgs(args);
      const exported = await gateway.exportProject(projectId);
      return jsonToolResult({
        project: sanitizeProject(exported.project),
        projectPromptMarkdown: exported.projectPromptMarkdown,
        planPackages: exported.planPackages
      });
    }
    case "import_plan_package": {
      const record = readObjectArgs(args);
      const imported = await gateway.importPlanPackage({
        name: nonEmptyString(record.name, "name"),
        files: parsePackageFiles(record.files),
        overwrite: record.overwrite === true
      });
      return jsonToolResult({
        project: sanitizeProject(imported.project),
        validation: imported.validation,
        importedFiles: imported.importedFiles
      });
    }
  }
}

export function isPlanweaveToolName(value: string): value is PlanweaveToolName {
  return planweaveToolNames.includes(value as PlanweaveToolName);
}

function graphEditResult(result: Awaited<ReturnType<RuntimeGateway["createTask"]>>): CallToolResult {
  return jsonToolResult({ edit: summarizeGraphEdit(result) });
}

function projectGraphEditResult(result: Awaited<ReturnType<RuntimeGateway["addCanvasDependency"]>>): CallToolResult {
  return jsonToolResult({
    projectGraphEdit: {
      ok: result.ok,
      diagnostics: result.diagnostics,
      graph: result.graph
    }
  });
}

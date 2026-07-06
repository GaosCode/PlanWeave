import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authoringRules, exampleFiles, exampleTemplates, getPackageExampleFiles, planweaveGuide } from "./toolDocs.js";
import { summarizeBlockDetail } from "./toolBlockSummary.js";
import {
  blockRefFromArgs,
  explainValidationReport,
  jsonToolResult,
  nonEmptyString,
  optionalNonEmptyString,
  optionalStringArray,
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
  sanitizeValidationReport,
  sanitizeValidationIssues,
  summarizeGraphEdit
} from "./toolHelpers.js";
import {
  affectedBlockRefsForTasks,
  bulkGraphEditResult,
  createdBlockRefsForInputs,
  parseBlockDependencyUpdates,
  parseBulkCreateBlocks,
  parseBulkCreateTasks,
  parseBulkParallelPolicyInput,
  parseBulkRemoveGraphItems,
  parseBulkReviewPipelineUpdates,
  parseBulkUpdateBlocks,
  parseBulkUpdateTasks,
  parseTaskDependencyEdges,
  parseTaskDependencyUpdates,
  reviewBlockRefsForPipelineUpdates
} from "./toolBulkEdit.js";
import { fullProjectExport, selectProjectExportFiles, summarizePlanPackage, summarizeProjectExport, summarizeRefreshPrompts } from "./toolExportResults.js";
import { compatOnlyToolGroups, defaultToolGroups } from "./toolGroups.js";
import {
  parseBlockDependenciesInput,
  parseBlockPlanningInput,
  parseCanvasExecutionPolicyInput,
  parseCreateBlockInput,
  parseCreateTaskToolArgs,
  parseProjectTaskRefs,
  parseTaskAcceptanceInput,
  parseUpdateBlockToolArgs,
  parseUpdateReviewPipelineToolArgs,
  parseUpdateTaskToolArgs,
  readPrompt,
  requiredMarkdown
} from "./toolParsers.js";
import { runtimeGateway } from "./toolRuntime.js";
import {
  compatPlanweaveToolNames,
  debugPlanweaveToolNames,
  defaultPlanweaveToolNames,
  planweaveToolNames,
  type PlanweaveToolName,
  type RuntimeGateway
} from "./toolTypes.js";

export { compatPlanweaveToolNames, debugPlanweaveToolNames, defaultPlanweaveToolNames, planweaveToolNames, type PlanweaveToolName, type RuntimeGateway };

export async function handlePlanweaveTool(
  name: PlanweaveToolName,
  args: unknown,
  gateway: RuntimeGateway = runtimeGateway
): Promise<CallToolResult> {
  switch (name) {
    case "list_tool_groups":
      return jsonToolResult({ groups: defaultToolGroups, compatOnlyGroups: compatOnlyToolGroups });
    case "get_schema": {
      const { topic } = parseGetSchemaArgs(args);
      const documents = gateway.getSchemaDocuments();
      if (!topic) {
        return jsonToolResult({
          topic: null,
          topics: Object.values(documents).map(({ name, summary, path, ownership }) => ({ name, summary, path, ownership })),
          documents: {}
        });
      }
      return jsonToolResult({ topic, documents: { [topic]: documents[topic] } });
    }
    case "get_planweave_guide":
      return jsonToolResult({ guide: planweaveGuide });
    case "get_authoring_rules":
      return jsonToolResult({ rules: [...authoringRules] });
    case "get_plan_package_examples": {
      const record = args === undefined || args === null ? {} : readObjectArgs(args);
      const template = optionalNonEmptyString(record.template, "template");
      const files = template ? getPackageExampleFiles(template) : undefined;
      if (template && !files) {
        throw new Error(`Unknown package example template '${template}'.`);
      }
      return jsonToolResult({
        examples: exampleTemplates,
        files,
        notes: template
          ? ["Write these files to a draft root, then use validate_package_draft, validate_graph_quality, preview_package_import, import_package_draft, and apply_canvas_lane_layout."]
          : ["Pass template: \"basic\" or template: \"large_dag_with_review_loop\" to return a selected file set."]
      });
    }
    case "get_plan_package_example":
      return jsonToolResult({ files: exampleFiles, notes: ["Write these files to a draft root, then use validate_package_draft and preview_package_import before import_package_draft."] });
    case "get_project_tree":
      return jsonToolResult(await buildProjectTree(gateway, parseProjectTreeArgs(args)));
    case "list_projects": {
      const projects = await gateway.listProjects();
      return jsonToolResult({ projects: projects.map(sanitizeProject) });
    }
    case "list_projects_summary": {
      const projects = await gateway.listProjects();
      return jsonToolResult({ projects: projects.map(sanitizeProject) });
    }
    case "open_project": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ project: sanitizeProject(await gateway.openProject(projectId)) });
    }
    case "open_project_summary": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ project: sanitizeProject(await gateway.openProject(projectId)) });
    }
    case "list_canvases": {
      const { projectId } = parseProjectArgs(args);
      const project = sanitizeProject(await gateway.openProject(projectId));
      return jsonToolResult({ projectId: project.projectId, canvases: project.taskCanvases });
    }
    case "get_project_overview": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ project: sanitizeProject(await gateway.openProject(projectId)) });
    }
    case "create_project":
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
    case "validate_project": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult(sanitizeValidationReport(await gateway.validateProject(projectId)));
    }
    case "explain_validation_errors": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult(explainValidationReport(sanitizeValidationReport(await gateway.validateProject(projectId))));
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
    case "get_graph_summary": {
      const { projectId, canvasId, limit, cursor } = parseGraphReadArgs(args);
      return jsonToolResult({ graph: await gateway.inspectGraph(projectId, canvasId, { view: "summary", limit, cursor }) });
    }
    case "list_tasks": {
      const { projectId, canvasId, limit, cursor } = parseGraphReadArgs(args);
      return jsonToolResult({ graph: await gateway.inspectGraph(projectId, canvasId, { view: "tasks", limit, cursor }) });
    }
    case "get_graph_slice": {
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
    }
    case "validate_graph_quality": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({
        graphQuality: await gateway.validateGraphQuality(projectId, canvasId, parseGraphQualityOptions(record))
      });
    }
    case "validate_execution_readiness": {
      const { projectId, canvasId } = parseProjectCanvasArgs(args);
      return jsonToolResult({ readiness: await gateway.validateExecutionReadiness(projectId, canvasId) });
    }
    case "get_task_detail": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ task: await gateway.getTaskDetail(projectId, nonEmptyString(record.taskId, "taskId"), canvasId) });
    }
    case "get_block_detail": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const block = await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId);
      return jsonToolResult({ block: record.view === "summary" ? summarizeBlockDetail(block) : block });
    }
    case "get_block_summary": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ block: summarizeBlockDetail(await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId)) });
    }
    case "get_block_detail_full_debug": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ block: await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId) });
    }
    case "get_review_pipeline": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ reviewPipeline: await gateway.getReviewPipeline(projectId, nonEmptyString(record.taskId, "taskId"), canvasId) });
    }
    case "update_review_pipeline":
    case "set_review_pipeline": {
      const record = readObjectArgs(args);
      const { projectId, canvasId, taskId, input } = parseUpdateReviewPipelineToolArgs(record);
      return graphEditResult(await gateway.updateReviewPipeline(projectId, canvasId, taskId, input));
    }
    case "create_task": {
      const record = readObjectArgs(args);
      const { projectId, canvasId, input } = parseCreateTaskToolArgs(record);
      return graphEditResult(await gateway.createTask(projectId, canvasId, input));
    }
    case "bulk_create_tasks": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const tasks = parseBulkCreateTasks(record, projectId, canvasId);
      const result = await gateway.bulkCreateTasks(projectId, canvasId, tasks);
      return bulkGraphEditResult(result, { affectedBlocks: affectedBlockRefsForTasks(result, result.affectedTasks) });
    }
    case "update_task": {
      const record = readObjectArgs(args);
      const { projectId, canvasId, taskId, input } = parseUpdateTaskToolArgs(record);
      return graphEditResult(await gateway.updateTask(projectId, canvasId, taskId, input));
    }
    case "bulk_update_tasks": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return bulkGraphEditResult(await gateway.bulkUpdateTasks(projectId, canvasId, parseBulkUpdateTasks(record)));
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
    case "bulk_create_blocks": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const blocks = parseBulkCreateBlocks(record);
      const result = await gateway.bulkCreateBlocks(projectId, canvasId, blocks);
      return bulkGraphEditResult(result, { affectedBlocks: createdBlockRefsForInputs(result, blocks) });
    }
    case "update_block": {
      const record = readObjectArgs(args);
      const { projectId, canvasId, blockRef, input } = parseUpdateBlockToolArgs(record);
      return graphEditResult(await gateway.updateBlock(projectId, canvasId, blockRef, input));
    }
    case "bulk_update_blocks": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const updates = parseBulkUpdateBlocks(record);
      return bulkGraphEditResult(await gateway.bulkUpdateBlocks(projectId, canvasId, updates), {
        affectedBlocks: updates.map((update) => update.blockRef)
      });
    }
    case "bulk_remove_graph_items": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const input = parseBulkRemoveGraphItems(record);
      return bulkGraphEditResult(await gateway.bulkRemoveGraphItems(projectId, canvasId, input), {
        affectedBlocks: input.blocks
      });
    }
    case "update_canvas_execution_policy": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.updateCanvasExecutionPolicy(projectId, canvasId, parseCanvasExecutionPolicyInput(record)));
    }
    case "update_block_planning": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.updateBlockPlanning(projectId, canvasId, blockRefFromArgs(record), parseBlockPlanningInput(record)));
    }
    case "update_block_dependencies":
    case "set_block_dependencies": {
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
    case "add_task_dependency":
    case "remove_task_dependency": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const operation = name === "add_task_dependency" ? gateway.addDependency : gateway.removeDependency;
      return graphEditResult(
        await operation(projectId, canvasId, nonEmptyString(record.dependentTaskId, "dependentTaskId"), nonEmptyString(record.dependsOnTaskId, "dependsOnTaskId"))
      );
    }
    case "set_task_dependencies": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(await gateway.setTaskDependencies(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), requiredStringArrayValue(record.dependsOn, "dependsOn")));
    }
    case "bulk_add_task_dependencies": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return bulkGraphEditResult(await gateway.bulkAddTaskDependencies(projectId, canvasId, parseTaskDependencyEdges(record.edges)));
    }
    case "bulk_set_task_dependencies": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return bulkGraphEditResult(await gateway.bulkSetTaskDependencies(projectId, canvasId, parseTaskDependencyUpdates(record.updates)));
    }
    case "bulk_set_block_dependencies": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const updates = parseBlockDependencyUpdates(record.updates);
      return bulkGraphEditResult(await gateway.bulkSetBlockDependencies(projectId, canvasId, updates), {
        affectedBlocks: updates.map((update) => update.blockRef)
      });
    }
    case "bulk_apply_review_pipeline": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const updates = parseBulkReviewPipelineUpdates(record, projectId, canvasId);
      const result = await gateway.bulkApplyReviewPipeline(projectId, canvasId, updates);
      return bulkGraphEditResult(result, { affectedBlocks: reviewBlockRefsForPipelineUpdates(result, updates) });
    }
    case "bulk_update_parallel_policy": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const input = parseBulkParallelPolicyInput(record);
      return bulkGraphEditResult(await gateway.bulkUpdateParallelPolicy(projectId, canvasId, input), {
        affectedBlocks: input.blocks.map((block) => block.blockRef)
      });
    }
    case "apply_canvas_lane_layout": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const layout = await gateway.applyCanvasLaneLayout(projectId, canvasId, {
        columnWidth: parseOptionalPositiveNumber(record.columnWidth, "columnWidth"),
        rowHeight: parseOptionalPositiveNumber(record.rowHeight, "rowHeight"),
        startX: parseOptionalNumber(record.startX, "startX"),
        startY: parseOptionalNumber(record.startY, "startY")
      });
      const bounds = layout.nodes.length === 0
        ? null
        : layout.nodes.reduce(
            (current, node) => ({
              minX: Math.min(current.minX, node.x),
              minY: Math.min(current.minY, node.y),
              maxX: Math.max(current.maxX, node.x),
              maxY: Math.max(current.maxY, node.y)
            }),
            { minX: layout.nodes[0].x, minY: layout.nodes[0].y, maxX: layout.nodes[0].x, maxY: layout.nodes[0].y }
          );
      const previewBounds = bounds === null
        ? null
        : {
            ...bounds,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY
          };
      return jsonToolResult({ nodeCount: layout.nodes.length, bounds: previewBounds, summary: { nodeCount: layout.nodes.length } });
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
    case "list_package_files": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult(await gateway.listPackageFiles(projectId, canvasId, parseOptionalPositiveInteger(record.limit, "limit"), optionalNonEmptyString(record.cursor, "cursor")));
    }
    case "read_package_file": {
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
    }
    case "read_prompt_source": {
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
    }
    case "get_rendered_prompt": {
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
    }
    case "get_prompt_sources": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ promptSources: await gateway.getPromptSources(projectId, canvasId, nonEmptyString(record.ref, "ref")) });
    }
    case "write_task_prompt": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return graphEditResult(
        await gateway.updateTask(projectId, canvasId, nonEmptyString(record.taskId, "taskId"), {
          promptMarkdown: requiredMarkdown(record.markdown)
        })
      );
    }
    case "write_prompt_source": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const target = parsePromptSourceTarget(record.target);
      if (target === "project") {
        return jsonToolResult({ markdown: await gateway.updateProjectPrompt(projectId, requiredMarkdown(record.markdown)) });
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
    case "refresh_prompts":
    case "refresh_prompts_summary": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ refresh: summarizeRefreshPrompts(await gateway.refreshPrompts(projectId, canvasId), false) });
    }
    case "refresh_prompts_full_debug": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ refresh: summarizeRefreshPrompts(await gateway.refreshPrompts(projectId, canvasId), true) });
    }
    case "export_plan_package": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ planPackage: summarizePlanPackage(await gateway.exportPlanPackage(projectId, canvasId), record.includeFiles === true) });
    }
    case "export_plan_package_summary": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ planPackage: summarizePlanPackage(await gateway.exportPlanPackage(projectId, canvasId), false) });
    }
    case "export_plan_package_files": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      const requestedPaths = new Set(requiredStringArray(record.paths, "paths"));
      const exported = await gateway.exportPlanPackage(projectId, canvasId);
      const filesByPath = new Map(exported.files.map((file) => [file.path, file]));
      const missingPaths = [...requestedPaths].filter((path) => !filesByPath.has(path));
      if (missingPaths.length > 0) {
        throw new Error(`Requested package export file(s) not found: ${missingPaths.join(", ")}`);
      }
      return jsonToolResult({
        planPackage: {
          canvasId: exported.canvasId,
          files: [...requestedPaths].map((path) => {
            const file = filesByPath.get(path);
            if (!file) {
              throw new Error(`Requested package export file(s) not found: ${path}`);
            }
            return file;
          })
        }
      });
    }
    case "export_plan_package_full": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({ planPackage: await gateway.exportPlanPackage(projectId, canvasId), heavy: true });
    }
    case "export_project": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ projectExport: summarizeProjectExport(await gateway.exportProject(projectId), false) });
    }
    case "export_project_summary": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ projectExport: summarizeProjectExport(await gateway.exportProject(projectId), false) });
    }
    case "export_project_files": {
      const record = readObjectArgs(args);
      const { projectId } = parseProjectArgs(record);
      return jsonToolResult({ projectExport: selectProjectExportFiles(await gateway.exportProject(projectId), record) });
    }
    case "export_project_full_debug": {
      const { projectId } = parseProjectArgs(args);
      return jsonToolResult({ projectExport: fullProjectExport(await gateway.exportProject(projectId)), heavy: true });
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
        validation: sanitizeValidationReport(imported.validation),
        importedFiles: imported.importedFiles
      });
    }
    case "validate_package_draft": {
      const record = readObjectArgs(args);
      return jsonToolResult({ draft: await gateway.validatePackageDraft(nonEmptyString(record.draftRoot, "draftRoot")) });
    }
    case "preview_package_import": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      return jsonToolResult({
        preview: await gateway.previewPackageDraftImport({
          projectId,
          canvasId,
          draftRoot: nonEmptyString(record.draftRoot, "draftRoot")
        })
      });
    }
    case "import_package_draft": {
      const record = readObjectArgs(args);
      const { projectId, canvasId } = parseProjectCanvasArgs(record);
      if (record.apply !== true) {
        throw new Error("import_package_draft requires apply: true.");
      }
      return jsonToolResult({
        import: await gateway.importPackageDraft({
          projectId,
          canvasId,
          draftRoot: nonEmptyString(record.draftRoot, "draftRoot")
        })
      });
    }
  }
}

export function isPlanweaveToolName(value: string): value is PlanweaveToolName {
  return planweaveToolNames.includes(value as PlanweaveToolName);
}

type ProjectTreeArgs = {
  projectId?: string;
  includeTasks: boolean;
  includeStatus: boolean;
};

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function parseOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function parseOptionalPositiveNumber(value: unknown, field: string): number | undefined {
  const parsed = parseOptionalNumber(value, field);
  if (parsed !== undefined && parsed <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return parsed;
}

function requiredStringArray(value: unknown, field: string): string[] {
  const parsed = optionalStringArray(value, field);
  if (!parsed || parsed.length === 0) {
    throw new Error(`${field} must contain at least one string.`);
  }
  return parsed;
}

function requiredStringArrayValue(value: unknown, field: string): string[] {
  const parsed = optionalStringArray(value, field);
  if (!parsed) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return parsed;
}

function parseGraphReadArgs(args: unknown): ProjectTreeArgs & { projectId: string; canvasId?: string; limit?: number; cursor?: string } {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseProjectCanvasArgs(record);
  return {
    projectId,
    canvasId,
    limit: parseOptionalPositiveInteger(record.limit, "limit"),
    cursor: optionalNonEmptyString(record.cursor, "cursor"),
    includeTasks: false,
    includeStatus: false
  };
}

function parseEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
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
    reviewPolicy: parseEnum(record.reviewPolicy, "reviewPolicy", ["none", "risk-based", "required"] as const),
    gatePolicy: parseEnum(record.gatePolicy, "gatePolicy", ["none", "required"] as const),
    heuristics: parseEnum(record.heuristics, "heuristics", ["on", "off"] as const),
    strict: record.strict === true
  };
}

function parsePromptSourceTarget(value: unknown): "project" | "task" | "block" {
  const target = parseEnum(value, "target", ["project", "task", "block"] as const);
  if (!target) {
    throw new Error("target is required.");
  }
  return target;
}

function parseProjectTreeArgs(args: unknown): ProjectTreeArgs {
  if (args === undefined || args === null) {
    return { includeTasks: true, includeStatus: true };
  }
  const record = readObjectArgs(args);
  return {
    projectId: typeof record.projectId === "string" && record.projectId.trim() ? record.projectId.trim() : undefined,
    includeTasks: record.includeTasks !== false,
    includeStatus: record.includeStatus !== false
  };
}

async function buildProjectTree(gateway: RuntimeGateway, args: ProjectTreeArgs) {
  const allProjects = await gateway.listProjects();
  const projects = args.projectId ? allProjects.filter((project) => project.projectId === args.projectId) : allProjects;
  if (args.projectId && projects.length === 0) {
    throw new Error(`Project '${args.projectId}' is not registered in PlanWeave.`);
  }
  return {
    generatedAt: new Date().toISOString(),
    desktopSelection: null,
    guidance: [
      "Use project.projectId and canvasId exactly as returned here for project-scoped write tools.",
      "When the user names an existing PlanWeave project, inspect this tree before deciding whether to open an existing project or initialize a new one.",
      "Use get_project_graph, get_task_detail, get_block_detail, or read_prompt to inspect a selected branch in more detail."
    ],
    projects: await Promise.all(projects.map((project) => buildProjectContext(gateway, project, args))),
    errors: [] as Array<{ scope: string; message: string }>
  };
}

async function buildProjectContext(gateway: RuntimeGateway, project: Awaited<ReturnType<RuntimeGateway["listProjects"]>>[number], args: ProjectTreeArgs) {
  const errors: Array<{ scope: string; message: string }> = [];
  const validation = await captureContextValue(`validate_project:${project.projectId}`, errors, async () => {
    const report = await gateway.validateProject(project.projectId);
    return sanitizeValidationReport(report);
  });
  const status = args.includeStatus
    ? await captureContextValue(`get_status:${project.projectId}`, errors, async () => {
        const projectStatus = await gateway.getStatus(project.projectId, project.activeCanvasId ?? undefined);
        return { ...projectStatus, warnings: sanitizeValidationIssues(projectStatus.warnings) };
      })
    : null;
  const readyBlocks = args.includeStatus
    ? await captureContextValue(`list_ready_blocks:${project.projectId}`, errors, async () => (await gateway.listReadyBlocks(project.projectId)).readyBlocks)
    : [];
  const canvases = args.includeTasks
    ? await Promise.all(project.taskCanvases.map((canvas) => buildGraphContext(gateway, project.projectId, canvas.canvasId, canvas.name, errors)))
    : [];

  return {
    project: sanitizeProject(project),
    validation,
    status,
    readyBlocks: readyBlocks ?? [],
    canvases: canvases.filter((canvas): canvas is NonNullable<typeof canvas> => canvas !== null),
    errors
  };
}

async function buildGraphContext(
  gateway: RuntimeGateway,
  projectId: string,
  canvasId: string,
  canvasName: string,
  errors: Array<{ scope: string; message: string }>
) {
  return captureContextValue(`get_project_graph:${projectId}:${canvasId}`, errors, async () => {
    const graph = await gateway.getProjectGraph(projectId, canvasId);
    return {
      canvasId,
      name: canvasName,
      taskCount: graph.tasks.length,
      edgeCount: graph.edges.length,
      diagnostics: sanitizeValidationIssues(graph.diagnostics),
      dirtyPromptRefs: graph.dirtyPromptRefs,
      tasks: graph.tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        executor: task.executor,
        promptMissing: task.promptMissing,
        blockCount: task.blocks.length,
        blocks: task.blocks
      }))
    };
  });
}

async function captureContextValue<T>(
  scope: string,
  errors: Array<{ scope: string; message: string }>,
  read: () => Promise<T>
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    errors.push({ scope, message: sanitizeLocalPaths(error instanceof Error ? error.message : String(error)) });
    return null;
  }
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

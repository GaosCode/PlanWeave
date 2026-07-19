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
} from "../toolBulkEdit.js";
import {
  blockRefFromArgs,
  jsonToolResult,
  nonEmptyString,
  parseProjectArgs,
  parseProjectCanvasArgs,
  readObjectArgs,
  summarizeGraphEdit
} from "../toolHelpers.js";
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
  parseUpdateTaskToolArgs
} from "../toolParsers.js";
import {
  parseOptionalNumber,
  parseOptionalPositiveNumber,
  parseRequiredStringArray
} from "../toolStructuredEditSchemas.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";
import type { RuntimeGateway } from "../toolTypes.js";

export const graphEditToolHandlers = {
  update_review_pipeline: async (args, gateway) => updateReviewPipeline(args, gateway),
  set_review_pipeline: async (args, gateway) => updateReviewPipeline(args, gateway),
  create_task: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId, input } = parseCreateTaskToolArgs(record);
    return graphEditResult(await gateway.createTask(projectId, canvasId, input));
  },
  bulk_create_tasks: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const tasks = parseBulkCreateTasks(record);
    const result = await gateway.bulkCreateTasks(projectId, canvasId, tasks);
    return bulkGraphEditResult(result, {
      affectedBlocks: affectedBlockRefsForTasks(result, result.affectedTasks)
    });
  },
  update_task: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId, taskId, input } = parseUpdateTaskToolArgs(record);
    return graphEditResult(await gateway.updateTask(projectId, canvasId, taskId, input));
  },
  bulk_update_tasks: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return bulkGraphEditResult(
      await gateway.bulkUpdateTasks(projectId, canvasId, parseBulkUpdateTasks(record))
    );
  },
  update_task_acceptance: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.updateTaskAcceptance(
        projectId,
        canvasId,
        nonEmptyString(record.taskId, "taskId"),
        parseTaskAcceptanceInput(record)
      )
    );
  },
  remove_task: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.removeTask(projectId, canvasId, nonEmptyString(record.taskId, "taskId"))
    );
  },
  create_block: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.createBlock(projectId, canvasId, parseCreateBlockInput(record))
    );
  },
  bulk_create_blocks: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const blocks = parseBulkCreateBlocks(record);
    const result = await gateway.bulkCreateBlocks(projectId, canvasId, blocks);
    return bulkGraphEditResult(result, {
      affectedBlocks: createdBlockRefsForInputs(result, blocks)
    });
  },
  update_block: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId, blockRef, input } = parseUpdateBlockToolArgs(record);
    return graphEditResult(await gateway.updateBlock(projectId, canvasId, blockRef, input));
  },
  bulk_update_blocks: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const updates = parseBulkUpdateBlocks(record);
    return bulkGraphEditResult(await gateway.bulkUpdateBlocks(projectId, canvasId, updates), {
      affectedBlocks: updates.map((update) => update.blockRef)
    });
  },
  bulk_remove_graph_items: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const input = parseBulkRemoveGraphItems(record);
    return bulkGraphEditResult(await gateway.bulkRemoveGraphItems(projectId, canvasId, input), {
      affectedBlocks: input.blocks
    });
  },
  update_canvas_execution_policy: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.updateCanvasExecutionPolicy(
        projectId,
        canvasId,
        parseCanvasExecutionPolicyInput(record)
      )
    );
  },
  update_block_planning: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.updateBlockPlanning(
        projectId,
        canvasId,
        blockRefFromArgs(record),
        parseBlockPlanningInput(record)
      )
    );
  },
  update_block_dependencies: async (args, gateway) => updateBlockDependencies(args, gateway),
  set_block_dependencies: async (args, gateway) => updateBlockDependencies(args, gateway),
  remove_block: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.removeBlock(projectId, canvasId, blockRefFromArgs(record))
    );
  },
  add_dependency: async (args, gateway) => updateTaskDependency(args, gateway, "legacy-add"),
  remove_dependency: async (args, gateway) => updateTaskDependency(args, gateway, "legacy-remove"),
  add_task_dependency: async (args, gateway) => updateTaskDependency(args, gateway, "add"),
  remove_task_dependency: async (args, gateway) => updateTaskDependency(args, gateway, "remove"),
  set_task_dependencies: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return graphEditResult(
      await gateway.setTaskDependencies(
        projectId,
        canvasId,
        nonEmptyString(record.taskId, "taskId"),
        parseRequiredStringArray(record.dependsOn, "dependsOn")
      )
    );
  },
  bulk_add_task_dependencies: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return bulkGraphEditResult(
      await gateway.bulkAddTaskDependencies(
        projectId,
        canvasId,
        parseTaskDependencyEdges(record.edges)
      )
    );
  },
  bulk_set_task_dependencies: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    return bulkGraphEditResult(
      await gateway.bulkSetTaskDependencies(
        projectId,
        canvasId,
        parseTaskDependencyUpdates(record.updates)
      )
    );
  },
  bulk_set_block_dependencies: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const updates = parseBlockDependencyUpdates(record.updates);
    return bulkGraphEditResult(
      await gateway.bulkSetBlockDependencies(projectId, canvasId, updates),
      {
        affectedBlocks: updates.map((update) => update.blockRef)
      }
    );
  },
  bulk_apply_review_pipeline: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const updates = parseBulkReviewPipelineUpdates(record);
    const result = await gateway.bulkApplyReviewPipeline(projectId, canvasId, updates);
    return bulkGraphEditResult(result, {
      affectedBlocks: reviewBlockRefsForPipelineUpdates(result, updates)
    });
  },
  bulk_update_parallel_policy: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const input = parseBulkParallelPolicyInput(record);
    return bulkGraphEditResult(await gateway.bulkUpdateParallelPolicy(projectId, canvasId, input), {
      affectedBlocks: input.blocks.map((block) => block.blockRef)
    });
  },
  apply_canvas_lane_layout: async (args, gateway) => {
    const record = readObjectArgs(args);
    const { projectId, canvasId } = parseProjectCanvasArgs(record);
    const layout = await gateway.applyCanvasLaneLayout(projectId, canvasId, {
      columnWidth: parseOptionalPositiveNumber(record.columnWidth, "columnWidth"),
      rowHeight: parseOptionalPositiveNumber(record.rowHeight, "rowHeight"),
      startX: parseOptionalNumber(record.startX, "startX"),
      startY: parseOptionalNumber(record.startY, "startY")
    });
    const bounds =
      layout.nodes.length === 0
        ? null
        : layout.nodes.reduce(
            (current, node) => ({
              minX: Math.min(current.minX, node.x),
              minY: Math.min(current.minY, node.y),
              maxX: Math.max(current.maxX, node.x),
              maxY: Math.max(current.maxY, node.y)
            }),
            {
              minX: layout.nodes[0].x,
              minY: layout.nodes[0].y,
              maxX: layout.nodes[0].x,
              maxY: layout.nodes[0].y
            }
          );
    const previewBounds =
      bounds === null
        ? null
        : {
            ...bounds,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY
          };
    return jsonToolResult({
      nodeCount: layout.nodes.length,
      bounds: previewBounds,
      summary: { nodeCount: layout.nodes.length }
    });
  },
  add_canvas_dependency: async (args, gateway) => updateCanvasDependency(args, gateway, "add"),
  remove_canvas_dependency: async (args, gateway) =>
    updateCanvasDependency(args, gateway, "remove"),
  add_cross_task_dependency: async (args, gateway) =>
    updateCrossTaskDependency(args, gateway, "add"),
  remove_cross_task_dependency: async (args, gateway) =>
    updateCrossTaskDependency(args, gateway, "remove")
} satisfies PlanweavePartialToolHandlerRegistry;

async function updateReviewPipeline(args: unknown, gateway: RuntimeGateway) {
  const record = readObjectArgs(args);
  const { projectId, canvasId, taskId, input } = parseUpdateReviewPipelineToolArgs(record);
  return graphEditResult(await gateway.updateReviewPipeline(projectId, canvasId, taskId, input));
}

async function updateBlockDependencies(args: unknown, gateway: RuntimeGateway) {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseProjectCanvasArgs(record);
  return graphEditResult(
    await gateway.updateBlockDependencies(
      projectId,
      canvasId,
      blockRefFromArgs(record),
      parseBlockDependenciesInput(record)
    )
  );
}

async function updateTaskDependency(
  args: unknown,
  gateway: RuntimeGateway,
  operation: "legacy-add" | "legacy-remove" | "add" | "remove"
) {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseProjectCanvasArgs(record);
  if (operation === "legacy-add") {
    return graphEditResult(
      await gateway.addDependency(
        projectId,
        canvasId,
        nonEmptyString(record.fromTaskId, "fromTaskId"),
        nonEmptyString(record.toTaskId, "toTaskId")
      )
    );
  }
  if (operation === "legacy-remove") {
    return graphEditResult(
      await gateway.removeDependency(
        projectId,
        canvasId,
        nonEmptyString(record.fromTaskId, "fromTaskId"),
        nonEmptyString(record.toTaskId, "toTaskId")
      )
    );
  }
  if (operation === "add") {
    return graphEditResult(
      await gateway.addDependency(
        projectId,
        canvasId,
        nonEmptyString(record.dependentTaskId, "dependentTaskId"),
        nonEmptyString(record.dependsOnTaskId, "dependsOnTaskId")
      )
    );
  }
  return graphEditResult(
    await gateway.removeDependency(
      projectId,
      canvasId,
      nonEmptyString(record.dependentTaskId, "dependentTaskId"),
      nonEmptyString(record.dependsOnTaskId, "dependsOnTaskId")
    )
  );
}

async function updateCanvasDependency(
  args: unknown,
  gateway: RuntimeGateway,
  operation: "add" | "remove"
) {
  const record = readObjectArgs(args);
  const { projectId } = parseProjectArgs(record);
  if (operation === "add") {
    return projectGraphEditResult(
      await gateway.addCanvasDependency(
        projectId,
        nonEmptyString(record.fromCanvasId, "fromCanvasId"),
        nonEmptyString(record.toCanvasId, "toCanvasId")
      )
    );
  }
  return projectGraphEditResult(
    await gateway.removeCanvasDependency(
      projectId,
      nonEmptyString(record.fromCanvasId, "fromCanvasId"),
      nonEmptyString(record.toCanvasId, "toCanvasId")
    )
  );
}

async function updateCrossTaskDependency(
  args: unknown,
  gateway: RuntimeGateway,
  operation: "add" | "remove"
) {
  const record = readObjectArgs(args);
  const { projectId } = parseProjectArgs(record);
  const { from, to } = parseProjectTaskRefs(record);
  if (operation === "add") {
    return projectGraphEditResult(await gateway.addCrossTaskDependency(projectId, from, to));
  }
  return projectGraphEditResult(await gateway.removeCrossTaskDependency(projectId, from, to));
}

function graphEditResult(result: Awaited<ReturnType<RuntimeGateway["createTask"]>>) {
  return jsonToolResult({ edit: summarizeGraphEdit(result) });
}

function projectGraphEditResult(
  result: Awaited<ReturnType<RuntimeGateway["addCanvasDependency"]>>
) {
  return jsonToolResult({
    projectGraphEdit: {
      ok: result.ok,
      diagnostics: result.diagnostics,
      graph: result.graph
    }
  });
}



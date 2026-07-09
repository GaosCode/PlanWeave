import * as z from "zod/v4";
import {
  blockDetailSchema,
  bulkEditOutputSchema,
  graphEditOutputSchema,
  graphInspectionSchema,
  graphQualityReportSchema,
  graphSchema,
  reviewPipelineSchema,
  taskDetailSchema
} from "./outputShapes.js";
import type { PlanweavePartialToolOutputSchemaRegistry } from "./types.js";

export const graphToolOutputSchemas = {
  preview_execution_graph: {
    graph: graphSchema
  },
  get_project_graph: {
    graph: graphSchema
  },
  get_graph_summary: {
    graph: graphInspectionSchema
  },
  get_graph_slice: {
    graph: graphInspectionSchema
  },
  list_tasks: {
    graph: graphInspectionSchema
  },
  validate_graph_quality: {
    graphQuality: graphQualityReportSchema
  },
  get_task_detail: {
    task: taskDetailSchema
  },
  get_block_detail: {
    block: blockDetailSchema
  },
  get_block_summary: {
    block: blockDetailSchema
  },
  get_review_pipeline: {
    reviewPipeline: reviewPipelineSchema
  },
  update_review_pipeline: graphEditOutputSchema,
  set_review_pipeline: graphEditOutputSchema,
  create_task: graphEditOutputSchema,
  update_task: graphEditOutputSchema,
  update_task_acceptance: graphEditOutputSchema,
  remove_task: graphEditOutputSchema,
  create_block: graphEditOutputSchema,
  update_block: graphEditOutputSchema,
  update_canvas_execution_policy: graphEditOutputSchema,
  update_block_planning: graphEditOutputSchema,
  update_block_dependencies: graphEditOutputSchema,
  set_block_dependencies: graphEditOutputSchema,
  remove_block: graphEditOutputSchema,
  add_dependency: graphEditOutputSchema,
  remove_dependency: graphEditOutputSchema,
  add_task_dependency: graphEditOutputSchema,
  remove_task_dependency: graphEditOutputSchema,
  set_task_dependencies: graphEditOutputSchema,
  bulk_create_tasks: bulkEditOutputSchema,
  bulk_create_blocks: bulkEditOutputSchema,
  bulk_update_tasks: bulkEditOutputSchema,
  bulk_update_blocks: bulkEditOutputSchema,
  bulk_remove_graph_items: bulkEditOutputSchema,
  bulk_add_task_dependencies: bulkEditOutputSchema,
  bulk_set_task_dependencies: bulkEditOutputSchema,
  bulk_set_block_dependencies: bulkEditOutputSchema,
  bulk_apply_review_pipeline: bulkEditOutputSchema,
  bulk_update_parallel_policy: bulkEditOutputSchema,
  apply_canvas_lane_layout: {
    nodeCount: z.number(),
    bounds: z
      .object({
        minX: z.number(),
        minY: z.number(),
        maxX: z.number(),
        maxY: z.number(),
        width: z.number(),
        height: z.number()
      })
      .nullable(),
    summary: z
      .object({
        nodeCount: z.number()
      })
      .passthrough()
  }
} satisfies PlanweavePartialToolOutputSchemaRegistry;

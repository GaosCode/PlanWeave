import type { PlanGraphCommand } from "../../plangraph/index.js";
import type { DesktopAddBlockInput, DesktopAddTaskInput } from "../types.js";

type UpdateTaskFieldsCommand = Extract<PlanGraphCommand, { type: "updateTaskFields" }>;
type UpdateBlockFieldsCommand = Extract<PlanGraphCommand, { type: "updateBlockFields" }>;

export type DesktopTaskFieldEditInput = Omit<UpdateTaskFieldsCommand["fields"], "basePromptHash">;
export type DesktopBlockFieldEditInput = Omit<UpdateBlockFieldsCommand["fields"], "basePromptHash">;

export type DesktopBulkCreateTaskInput = DesktopAddTaskInput;
export type DesktopBulkCreateBlockInput = DesktopAddBlockInput;
export type DesktopBulkUpdateTaskInput = {
  taskId: string;
  fields: DesktopTaskFieldEditInput;
};
export type DesktopBulkUpdateBlockInput = {
  blockRef: string;
  fields: DesktopBlockFieldEditInput;
};
export type DesktopBulkRemoveGraphItemsInput = {
  taskIds?: string[];
  blockRefs?: string[];
  taskDependencyEdges?: Array<{ dependentTaskId: string; dependsOnTaskId: string }>;
  blockDependencyEdges?: Array<{ blockRef: string; dependsOnBlockId: string }>;
};

export type CanvasExecutionPolicyInput = {
  defaultExecutor?: string | null;
  parallelEnabled?: boolean;
  maxConcurrent?: number;
};

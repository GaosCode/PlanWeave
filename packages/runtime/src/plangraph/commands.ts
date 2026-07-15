import type { ProjectTaskRef } from "../projectGraph/types.js";
import type { PlanPackageExecutionPolicyFieldEditInput } from "../graph/fieldEditMutation.js";
import type {
  ManifestBlock,
  ManifestEdge,
  ManifestReviewBlock,
  ManifestTaskNode,
  PackageWorkspaceRef,
  ReviewHookDefinition
} from "../types.js";

export type PlanGraphCommandBase = {
  baseGraphVersion?: string;
};

export type AddTaskDependencyCommand = PlanGraphCommandBase & {
  type: "addTaskDependency";
  fromTaskId: string;
  toTaskId: string;
};

export type RemoveTaskDependencyCommand = PlanGraphCommandBase & {
  type: "removeTaskDependency";
  fromTaskId: string;
  toTaskId: string;
};

export type ReconnectTaskDependencyCommand = PlanGraphCommandBase & {
  type: "reconnectTaskDependency";
  fromTaskId: string;
  oldToTaskId: string;
  newFromTaskId?: string;
  newToTaskId: string;
};

export type UpdateTaskPromptCommand = PlanGraphCommandBase & {
  type: "updateTaskPrompt";
  taskId: string;
  promptMarkdown: string;
  basePromptHash?: string;
};

export type UpdateBlockPromptCommand = PlanGraphCommandBase & {
  type: "updateBlockPrompt";
  blockRef: string;
  promptMarkdown: string;
  basePromptHash?: string;
};

export type UpdateTaskFieldsCommand = PlanGraphCommandBase & {
  type: "updateTaskFields";
  taskId: string;
  fields: {
    title?: string;
    promptMarkdown?: string;
    executor?: string | null;
    acceptance?: string[];
    basePromptHash?: string;
  };
};

export type UpdateBlockFieldsCommand = PlanGraphCommandBase & {
  type: "updateBlockFields";
  blockRef: string;
  fields: {
    title?: string;
    promptMarkdown?: string;
    executor?: string | null;
    dependsOn?: string[];
    sharedResources?: string[];
    reviewRequired?: boolean;
    maxFeedbackCycles?: number;
    reviewHook?: ReviewHookDefinition | null;
    basePromptHash?: string;
  };
};

export type BulkUpdateBlocksCommand = PlanGraphCommandBase & {
  type: "bulkUpdateBlocks";
  updates: Array<{
    blockRef: string;
    fields: Omit<UpdateBlockFieldsCommand["fields"], "basePromptHash">;
  }>;
};

export type BulkUpdateParallelPolicyCommand = PlanGraphCommandBase & {
  type: "bulkUpdateParallelPolicy";
  canvasPolicy?: PlanPackageExecutionPolicyFieldEditInput;
  blocks: Array<{
    blockRef: string;
    input: {
      sharedResources?: string[];
    };
  }>;
};

export type TaskComponentSnapshot = {
  task: ManifestTaskNode;
  taskPromptMarkdown: string;
  blockPromptMarkdown: Array<{ blockId: string; markdown: string }>;
  insertIndex: number | null;
  affectedTaskEdges: ManifestEdge[];
  layoutNode?: { nodeId: string; x: number; y: number } | null;
};

export type BlockComponentSnapshot = {
  taskId: string;
  block: ManifestBlock;
  promptMarkdown: string;
  insertIndex: number | null;
  affectedDependsOn: Array<{ blockRef: string; dependsOn: string[] }>;
};

export type AddTaskCommand = PlanGraphCommandBase & {
  type: "addTask";
  snapshot: TaskComponentSnapshot;
};

export type RemoveTaskCommand = PlanGraphCommandBase & {
  type: "removeTask";
  taskId: string;
  layoutNode?: { nodeId: string; x: number; y: number } | null;
};

export type RestoreTaskCommand = PlanGraphCommandBase & {
  type: "restoreTask";
  snapshot: TaskComponentSnapshot;
};

export type AddBlockCommand = PlanGraphCommandBase & {
  type: "addBlock";
  snapshot: BlockComponentSnapshot;
};

export type RemoveBlockCommand = PlanGraphCommandBase & {
  type: "removeBlock";
  blockRef: string;
};

export type RestoreBlockCommand = PlanGraphCommandBase & {
  type: "restoreBlock";
  snapshot: BlockComponentSnapshot;
};

export type UpdateReviewPipelineCommand = PlanGraphCommandBase & {
  type: "updateReviewPipeline";
  taskId: string;
  packageDefaults: {
    maxFeedbackCycles: number;
    completionPolicy: "strict";
  };
  reviewBlocks: ManifestReviewBlock[];
  promptMarkdownByBlockId: Array<{ blockId: string; markdown: string }>;
};

export type UpdateLayoutCommand = PlanGraphCommandBase & {
  type: "updateLayout";
  layoutScope: "desktop" | "canvas";
  layout: unknown;
};

export type AddCanvasDependencyCommand = PlanGraphCommandBase & {
  type: "addCanvasDependency";
  fromCanvasId: string;
  toCanvasId: string;
};

export type RemoveCanvasDependencyCommand = PlanGraphCommandBase & {
  type: "removeCanvasDependency";
  fromCanvasId: string;
  toCanvasId: string;
};

export type AddCrossTaskDependencyCommand = PlanGraphCommandBase & {
  type: "addCrossTaskDependency";
  from: ProjectTaskRef;
  to: ProjectTaskRef;
};

export type RemoveCrossTaskDependencyCommand = PlanGraphCommandBase & {
  type: "removeCrossTaskDependency";
  from: ProjectTaskRef;
  to: ProjectTaskRef;
};

export type ProjectGraphCommand =
  | AddCanvasDependencyCommand
  | RemoveCanvasDependencyCommand
  | AddCrossTaskDependencyCommand
  | RemoveCrossTaskDependencyCommand;

export type PlanGraphCommand =
  | AddTaskDependencyCommand
  | RemoveTaskDependencyCommand
  | ReconnectTaskDependencyCommand
  | UpdateTaskPromptCommand
  | UpdateBlockPromptCommand
  | UpdateTaskFieldsCommand
  | UpdateBlockFieldsCommand
  | BulkUpdateBlocksCommand
  | BulkUpdateParallelPolicyCommand
  | AddTaskCommand
  | RemoveTaskCommand
  | RestoreTaskCommand
  | AddBlockCommand
  | RemoveBlockCommand
  | RestoreBlockCommand
  | UpdateReviewPipelineCommand
  | UpdateLayoutCommand
  | ProjectGraphCommand;

export type PlanGraphAffectedRefs = {
  canvases: string[];
  tasks: string[];
  blocks: string[];
  prompts: string[];
  packageFiles: string[];
};

export type AppliedPlanGraphCommand = {
  ok: true;
  workspaceRef: PackageWorkspaceRef;
  graphVersion: string;
  packageFingerprint: string;
  command: PlanGraphCommand;
  inverse: PlanGraphCommand | PlanGraphCommand[];
  affected: PlanGraphAffectedRefs;
  changedPaths: string[];
  diagnostics: [];
  operationId?: number;
};

export type FailedPlanGraphCommand = {
  ok: false;
  graphVersion?: string;
  packageFingerprint?: string;
  command: PlanGraphCommand;
  affected: PlanGraphAffectedRefs;
  changedPaths: [];
  diagnostics: PlanGraphCommandDiagnostic[];
};

export type PlanGraphCommandDiagnostic = {
  code: string;
  message: string;
  path?: string;
};

export type PlanGraphCommandResult = AppliedPlanGraphCommand | FailedPlanGraphCommand;

export function emptyAffectedRefs(): PlanGraphAffectedRefs {
  return { canvases: [], tasks: [], blocks: [], prompts: [], packageFiles: [] };
}

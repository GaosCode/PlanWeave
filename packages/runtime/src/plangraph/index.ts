export type {
  AddCanvasDependencyCommand,
  AddBlockCommand,
  AddCrossTaskDependencyCommand,
  AddTaskCommand,
  AddTaskDependencyCommand,
  AppliedPlanGraphCommand,
  BlockComponentSnapshot,
  FailedPlanGraphCommand,
  PlanGraphAffectedRefs,
  PlanGraphCommand,
  PlanGraphCommandDiagnostic,
  PlanGraphCommandResult,
  ProjectGraphCommand,
  ReconnectTaskDependencyCommand,
  RemoveBlockCommand,
  RemoveCanvasDependencyCommand,
  RemoveCrossTaskDependencyCommand,
  RemoveTaskCommand,
  RemoveTaskDependencyCommand,
  RestoreBlockCommand,
  RestoreTaskCommand,
  TaskComponentSnapshot,
  UpdateBlockFieldsCommand,
  UpdateBlockPromptCommand,
  UpdateReviewPipelineCommand,
  UpdateTaskFieldsCommand,
  UpdateLayoutCommand,
  UpdateTaskPromptCommand
} from "./commands.js";
export { emptyAffectedRefs } from "./commands.js";
export {
  parsePlanGraphCommand,
  parsePlanGraphCommandArrayOrSingle,
  planGraphCommandParseDiagnostic,
  planGraphCommandSchema
} from "./commandSchema.js";
export type {
  BlockRef,
  CanvasId,
  PlanGraph,
  PlanGraphBlockNode,
  PlanGraphEdge,
  PlanGraphProject,
  PlanGraphTaskNode,
  PromptIndexEntry,
  PromptRef,
  TaskId
} from "./domain/types.js";
export { buildPlanGraph } from "./domain/buildPlanGraph.js";
export {
  selectBlock,
  selectBlockedReason,
  selectCanvasTasks,
  selectClaimableTasks,
  selectDownstreamTasks,
  selectReviewReadyBlocks,
  selectTask,
  selectTaskBlocks,
  selectUpstreamTasks
} from "./domain/selectors.js";
export {
  executePlanGraphCommand,
  redoPlanGraphCommand,
  undoPlanGraphCommand
} from "./executeCommand.js";
export type { ExecutePlanGraphCommandOptions, PlanGraphHistoryOptions } from "./executeCommand.js";
export { loadPlanGraphPackage } from "./packageRepository.js";
export { buildPlanGraphViewProjection } from "./projections/graphViewProjection.js";
export type { PlanGraphViewProjection } from "./projections/graphViewProjection.js";
export {
  buildAgentClaimMarkdown,
  buildCanvasMapProjection,
  buildProjectExecutionPlanProjection,
  buildReviewProjection,
  buildStatisticsProjection,
  buildTodoGroupsFromContext,
  buildTodoProjection,
  emptyTodoGroups
} from "./projections/index.js";
export type {
  CanvasExecutionSnapshot,
  CanvasMapProjection,
  CanvasTodoRuntimeContext,
  ProjectTodoContext,
  ReviewProjection,
  ReviewProjectionItem,
  StatisticsProjection,
  TodoProjection,
  TodoProjectionInput
} from "./projections/index.js";
export { createSqlitePlanGraphStore, defaultPlanGraphIndexPath } from "./sqliteIndex.js";
export type {
  LoadPlanGraphResult,
  PlanGraphIndexStore,
  PlanGraphOperationLog,
  PlanGraphOperationLogEntry,
  PlanGraphProjectionVersion
} from "./ports.js";

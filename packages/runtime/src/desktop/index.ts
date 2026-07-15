export {
  getProjectOverview,
  initManagedProject,
  initOrOpenProject,
  linkProjectSourceRoot,
  listProjects,
  openProject,
  renameProject,
  removeProject,
  unlinkProjectSourceRoot
} from "./projectApi.js";
export {
  clearSourceDefaultProject,
  getSourceDefaultProject,
  listSourceDefaultProjectCandidates,
  resolveSourceDefaultProjectRoot,
  setSourceDefaultProject
} from "./sourceDefaultProject.js";
export type {
  SourceDefaultProjectCandidate,
  SourceDefaultProjectEntry
} from "./sourceDefaultProject.js";
export {
  archiveTaskCanvas,
  createProjectFromTaskCanvas,
  createTaskCanvas,
  duplicateTaskCanvas,
  getActiveTaskCanvasId,
  listTaskCanvases,
  renameTaskCanvas,
  removeTaskCanvas,
  resolveTaskCanvasWorkspace
} from "./canvasApi.js";
export type { ArchiveTaskCanvasOptions, ArchiveTaskCanvasResult } from "./canvasApi.js";
export { selectTaskCanvas } from "./canvasSelectionApi.js";
export {
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  resetCanvasMapLayout,
  saveCanvasMapLayout
} from "./canvasGraphApi.js";
export {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  bulkCreateBlocks,
  bulkCreateTasks,
  bulkRemoveGraphItems,
  bulkUpdateBlocks,
  createTaskDraft,
  bulkUpdateTasks,
  getBlockDetail,
  getDesktopProjectSnapshot,
  getGraphViewModel,
  getProjectExecutionPlan,
  getStatistics,
  getStatisticsProjection,
  getTaskDetail,
  getTaskFileManagerPath,
  getTaskExecutionOrder,
  getTodoGroups,
  removeBlock,
  removeDependencyEdge,
  removeTaskNode,
  reconnectDependencyEdge,
  redoDesktopPlanGraphCommand,
  searchProject,
  searchProjectWithDiagnostics,
  updateBlockDependencies,
  updateBlockExecutor,
  updateBlockFields,
  updateBlockPlanning,
  updateBlockPrompt,
  updateBlockTitle,
  bulkUpdateParallelPolicy,
  updateCanvasExecutionPolicy,
  updateTaskAcceptance,
  updateTaskExecutor,
  updateTaskFields,
  updateTaskPrompt,
  updateTaskTitle,
  undoDesktopPlanGraphCommand,
  validateGraphEdit
} from "./graphApi.js";
export {
  addCanvasDependency,
  addCrossTaskDependency,
  removeCanvasDependency,
  removeCrossTaskDependency
} from "./projectGraphEditApi.js";
export type { ProjectGraphEditResult } from "./projectGraphEditApi.js";
export type { CanvasExecutionPolicyInput } from "./graph/editModel.js";
export {
  readProjectPrompt,
  readProjectPromptPolicy,
  updateProjectPrompt,
  updateProjectPromptPolicy
} from "../projectPromptPolicy.js";
export type { ProjectPromptPolicy } from "../projectPromptPolicy.js";
export { getDesktopGraphDiagnostics } from "./diagnosticsApi.js";
export {
  desktopAgentCapabilityProbeResultSchema,
  probeDesktopAgentCapabilities
} from "./agentCapabilityApi.js";
export { listPendingImportRecoveries, rollbackPendingImportRecovery } from "./importRecoveryApi.js";
export {
  applyCanvasLaneLayout,
  getDesktopLayout,
  resetDesktopLayout,
  saveDesktopLayout
} from "./layoutApi.js";
export type { ApplyCanvasLaneLayoutOptions } from "./layoutApi.js";
export {
  createDesktopPackageFileSnapshot,
  detectDesktopPackageFileChanges,
  getDirtyPromptRefs,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges
} from "./fileSyncApi.js";
export {
  getAutoRunRetrospective,
  getLatestAutoRunRetrospective
} from "./autoRunRetrospectiveApi.js";
export { retryTaskWorkspaceRun } from "./taskWorkspaceActionsApi.js";
export {
  cancelDesktopAgentRun,
  getDesktopRuntimeRefresh,
  getAutoRunState,
  getLatestAutoRunSummary,
  getLatestAutoRunSummaryWithDiagnostics,
  listDesktopPendingAgentRequests,
  listAutoRunEvents,
  pauseAutoRun,
  resetDesktopRuntimeState,
  respondToDesktopAgentRequest,
  resumeAutoRun,
  shutdownDesktopAutoRuns,
  startAutoRun,
  stopAutoRun,
  subscribeAutoRunEvents
} from "./runApi.js";
export type {
  ActiveAgentRunActionIdentity,
  ActiveAgentRunSessionActionIdentity
} from "../autoRun/activeAgentRunRegistry.js";
export {
  desktopAgentActionIdentitySchema,
  desktopAgentSessionActionIdentitySchema,
  desktopAgentPromptIdentitySchema,
  desktopAgentPromptTextSchema,
  desktopAgentActionValueSchema,
  desktopRunnerRecordSubscriptionInputSchema,
  desktopRunnerRecordSubscriptionPushSchema
} from "./types/acpBridgeTypes.js";
export type * from "./types/acpBridgeTypes.js";
export {
  isFailedAutoRunTerminalPhase,
  isTerminalAutoRunPhase,
  tailAutoRunEvents,
  type AutoRunEventTailItem,
  type TailAutoRunEventsOptions
} from "./runEventTail.js";
export {
  autoRunNdjsonEventSchema,
  desktopAutoRunPhaseSchema,
  parseAutoRunNdjsonLine
} from "./autoRunEventSchema.js";
export { adaptLegacyDesktopRunnerEvents } from "./legacyRunnerEventAdapter.js";
export type {
  LegacyDesktopRunnerEventAdaptation,
  LegacyDesktopRunnerEventContext
} from "./legacyRunnerEventAdapter.js";
export {
  getFeedbackRecords,
  getReviewAttempts,
  getRunRecord,
  listBlockRunRecords,
  listTaskFeedbackRecords,
  listTaskFeedbackRunRecords,
  resolveRunRecordArtifactPath,
  sendAgentPrompt,
  subscribeRunRecord
} from "./recordsApi.js";
export {
  bulkApplyReviewPipeline,
  getReviewPipeline,
  updateReviewPipeline
} from "./reviewPipelineApi.js";
export { cloneDesktopGraphEditResult } from "./graphEditResult.js";
export { projectTaskWorkspaceRun } from "./taskWorkspaceRunProjection.js";
export {
  projectTaskWorkspaceClockSnapshot,
  projectTaskWorkspaceLiveSnapshot
} from "./taskWorkspaceLiveProjection.js";
export { getTaskWorkspace } from "./taskWorkspaceApi.js";
export {
  TASK_WORKSPACE_RESUME_UNAVAILABLE_REASON,
  TASK_WORKSPACE_RETRY_UNAVAILABLE_REASON,
  TASK_WORKSPACE_RUN_TOKENS_UNAVAILABLE_REASON,
  TASK_WORKSPACE_TASK_TOKENS_UNAVAILABLE_REASON,
  taskWorkspaceCancelCapabilitySchema,
  taskWorkspaceContextUsageSnapshotSchema,
  taskWorkspacePromptCapabilitySchema,
  taskWorkspaceRetryCapabilitySchema,
  taskWorkspaceRetryIdentitySchema,
  taskWorkspaceRunCapabilitiesSchema,
  taskWorkspaceRunDurationSchema,
  taskWorkspaceRunMetadataSchema,
  taskWorkspaceRunRecordIdentitySchema,
  taskWorkspaceRunSchema,
  taskWorkspaceRunUsageSchema,
  taskWorkspaceUnavailableTokenAccountingSchema
} from "./types/taskWorkspaceTypes.js";
export {
  TASK_WORKSPACE_TASK_COST_UNAVAILABLE_REASON,
  taskWorkspaceAgentTimeSchema,
  taskWorkspaceAnnotationSchema,
  taskWorkspaceBlockSchema,
  taskWorkspaceCostAccountingSchema,
  taskWorkspaceDependencyProgressSchema,
  taskWorkspaceInputSchema,
  taskWorkspaceLatestArtifactSchema,
  taskWorkspaceRunItemSchema,
  taskWorkspaceSchema,
  taskWorkspaceWaitingInteractionSchema,
  taskWorkspaceWallClockSchema
} from "./types/taskWorkspaceAggregateTypes.js";
export type * from "./types.js";

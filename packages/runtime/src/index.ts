export { PlanWeaveWorkspaceNotInitializedError } from "./errors.js";
export { readProjectPaths, resolvePlanweaveHome } from "./paths.js";
export { createManagedProjectId, createProjectId } from "./projectId.js";
export { normalizeProjectMetadata, projectWorkspacePaths, readProject, requireInitializedProjectWorkspace, resolveProjectWorkspace } from "./project.js";
export { readProjectPrompt, readProjectPromptPolicy, updateProjectPrompt, updateProjectPromptPolicy } from "./projectPromptPolicy.js";
export type { ProjectPromptPolicy } from "./projectPromptPolicy.js";
export { initManagedWorkspace, initWorkspace } from "./initWorkspace.js";
export { linkProjectSourceRoot, unlinkProjectSourceRoot } from "./desktop/projectApi.js";
export { manifestNodeSchema, manifestSchema, manifestSchemaTopLevelFields } from "./schema/manifest.js";
export {
  manifestSchemaDocument,
  layoutSchemaDocument,
  projectSchemaDocument,
  stateSchemaDocument,
  runtimeSchemaDocuments,
  runtimeSchemaTopicOrder
} from "./schemaDocs/index.js";
export { loadPackage } from "./package/loadPackage.js";
export { editBlock, editTask } from "./package/manifestEdit.js";
export { readMarkdown } from "./package/readMarkdown.js";
export { resolvePackagePath, PackagePathError } from "./package/resolvePackagePath.js";
export { parsePromptSections, getPromptSection, hasUserSection, replacePromptSection } from "./prompt/sections.js";
export { renderManagedSections } from "./prompt/renderManagedSections.js";
export { refreshPrompt } from "./prompt/refreshPrompt.js";
export { refreshPrompts } from "./prompt/refreshPrompts.js";
export { getPrompt } from "./prompt/getPrompt.js";
export { validatePackage } from "./validatePackage.js";
export { summarizeValidationReport } from "./validation/validationSummary.js";
export { compileTaskGraph } from "./graph/compileTaskGraph.js";
export { parseBlockRef } from "./graph/compileTaskGraph.js";
export { compilePackageGraph } from "./graph/compileTaskGraph.js";
export { inspectGraph } from "./graph/inspectGraph.js";
export { validateGraphQuality } from "./graph/validateGraphQuality.js";
export { validateExecutionReadiness } from "./graph/executionReadiness.js";
export {
  bulkAddTaskDependencies,
  bulkSetBlockDependencies,
  bulkSetTaskDependencies,
  setTaskDependencies
} from "./graph/dependencyEdit.js";
export type { BlockDependencyUpdate, TaskDependencyInput } from "./graph/dependencyEdit.js";
export {
  getPromptSources,
  listPackageFiles,
  readPackageFile,
  readPromptSource,
  readRenderedPrompt
} from "./package/boundedContent.js";
export {
  applyPackageDraftImport,
  previewPackageDraftImport,
  validatePackageDraft
} from "./package/packageDraftImport.js";
export {
  listPendingImportTransactions,
  rollbackPendingImportTransaction
} from "./package/importRecovery.js";
export type {
  PackageDraftCanvasReport,
  PackageDraftFileDiff,
  PackageDraftImportApplyResult,
  PackageDraftImportPreview,
  PackageDraftMode,
  PackageDraftValidationResult
} from "./package/packageDraftImport.js";
export type { PendingImportTransaction } from "./package/importRecovery.js";
export {
  compileProjectGraph,
  createCanvasWorkspace,
  applyDefaultCanvasWorkspaceMigration,
  detectDefaultCanvasWorkspaceMigration,
  defaultCanvasProjectGraph,
  loadProjectGraph,
  loadProjectGraphForWorkspace,
  materializeProjectGraph,
  projectGraphFromLegacyRegistry,
  projectCanvasWorkspace,
  projectGraphPath,
  projectGraphManifestSchema,
  projectGraphManifestSchemaTopLevelFields,
  projectGraphSchema,
  resolveProjectCanvasWorkspace,
  writeProjectGraph
} from "./projectGraph/index.js";
export type { CreateCanvasWorkspaceOptions, CreateCanvasWorkspaceResult } from "./projectGraph/index.js";
export {
  addEdge,
  addNode,
  affectedTasksForPackageFileChange,
  removeEdge,
  removeNode,
  updateNode,
  updatePromptSurface
} from "./graph/editGraph.js";
export {
  createPackageFileSnapshot,
  detectPackageFileChanges,
  refreshChangedPackagePrompts
} from "./package/fileChanges.js";
export type { PackageFileSyncResult, PromptRefreshStats } from "./package/fileChanges.js";
export {
  createExecutionGraphSession,
  drainGraphReadQueue,
  enqueueGraphEditOperations,
  enqueuePackageFileChanges
} from "./graph/session.js";
export {
  createSqlitePlanGraphStore,
  defaultPlanGraphIndexPath,
  emptyAffectedRefs,
  buildAgentClaimMarkdown,
  buildCanvasMapProjection,
  buildPlanGraphViewProjection,
  buildProjectExecutionPlanProjection,
  buildReviewProjection,
  buildStatisticsProjection,
  buildTodoGroupsFromContext,
  buildTodoProjection,
  emptyTodoGroups as emptyPlanGraphTodoGroups,
  executePlanGraphCommand,
  loadPlanGraphPackage,
  redoPlanGraphCommand,
  selectBlock,
  selectBlockedReason,
  selectCanvasTasks,
  selectClaimableTasks,
  selectDownstreamTasks,
  selectReviewReadyBlocks,
  selectTask,
  selectTaskBlocks,
  selectUpstreamTasks,
  undoPlanGraphCommand
} from "./plangraph/index.js";
export { consumeAutoRunClaim } from "./autoRun/contract.js";
export type { AutoRunDecision, AutoRunExecutorAdapter } from "./autoRun/contract.js";
export {
  createCodexExecAdapter,
  createClaudeCodeExecAdapter,
  createExecutorAdapter,
  createLocalReviewAdapter,
  createManualExecutorAdapter,
  createOpencodeExecAdapter,
  createPiExecAdapter,
  listExecutorProfiles,
  testExecutorProfile
} from "./autoRun/executors.js";
export {
  claimNext,
  claimBlock,
  claimBlockType,
  claimTask,
  explainBlock,
  getCurrentWork,
  runDoctor,
  runProjectDoctor,
  renderPrompt,
  submitBlockResult,
  submitReviewResult,
  submitFeedback,
  markBlockBlocked,
  markBlockDiverged,
  retryReview,
  unblockBlock,
  resolveBlockDivergence,
  getExecutionStatus
} from "./taskManager/index.js";
export { getAutoRunStatus, runAutoRunStep } from "./taskManager/autoRun.js";
export type { PromptSourceSummary } from "./taskManager/promptRenderer.js";
export { appendRunSessionEvent, createRunSession, getRunSession, listRunSessions, resetRuntimeState, runWithSession, updateRunSession } from "./runSessions/index.js";
export { isTmuxAvailable } from "./autoRun/tmuxExecutor.js";
export {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  applyCanvasLaneLayout,
  bulkCreateBlocks,
  bulkCreateTasks,
  bulkRemoveGraphItems,
  bulkUpdateBlocks,
  bulkUpdateTasks,
  createDesktopPackageFileSnapshot,
  createProjectFromTaskCanvas,
  createTaskCanvas,
  createTaskDraft,
  detectDesktopPackageFileChanges,
  duplicateTaskCanvas,
  getBlockDetail,
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  getDesktopGraphDiagnostics,
  getDesktopLayout,
  getDesktopProjectSnapshot,
  getDirtyPromptRefs,
  getFeedbackRecords,
  getGraphViewModel,
  getProjectOverview,
  getProjectExecutionPlan,
  getReviewAttempts,
  getReviewPipeline,
  getRunRecord,
  getStatistics,
  getTaskDetail,
  getTaskExecutionOrder,
  getTodoGroups,
  getAutoRunRetrospective,
  getAutoRunState,
  getDesktopRuntimeRefresh,
  getLatestAutoRunRetrospective,
  getLatestAutoRunSummary,
  getLatestAutoRunSummaryWithDiagnostics,
  listAutoRunEvents,
  initManagedProject,
  initOrOpenProject,
  listTaskCanvases,
  listProjects,
  clearSourceDefaultProject,
  getSourceDefaultProject,
  listSourceDefaultProjectCandidates,
  listBlockRunRecords,
  listPendingImportRecoveries,
  openProject,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges,
  resolveTaskCanvasWorkspace,
  addCanvasDependency,
  addCrossTaskDependency,
  renameProject,
  renameTaskCanvas,
  removeBlock,
  removeTaskCanvas,
  removeDependencyEdge,
  reconnectDependencyEdge,
  redoDesktopPlanGraphCommand,
  removeCanvasDependency,
  removeCrossTaskDependency,
  removeProject,
  removeTaskNode,
  pauseAutoRun,
  resetDesktopRuntimeState,
  resumeAutoRun,
  rollbackPendingImportRecovery,
  resetCanvasMapLayout,
  resetDesktopLayout,
  resolveSourceDefaultProjectRoot,
  saveCanvasMapLayout,
  saveDesktopLayout,
  searchProject,
  searchProjectWithDiagnostics,
  selectTaskCanvas,
  setSourceDefaultProject,
  startAutoRun,
  stopAutoRun,
  subscribeAutoRunEvents,
  updateBlockDependencies,
  updateBlockExecutor,
  updateBlockFields,
  updateBlockPlanning,
  updateBlockPrompt,
  updateBlockTitle,
  bulkUpdateParallelPolicy,
  updateCanvasExecutionPolicy,
  cloneDesktopGraphEditResult,
  updateTaskAcceptance,
  updateTaskExecutor,
  updateTaskFields,
  updateTaskPrompt,
  updateTaskTitle,
  undoDesktopPlanGraphCommand,
  updateReviewPipeline,
  bulkApplyReviewPipeline,
  validateGraphEdit
} from "./desktop/index.js";
export { edgeTypes, executorAdapters, reviewTriggerConditions, runSubmitStatuses, reviewStatuses } from "./types.js";
export {
  isGitRepo,
  gitExec,
  GitError,
  getStatus,
  getDiff,
  getLog,
  hasUncommittedChanges,
  hasStagedChanges,
  stageFiles,
  stageAll,
  commit,
  getBranches,
  getCurrentBranch,
  createBranch,
  checkout,
  getRemotes,
  getRepoInfo,
  parseGitHubRemote,
  push,
  pull,
  fetch,
} from "./git/index.js";
export type {
  FileStatus,
  GitStatus,
  GitCommit,
  GitBranch,
  GitDiffHunk,
  GitDiffResult,
  GitRemote,
  GitRepoInfo,
  GitCommitResult,
  GitPushPullResult,
} from "./git/index.js";
export type { SourceDefaultProjectCandidate, SourceDefaultProjectEntry } from "./desktop/sourceDefaultProject.js";
export {
  projectGraphCanvasNodeTypes,
  projectGraphEdgeTypes,
  projectGraphNodeTypes,
  projectGraphVersion,
  supportedProjectGraphVersion
} from "./projectGraph/index.js";
export type * from "./desktop/index.js";
export type * from "./runSessions/index.js";
export type * from "./autoRun/executorPreflightTypes.js";
export type * from "./plangraph/index.js";
export type * from "./projectGraph/index.js";
export type * from "./schemaDocs/index.js";
export type * from "./types.js";

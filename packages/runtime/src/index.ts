export { PlanWeaveWorkspaceNotInitializedError } from "./errors.js";
export { readProjectPaths, resolvePlanweaveHome } from "./paths.js";
export { createManagedProjectId, createProjectId } from "./projectId.js";
export {
  shutdownActiveAgentRuns,
  shutdownDesktopAgentRun
} from "./autoRun/activeAgentRunRegistry.js";
export {
  normalizeProjectMetadata,
  projectWorkspacePaths,
  readProject,
  requireInitializedProjectWorkspace,
  resolveProjectWorkspace
} from "./project.js";
export {
  readProjectPrompt,
  readProjectPromptPolicy,
  updateProjectPrompt,
  updateProjectPromptPolicy
} from "./projectPromptPolicy.js";
export type { ProjectPromptPolicy } from "./projectPromptPolicy.js";
export { initManagedWorkspace, initWorkspace } from "./initWorkspace.js";
export { linkProjectSourceRoot, unlinkProjectSourceRoot } from "./desktop/projectApi.js";
export {
  EXCLUSIVE_LOCK,
  PARALLEL_SAFE_DEPRECATION_MESSAGE,
  manifestNodeSchema,
  manifestSchema,
  manifestSchemaTopLevelFields
} from "./schema/manifest.js";
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
export {
  exportCanvasPackageFiles,
  packageFileEntrySchema,
  readPackageFiles,
  replacePackageFiles,
  safePackageFilePath,
  toArchivePath
} from "./package/packageFiles.js";
export type { PackageFileEntry } from "./package/packageFiles.js";
export {
  parsePromptSections,
  getPromptSection,
  hasUserSection,
  replacePromptSection
} from "./prompt/sections.js";
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
export type {
  CreateCanvasWorkspaceOptions,
  CreateCanvasWorkspaceResult
} from "./projectGraph/index.js";
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
  resolveExecutorRunnerEvidence,
  testExecutorProfile
} from "./autoRun/executors.js";
export {
  executorIntegrationForProfile,
  requireExecutorIntegration
} from "./autoRun/agentRegistry.js";
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
  getExecutionStatus,
  commandFingerprint,
  isCommandTrusted,
  listTrustedCommands,
  trustCommand
} from "./taskManager/index.js";
export type { TrustedCommand, TrustedCommandsFile } from "./taskManager/index.js";
export { getAutoRunStatus, runAutoRunStep } from "./taskManager/autoRun.js";
export type { PromptSourceSummary } from "./taskManager/promptRenderer.js";
export {
  RETENTION_DOCTOR_THRESHOLD,
  appendRunSessionEvent,
  applyPrunePlan,
  computePrunePlan,
  countRetentionArtifacts,
  createRunSession,
  getRunSession,
  isPathInsideResultsDir,
  isPrunableArtifactPath,
  listRunSessions,
  resetRuntimeState,
  runWithSession,
  updateRunSession
} from "./runSessions/index.js";
export type {
  ApplyPrunePlanResult,
  ComputePrunePlanOptions,
  PrunePlan,
  PrunePlanItem,
  PrunePlanItemKind
} from "./runSessions/index.js";
export { isTmuxAvailable } from "./autoRun/tmuxExecutor.js";
export {
  acpCorrelationSchema,
  acpRequestIdSchema,
  acpSessionIdSchema,
  artifactReferenceSchema,
  canvasIdSchema,
  claimRefSchema,
  desktopRunIdSchema,
  executorRunIdSchema,
  jsonRpcCorrelationIdSchema,
  negotiatedCapabilitiesSchema,
  pendingInteractionKindSchema,
  persistedPendingInteractionSchema,
  projectIdSchema,
  runnerCapabilitySchema,
  runnerContractVersionSchema,
  runnerIdentitySchema,
  runnerLifecycleStateSchema,
  runnerNonterminalStateSchema,
  runnerRunIdSchema,
  runnerRunIdentitySchema,
  runnerRequestActionIdentitySchema,
  runnerSessionActionIdentitySchema,
  runnerTerminalStateSchema,
  runSessionIdSchema,
  taskIdSchema,
  blockIdSchema,
  terminalOutcomeSchema
} from "./autoRun/runnerContractSchemas.js";
export type * from "./autoRun/runnerContractSchemas.js";
export {
  RUNNER_EVENT_MAX_LINE_BYTES,
  RUNNER_EVENT_MAX_MESSAGE_BYTES,
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  RUNNER_EVENT_RETENTION_MAX_EVENTS,
  encodeNormalizedRunnerEvent,
  normalizedDiagnosticBody,
  normalizedOutputBody,
  normalizedRedactedContent,
  normalizedRunnerEventSchema,
  redactRunnerEventText,
  redactionClassSchema,
  runnerDiagnosticCodeSchema
} from "./autoRun/normalizedEventContract.js";
export type * from "./autoRun/normalizedEventContract.js";
export {
  replayNormalizedRunnerEvents,
  runnerEventCursorSchema
} from "./autoRun/runnerEventReplay.js";
export type * from "./autoRun/runnerEventReplay.js";
export { normalizeAcpSessionNotification } from "./autoRun/acpEventNormalization.js";
export type * from "./autoRun/acpEventNormalization.js";
export { AcpEventPublisher } from "./autoRun/acpEventPublisher.js";
export type * from "./autoRun/acpEventPublisher.js";
export { AcpEventStore } from "./autoRun/acpEventStore.js";
export type * from "./autoRun/acpEventStore.js";
export { AcpEventReadModel, AcpEventReadModelRegistry, acpEventReadModels } from "./autoRun/acpEventReadModel.js";
export type * from "./autoRun/acpEventReadModel.js";
export {
  consumeRunnerRecordReadModel,
  readRunnerRecordReadModel,
  readRunnerRecordReadModelForArtifact,
  runnerRecordReadModelSchema
} from "./autoRun/runnerRecordReadModel.js";
export type * from "./autoRun/runnerRecordReadModel.js";
export {
  acpTimelineItemSchema,
  projectAcpConversation,
  projectAcpTimeline
} from "./autoRun/acpConversationProjection.js";
export type * from "./autoRun/acpConversationProjection.js";
export { writeAcpConversationProjection } from "./autoRun/acpConversationPersistence.js";
export {
  ArtifactReferenceVerificationError,
  RUNNER_ARTIFACT_MAX_CONTENT_BYTES,
  createArtifactReference,
  verifyArtifactReference
} from "./autoRun/artifactReferenceContract.js";
export {
  executeRunnerLifecycleTransition,
  transitionRunnerLifecycle
} from "./autoRun/runnerLifecycle.js";
export type * from "./autoRun/runnerLifecycle.js";
export {
  FINAL_ARTIFACT_MARKER,
  FINAL_ARTIFACT_MAX_CONTENT_BYTES,
  FINAL_ARTIFACT_MAX_LINE_BYTES,
  FinalArtifactContractError,
  encodeFinalArtifactEnvelope,
  extractFinalArtifactEnvelope,
  feedbackArtifactEnvelope,
  finalArtifactEnvelopeSchema,
  implementationArtifactEnvelope,
  materializeFinalArtifact,
  reviewArtifactEnvelope,
  validateFinalArtifactEnvelope
} from "./autoRun/finalArtifactContract.js";
export type * from "./autoRun/finalArtifactContract.js";
export { reviewResultSchema } from "./taskManager/reviewResultContract.js";
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
  getTaskFileManagerPath,
  getTaskExecutionOrder,
  getTodoGroups,
  getAutoRunRetrospective,
  getAutoRunState,
  getDesktopRuntimeRefresh,
  getLatestAutoRunRetrospective,
  getLatestAutoRunSummary,
  getLatestAutoRunSummaryWithDiagnostics,
  listDesktopPendingAgentRequests,
  listAutoRunEvents,
  tailAutoRunEvents,
  isFailedAutoRunTerminalPhase,
  isTerminalAutoRunPhase,
  parseAutoRunNdjsonLine,
  autoRunNdjsonEventSchema,
  desktopAutoRunPhaseSchema,
  archiveTaskCanvas,
  getActiveTaskCanvasId,
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
  cancelDesktopAgentRun,
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
  respondToDesktopAgentRequest,
  rollbackPendingImportRecovery,
  resetCanvasMapLayout,
  resetDesktopLayout,
  resolveRunRecordArtifactPath,
  resolveSourceDefaultProjectRoot,
  saveCanvasMapLayout,
  saveDesktopLayout,
  searchProject,
  searchProjectWithDiagnostics,
  selectTaskCanvas,
  setSourceDefaultProject,
  shutdownDesktopAutoRuns,
  startAutoRun,
  stopAutoRun,
  sendAgentPrompt,
  subscribeRunRecord,
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
export {
  desktopAgentActionIdentitySchema,
  desktopAgentPromptIdentitySchema,
  desktopAgentPromptTextSchema,
  desktopAgentSessionActionIdentitySchema,
  desktopAgentActionValueSchema,
  desktopRunnerRecordSubscriptionInputSchema,
  desktopRunnerRecordSubscriptionPushSchema
} from "./desktop/types/acpBridgeTypes.js";
export {
  acpRunnerSchema,
  agentFamilySchema,
  cliRunnerSchema,
  edgeTypes,
  executorAdapter,
  executorAdapters,
  executorIntegration,
  executorIntegrationSchema,
  executorIntegrations,
  executorProfileAdapterSchema,
  executorProfileSchema,
  executorRuntimeLimitsSchema,
  reviewTriggerConditions,
  runnerTransportSchema,
  runSubmitStatuses,
  reviewStatuses
} from "./types.js";
export type {
  SourceDefaultProjectCandidate,
  SourceDefaultProjectEntry
} from "./desktop/sourceDefaultProject.js";
export type { AutoRunEventTailItem, TailAutoRunEventsOptions } from "./desktop/runEventTail.js";
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

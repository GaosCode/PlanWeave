export { PlanWeaveWorkspaceNotInitializedError } from "./errors.js";
export {
  createHostProcessTreeAdapter,
  spawnManagedProcess
} from "./process/managedProcessTree.js";
export type {
  ManagedChildProcess,
  ManagedProcessTree,
  ProcessTerminationResult,
  SpawnManagedProcessOptions,
  WindowsJobLaunchStrategy
} from "./process/managedProcessTree.js";
export {
  quoteWindowsCmdArgument,
  resolveWindowsCommand,
  resolveWindowsProcessInvocation,
  windowsBatchCommandLine
} from "./process/windowsManagedProcess.js";
export type {
  ResolvedWindowsCommand,
  WindowsProcessInvocation
} from "./process/windowsManagedProcess.js";
export {
  AgentEnvironmentMissingError,
  agentProcessEnv,
  agentProcessEnvRecord,
  agentProcessPath,
  resolveCurrentAgentProcessEnvironment,
  resolveAgentProcessEnvironment,
  setAgentProcessEnvironmentOverlay
} from "./process/agentProcessEnv.js";
export type {
  AgentProcessPathOptions,
  ResolvedAgentEnvironment
} from "./process/agentProcessEnv.js";
export {
  acpAgentIdSchema,
  acpCapabilityPolicySchema,
  acpConnectionPolicySchema,
  acpEnvironmentRequirementSchema,
  acpEnvironmentRequirementsSchema,
  acpProfileCatalogSchema,
  acpProfileCanonicalKey,
  acpProfileDescriptorSchema,
  acpProfileIdSchema,
  acpSessionDefaultsSchema,
  acpShutdownPolicyFromLegacyGraceMs,
  acpShutdownPolicySchema,
  agentEnvironmentContractSchema,
  agentEnvironmentNameSchema,
  emptyAcpProfileCatalog,
  forbiddenAgentEnvironmentNames
} from "./acpProfile/schema.js";
export type {
  AcpCapabilityPolicy,
  AcpConnectionPolicy,
  AcpEnvironmentRequirement,
  AcpProfileCatalog,
  AcpProfileDescriptor,
  AcpSessionDefaults,
  AcpShutdownPolicy,
  AgentEnvironmentContract
} from "./acpProfile/schema.js";
export {
  AcpProfileAlreadyExistsError,
  AcpProfileNotFoundError,
  AcpProfileRevisionConflictError,
  AcpProfileStore,
  acpProfileStoreLockValuesSchema,
  defaultAcpProfileCatalogPath
} from "./acpProfile/store.js";
export type {
  AcpProfileStoreLockOptions,
  AcpProfileStoreLockValues,
  AcpProfileStoreOptions
} from "./acpProfile/store.js";
export {
  AcpProfileResolutionError,
  builtinAcpProfileCatalog,
  CatalogAcpProfileResolver,
  ExecutionHostAcpCommandResolver,
  NativeAcpHostCommandResolver
} from "./acpProfile/resolver.js";
export type { AcpProfileResolutionErrorCode } from "./acpProfile/resolver.js";
export { AcpProfileManager } from "./acpProfile/management.js";
export {
  createRuntimeAcpProfileResolver,
  resolveAcpExecutionProfile
} from "./acpProfile/runtimeResolver.js";
export type { ResolvedAcpExecutionProfile } from "./acpProfile/runtimeResolver.js";
export type {
  AcpHostCommandResolver,
  AcpLocalProfileTrustVerifier,
  AcpProfileReference,
  AcpProfileResolutionContext,
  AcpProfileResolver,
  ResolvedAcpProfile
} from "./acpProfile/resolver.js";
export {
  availableExecutionHostEnvironmentVariables,
  decodeCommandOutput,
  listWslDistributions,
  mapWindowsPathToWsl,
  prepareExecutionHostInvocation,
  prepareWslProcessInvocation,
  readWslLoginPath,
  resolveWslExecutable,
  wslLauncherEnvironment
} from "./process/wslExecutionHost.js";
export type {
  PreparedExecutionHostInvocation,
  PreparedWslProcessInvocation,
  WslCommandOutput,
  WslCommandRunner,
  WslDistributionsResult,
  WslExecutionOptions
} from "./process/wslExecutionHost.js";
export { readProjectPaths, resolvePlanweaveHome } from "./paths.js";
export { readGlobalPrompt, updateGlobalPrompt } from "./globalPrompt.js";
export { createManagedProjectId, createProjectId } from "./projectId.js";
export {
  builtinExecutorNames,
  canonicalBuiltinExecutorName,
  isBuiltinExecutorName
} from "./executorNames.js";
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
  manifestNodeSchema,
  manifestSchema,
  manifestSchemaTopLevelFields
} from "./schema/manifest.js";
export { remoteBlockExecutionReadModelSchema } from "./schema/remoteExecutionReadModel.js";
export type { RemoteBlockExecutionReadModel } from "./schema/remoteExecutionReadModel.js";
export {
  manifestSchemaDocument,
  layoutSchemaDocument,
  projectSchemaDocument,
  stateSchemaDocument,
  runtimeSchemaDocuments,
  runtimeSchemaTopicOrder
} from "./schemaDocs/index.js";
export { loadPackage } from "./package/loadPackage.js";
export {
  createManagedProjectFromAuthoritativeContent,
  materializeAuthoritativeCanvasContent,
  planManagedProjectFromAuthoritativeContent
} from "./desktop/contentVersionMaterializer.js";
export { validateAuthoritativeCanvasContent } from "./desktop/contentVersionValidation.js";
export type { ValidatedAuthoritativeCanvasContent } from "./desktop/contentVersionValidation.js";
export {
  readAuthorizedCanvasRuntimeStatus,
  type ReadAuthorizedCanvasRuntimeStatusInput
} from "./desktop/canvasRuntimeStatus.js";
export { migrateBlockRunIndexes } from "./autoRun/blockRunIndex.js";
export { editBlock, editTask } from "./package/manifestEdit.js";
export { readMarkdown } from "./package/readMarkdown.js";
export { resolvePackagePath, PackagePathError } from "./package/resolvePackagePath.js";
export {
  capturePackageSnapshot,
  restorePackageSnapshot,
  type CapturePackageSnapshotResult,
  type CapturedPackageSnapshot,
  type PackageSnapshotFile
} from "./package/packageSnapshot.js";
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
  createProjectCanvas,
  duplicateProjectCanvas,
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
  CreateCanvasWorkspaceResult,
  CreateProjectCanvasInput,
  DuplicateProjectCanvasInput,
  ProjectCanvasMutationResult
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
  applyAuthorizedCanvasCommand,
  contentDigestFromManifest,
  readAuthorizedCanvasContentDigest,
  type ApplyAuthorizedCanvasCommandFailure,
  type ApplyAuthorizedCanvasCommandInput,
  type ApplyAuthorizedCanvasCommandResult,
  type ApplyAuthorizedCanvasCommandSuccess
} from "./graph/canvasCommandPort.js";
export {
  applyCanvasReplicaIntent,
  canvasReplicaDocumentSchemaVersion,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument,
  overlayCanvasReplicaRuntimeStatus,
  parseCanvasReplicaDocument,
  projectCanvasReplicaDocument,
  type CanvasReplicaGraphContent,
  type CanvasReplicaDocument
} from "./canvasReplica/index.js";
export {
  captureAuthorizedCanvasContent,
  type CapturedAuthorizedCanvasContent
} from "./desktop/authorizedCanvasContent.js";
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
  createGrokExecAdapter,
  createLocalReviewAdapter,
  createManualExecutorAdapter,
  createOpencodeExecAdapter,
  createPiExecAdapter,
  inspectExecutorAcpProfile,
  listExecutorProfiles,
  resolveExecutorRunnerEvidence,
  testExecutorProfile
} from "./autoRun/executors.js";
export {
  desktopAgentCapabilityProbeResultSchema,
  probeDesktopAgentCapabilities
} from "./desktop/agentCapabilityApi.js";
export {
  executorIntegrationForProfile,
  requireExecutorIntegration
} from "./autoRun/agentRegistry.js";
export {
  claimNext,
  claimDispatchedBlock,
  claimBlock,
  claimBlockType,
  claimTask,
  explainBlock,
  getCurrentWork,
  runDoctor,
  runProjectDoctor,
  renderPrompt,
  createRemoteBlockRuntimePort,
  RemoteOwnershipConflictError,
  createRemoteBlockArtifactSource,
  submitBlockResult,
  submitBlockResultFromBytes,
  submitReviewResult,
  submitFeedback,
  markBlockBlocked,
  markBlockDiverged,
  retryReview,
  unblockBlock,
  resolveBlockDivergence,
  getExecutionStatus,
  projectRemoteBlockExecution,
  commandFingerprint,
  isCommandTrusted,
  listTrustedCommands,
  trustCommand
} from "./taskManager/index.js";
export {
  remoteBlockActiveIdentitySchema,
  remoteBlockBindingViewSchema,
  remoteBlockClaimInputSchema,
  remoteBlockCompletionInputSchema,
  remoteBlockCompletionResultSchema,
  remoteBlockDispatchCandidateSchema,
  remoteBlockFailureInputSchema,
  remoteBlockInspectInputSchema,
  remoteBlockInterruptionInputSchema,
  remoteBlockMutationResultSchema,
  remoteBlockOperationQuerySchema,
  publicRemoteFailureSchema,
  remoteBlockRefIdentitySchema,
  remoteBlockRetryAttemptInputSchema,
  remoteBlockRetryDecisionSchema,
  remoteBlockArtifactReadInputSchema,
  verifiedRemoteBlockArtifactSchema,
  RemoteBlockRuntimeError
} from "./taskManager/index.js";
export type {
  RemoteBlockActiveIdentity,
  RemoteBlockBindingView,
  RemoteBlockClaimInput,
  RemoteBlockCompletionInput,
  RemoteBlockCompletionResult,
  RemoteBlockDispatchCandidate,
  RemoteBlockFailureInput,
  RemoteBlockInspectInput,
  RemoteBlockInterruptionInput,
  RemoteBlockMutationResult,
  RemoteBlockOperationQuery,
  RemoteBlockRefIdentity,
  RemoteBlockRetryAttemptInput,
  RemoteBlockRetryDecision,
  RemoteBlockRuntimeErrorCode,
  RemoteBlockRuntimePort,
  RemoteOwnershipConflictCode,
  RemoteBlockArtifactReadInput,
  RemoteBlockArtifactSource,
  VerifiedRemoteBlockArtifact,
  TrustedCommand,
  TrustedCommandsFile
} from "./taskManager/index.js";
export { getAutoRunStatus, runAutoRunStep } from "./taskManager/autoRun.js";
export type { PromptSourceSummary } from "./taskManager/promptContracts.js";
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
  executionWaveIdSchema,
  executorRunIdSchema,
  jsonRpcCorrelationIdSchema,
  negotiatedCapabilitiesSchema,
  pendingInteractionKindSchema,
  persistedPendingInteractionSchema,
  projectIdSchema,
  runnerCapabilitySchema,
  runnerAuthenticationActionRequiredSchema,
  runnerAuthenticationAuthenticatedSchema,
  runnerAuthenticationNotAdvertisedSchema,
  runnerAuthenticationStateSchema,
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
  AGENT_RUN_CONTROL_DEFAULT_CLIENT_TIMEOUT_MS,
  AgentRunControlClient
} from "./autoRun/agentRunControlClient.js";
export type * from "./autoRun/agentRunControlClient.js";
export {
  AGENT_RUN_CONTROL_MAX_FOLLOW_UP_BYTES,
  AGENT_RUN_CONTROL_MAX_FRAME_BYTES,
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlActionSchema,
  agentRunControlCommandIdSchema,
  agentRunControlCommandSchema,
  agentRunControlEndpointDescriptorSchema,
  agentRunControlErrorCodeSchema,
  agentRunControlErrorResponseSchema,
  agentRunControlLeaseIdSchema,
  agentRunControlReceiptResultSchema,
  agentRunControlRespondOutcomeSchema,
  agentRunControlResponseSchema,
  agentRunControlSuccessReceiptSchema
} from "./autoRun/agentRunControlContract.js";
export type * from "./autoRun/agentRunControlContract.js";
export { AgentRunControlLocator } from "./autoRun/agentRunControlLocator.js";
export type * from "./autoRun/agentRunControlLocator.js";
export {
  RUNNER_EVENT_MAX_ENCODED_BYTES,
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
export {
  acpAuthMethodIdSchema,
  acpAuthenticationActionReasonSchema,
  acpAuthenticationHintsSchema,
  acpAuthMethodSummarySchema,
  acpAuthMethodSummariesSchema,
  acpAuthenticationPlanSchema,
  acpAuthenticationOutcomeSchema,
  normalizeAcpAuthMethods,
  planAcpAuthentication,
  hasAdvertisedAcpAuthenticationMethods,
  coordinateAcpAuthentication,
  planWeaveAcpExecutionAuthentication
} from "./autoRun/acpAuthentication.js";
export type * from "./autoRun/acpAuthentication.js";
export { AcpEventPublisher } from "./autoRun/acpEventPublisher.js";
export type * from "./autoRun/acpEventPublisher.js";
export { AcpEventStore } from "./autoRun/acpEventStore.js";
export type * from "./autoRun/acpEventStore.js";
export {
  createDefaultAcpEventRetentionPolicy,
  projectPersistedRetentionDiagnostics,
  type AcpEventRetentionPolicy,
  type AcpEventAdmissionDecision,
  type AcpBoundaryAdmissionDecision,
  type AcpProtocolAdmissionDecision,
  type AcpRetentionBudgetSnapshot,
  type AcpEventRetentionPolicyOverrides,
  ACP_EVENT_RETENTION_RESERVE_BYTES,
  ACP_EVENT_RETENTION_RESERVE_EVENTS,
  ACP_PROTOCOL_RETENTION_RESERVE_BYTES
} from "./autoRun/acpEventRetentionPolicy.js";
export {
  AcpEventReadModel,
  AcpEventReadModelRegistry,
  acpEventReadModels
} from "./autoRun/acpEventReadModel.js";
export type * from "./autoRun/acpEventReadModel.js";
export {
  consumeRunnerRecordReadModel,
  isRunnerRecordLiveActionIdentity,
  readRunnerRecordReadModel,
  readRunnerRecordReadModelForArtifact,
  runnerRecordReadModelSchema
} from "./autoRun/runnerRecordReadModel.js";
export type * from "./autoRun/runnerRecordReadModel.js";
export { observeRunnerRecordFiles } from "./autoRun/runnerRecordFileObserver.js";
export {
  projectRunnerInteractionAvailability,
  readRunnerInteractionMailboxProjection,
  runnerInteractionAvailabilityReasonSchema,
  runnerInteractionRunMetadataSchema,
  runnerOwnerHeartbeatSchema,
  RUNNER_OWNER_FRESHNESS_THRESHOLD_MS
} from "./autoRun/runnerInteractionAvailability.js";
export type * from "./autoRun/runnerInteractionAvailability.js";
export {
  createRunTerminalEvent,
  createRunnerInteractionRequiredEvent,
  createRunnerInteractionResolvedEvent,
  runCompletedEventSchema,
  runEventSchema,
  runEventVersionSchema,
  runFailedEventSchema,
  runnerInteractionRequiredEventSchema,
  runnerInteractionResolvedEventSchema
} from "./autoRun/runnerInteractionObserver.js";
export type * from "./autoRun/runnerInteractionObserver.js";
export {
  runnerInteractionClientLabelSchema,
  runnerInteractionActionIdentitySchema,
  runnerInteractionErrorCodeSchema,
  runnerInteractionIdentitySchema,
  runnerInteractionResponseReceiptSchema,
  runnerInteractionSnapshotSchema,
  runnerPermissionInteractionDecisionSchema
} from "./autoRun/runnerInteractionContract.js";
export type * from "./autoRun/runnerInteractionContract.js";
export {
  acpLaunchIdentitySchema,
  acpRecoveryInterruptionReasonSchema,
  acpRunRecoveryExecutionSchema,
  acpRunRecoveryLineageSchema,
  acpRunRecoveryUnavailableReasonSchema,
  acpSessionStartSchema,
  evaluateAcpRunRecovery,
  renderAcpRunRecoveryPrompt
} from "./autoRun/acpRunRecovery.js";
export type * from "./autoRun/acpRunRecovery.js";
export {
  projectRunnerNextActions,
  runnerNextActionSchema,
  runnerNextActionsSchema
} from "./autoRun/runnerNextActions.js";
export type { RunnerNextActions } from "./autoRun/runnerNextActions.js";
export {
  acpTimelineItemSchema,
  projectAcpConversation,
  projectAcpTimeline
} from "./autoRun/acpConversationProjection.js";
export type * from "./autoRun/acpConversationProjection.js";
export { projectRemoteAcpTimeline } from "./autoRun/remoteAcpEventProjection.js";
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
  listTaskFeedbackRecords,
  listTaskFeedbackRunRecords,
  listPendingImportRecoveries,
  openProject,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges,
  resolveTaskCanvasWorkspace,
  addCanvasDependency,
  addCrossTaskDependency,
  cancelDesktopAgentRun,
  executeDesktopAgentRunControl,
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
  previewClaimNext,
  resetDesktopRuntimeState,
  resumeAutoRun,
  respondToDesktopAgentRequest,
  respondToDesktopAgentAuthenticationRequest,
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
  listPendingRunnerInteractions,
  respondToRunnerInteraction,
  respondToRunnerInteractionAction,
  runnerInteractionAuditSchema,
  runnerInteractionCanvasRefSchema,
  RunnerInteractionApiError,
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
  desktopAgentRunControlErrorSchema,
  desktopAgentRunControlInputSchema,
  desktopAgentRunControlResponseSchema,
  desktopAgentRunControlSuccessSchema
} from "./desktop/index.js";
export {
  CANVAS_MAP_LAYOUT_VERSION,
  CanvasMapLayoutError,
  canvasMapLayoutFileSchema,
  canvasMapLayoutNodeSchema,
  defaultCanvasMapLayout,
  parseCanvasMapLayoutFile,
  reconcileCanvasMapLayoutWithProject
} from "./desktop/index.js";
export {
  desktopCanvasReferenceSchema,
  desktopPromptSaveOptionsSchema,
  desktopLayoutFileSchema,
  desktopLayoutNodeSchema,
  desktopAddBlockInputSchema,
  desktopAddTaskInputSchema,
  desktopGraphEditValidationInputSchema,
  desktopReviewHookSchema,
  desktopReviewPipelinePackageDefaultsSchema,
  desktopReviewPipelineStepInputSchema,
  desktopUpdateReviewPipelineInputSchema,
  desktopAutoRunOptionsSchema,
  desktopAutoRunScopeSchema,
  desktopAutoRunStepLimitSchema,
  desktopRuntimeResetOptionsSchema
} from "./desktop/index.js";
export {
  canvasExecutionPolicyFieldEditSchema,
  canvasExecutionPolicyInputSchema
} from "./plangraph/index.js";
export {
  desktopAgentActionIdentitySchema,
  desktopAgentPromptIdentitySchema,
  desktopAgentPromptTextSchema,
  desktopAgentSessionActionIdentitySchema,
  desktopAgentActionValueSchema,
  listPendingRunnerInteractionsResultSchema,
  respondToRunnerInteractionResultSchema,
  runnerInteractionIpcErrorSchema,
  desktopRunnerRecordSubscriptionInputSchema,
  desktopRunnerRecordSubscriptionPushSchema,
  desktopRunnerRecordSubscriptionSnapshotPushSchema,
  desktopRunnerRecordSubscriptionClosedPushSchema
} from "./desktop/types/acpBridgeTypes.js";
export {
  acpEventSubscriptionCloseReasonSchema,
  acpEventSubscriptionCloseResultSchema,
  acpEventSubscriptionCloseRecoverable,
  createAcpEventSubscriptionCloseResult
} from "./autoRun/acpEventPublisher.js";
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
  executionHostSchema,
  executorProfileExecutionHost,
  executorProfileAdapterSchema,
  executorProfileSchema,
  executorRuntimeLimitsSchema,
  nativeExecutionHost,
  nativeExecutionHostSchema,
  reviewTriggerConditions,
  runnerTransportSchema,
  wslExecutionHostSchema,
  runSubmitStatuses,
  reviewStatuses
} from "./types.js";
export type {
  SourceDefaultProjectCandidate,
  SourceDefaultProjectEntry
} from "./desktop/sourceDefaultProject.js";
export {
  checkDesktopProjectDoctor,
  desktopProjectDoctorRepairConfirmationSchema,
  desktopRegisteredProjectIdSchema,
  desktopProjectReferenceSchema,
  repairDesktopProjectDoctor,
  resolveDesktopProjectReference
} from "./desktop/index.js";
export type { AutoRunEventTailItem, TailAutoRunEventsOptions } from "./desktop/runEventTail.js";
export {
  projectGraphCanvasNodeTypes,
  projectGraphEdgeTypes,
  projectGraphNodeTypes,
  projectGraphVersion,
  supportedProjectGraphVersion
} from "./projectGraph/index.js";
export type * from "./desktop/index.js";
export {
  projectTaskWorkspaceClockSnapshot,
  projectTaskWorkspaceLiveSnapshot,
  projectTaskWorkspaceRun,
  taskWorkspaceAcpRecoveryCapabilitySchema,
  taskWorkspaceAcpRecoveryIdentitySchema,
  taskWorkspaceAcpRecoveryUnavailableSchema,
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
} from "./desktop/index.js";
export {
  composeTaskWorkspaceRuns,
  getTaskWorkspace,
  getTaskWorkspaceRunDetail,
  listTaskWorkspaceRuns,
  reconcileOrphanedAcpRun,
  recoverAcpRunByRecord,
  recoverTaskWorkspaceAcpRun,
  retryTaskWorkspaceRun,
  TASK_WORKSPACE_RUNS_DEFAULT_LIMIT,
  TASK_WORKSPACE_RUNS_MAX_LIMIT,
  TASK_WORKSPACE_TASK_COST_UNAVAILABLE_REASON,
  taskWorkspaceAgentTimeSchema,
  taskWorkspaceAnnotationSchema,
  taskWorkspaceBlockSchema,
  taskWorkspaceCostAccountingSchema,
  taskWorkspaceDependencyProgressSchema,
  taskWorkspaceHeaderInputSchema,
  taskWorkspaceInputSchema,
  taskWorkspaceLatestArtifactSchema,
  desktopRunRecordSchema,
  taskWorkspaceListRunsInputSchema,
  taskWorkspaceRunDetailInputSchema,
  taskWorkspaceRunDetailRecordIdentitySchema,
  taskWorkspaceRunDetailSchema,
  taskWorkspaceRunItemSchema,
  taskWorkspaceRunListItemSchema,
  taskWorkspaceRunsCursorSchema,
  taskWorkspaceRunsPageSchema,
  taskWorkspaceSchema,
  taskWorkspaceWaitingInteractionSchema,
  taskWorkspaceWallClockSchema
} from "./desktop/index.js";
export type * from "./runSessions/index.js";
export {
  executorAgentInfoSchema,
  executorPreflightCheckNameSchema,
  executorPreflightFailureCodeSchema,
  executorPreflightCheckStatusSchema,
  executorPreflightCheckSchema,
  executorPreflightResultSchema,
  producedExecutorPreflightResultSchema
} from "./autoRun/executorPreflightTypes.js";
export type * from "./autoRun/executorPreflightTypes.js";
export type * from "./plangraph/index.js";
export type * from "./projectGraph/index.js";
export type * from "./schemaDocs/index.js";
export type * from "./types.js";
export {
  AcpEngineCapabilityError,
  AcpEngineExecutionError,
  AcpEngineInteractionError,
  AcpEngineLimitError,
  executeAcp,
  executeAcpOrThrow
} from "./autoRun/acpExecutionEngine.js";
export {
  DEFAULT_ACP_EXECUTION_LIMITS,
  acpEngineSessionStartSchema,
  acpExecutionLimitsSchema
} from "./autoRun/acpExecutionEngineContracts.js";
export type * from "./autoRun/acpExecutionEngineContracts.js";
export {
  resolveAgentDefinition,
  registeredAgentDefinitions,
  builtinAgentProfiles
} from "./autoRun/agentRegistry.js";
export type {
  AgentDefinition,
  AcpLaunchMetadata,
  RunnerPreflightInput,
  RunnerPreflightResult
} from "./autoRun/agentRunner.js";
export {
  ACP_SDK_AUTHORITY,
  AcpOperationTimeoutError,
  AcpProcessError,
  createAcpConnection
} from "./autoRun/acpConnection.js";
export type {
  AcpConnection,
  CreateAcpConnectionOptions,
  TrustedAcpLaunch
} from "./autoRun/acpConnection.js";
export {
  AcpPreflightCleanupError,
  AcpPreflightPhaseError,
  capabilitiesFromInitialize,
  probeInstalledAcpAgent
} from "./autoRun/acpPreflightProbe.js";
export type { AcpPreflightPhase } from "./autoRun/acpPreflightProbe.js";
export { acpProbeResultSchema } from "./autoRun/acpRunner.js";
export type { AcpPreflightProbe, AcpPreflightProbeResult } from "./autoRun/acpRunner.js";

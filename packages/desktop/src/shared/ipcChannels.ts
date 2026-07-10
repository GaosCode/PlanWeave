import type { DesktopBridgeApi } from "@planweave-ai/runtime";

export type DesktopBridgeSubscriptionMethod =
  | "onPackageFileChanged"
  | "onRuntimeStateChanged"
  | "onAutoRunChanged";
export type DesktopBridgeInvokeMethod = Exclude<
  keyof DesktopBridgeApi,
  DesktopBridgeSubscriptionMethod
>;

export const desktopBridgeWatchInvokeMethods = [
  "watchPackageFiles",
  "unwatchPackageFiles",
  "watchRuntimeState",
  "unwatchRuntimeState"
] as const satisfies readonly DesktopBridgeInvokeMethod[];

export type DesktopBridgeWatchInvokeMethod = (typeof desktopBridgeWatchInvokeMethods)[number];
export type DesktopBridgeMainInvokeMethod = Exclude<
  DesktopBridgeInvokeMethod,
  DesktopBridgeWatchInvokeMethod
>;

export const desktopBridgeInvokeChannels = {
  addBlock: "planweave:addBlock",
  addDependencyEdge: "planweave:addDependencyEdge",
  addTaskNode: "planweave:addTaskNode",
  applyCanvasLaneLayout: "planweave:applyCanvasLaneLayout",
  chooseProjectFolder: "planweave:chooseProjectFolder",
  chooseSourceRootFolder: "planweave:chooseSourceRootFolder",
  createPackageFileSnapshot: "planweave:createPackageFileSnapshot",
  createProjectFromTaskCanvas: "planweave:createProjectFromTaskCanvas",
  createTaskCanvas: "planweave:createTaskCanvas",
  createTaskDraft: "planweave:createTaskDraft",
  detectAgentTools: "planweave:detectAgentTools",
  detectRuntimeTools: "planweave:detectRuntimeTools",
  detectPackageFileChanges: "planweave:detectPackageFileChanges",
  detectTerminalApps: "planweave:detectTerminalApps",
  duplicateTaskCanvas: "planweave:duplicateTaskCanvas",
  getAutoRunRetrospective: "planweave:getAutoRunRetrospective",
  getAutoRunState: "planweave:getAutoRunState",
  getBlockDetail: "planweave:getBlockDetail",
  getCanvasGraphViewModel: "planweave:getCanvasGraphViewModel",
  getCanvasMapLayout: "planweave:getCanvasMapLayout",
  getDesktopLayout: "planweave:getDesktopLayout",
  getDesktopGraphDiagnostics: "planweave:getDesktopGraphDiagnostics",
  getDesktopProjectSnapshot: "planweave:getDesktopProjectSnapshot",
  getDesktopRuntimeRefresh: "planweave:getDesktopRuntimeRefresh",
  getDirtyPromptRefs: "planweave:getDirtyPromptRefs",
  getFeedbackRecords: "planweave:getFeedbackRecords",
  getGraphViewModel: "planweave:getGraphViewModel",
  getLatestAutoRunRetrospective: "planweave:getLatestAutoRunRetrospective",
  getLatestAutoRunSummary: "planweave:getLatestAutoRunSummary",
  getLatestAutoRunSummaryWithDiagnostics: "planweave:getLatestAutoRunSummaryWithDiagnostics",
  getProjectExecutionPlan: "planweave:getProjectExecutionPlan",
  getProjectOverview: "planweave:getProjectOverview",
  getRunTerminalAvailability: "planweave:getRunTerminalAvailability",
  getReviewAttempts: "planweave:getReviewAttempts",
  getReviewPipeline: "planweave:getReviewPipeline",
  getRunRecord: "planweave:getRunRecord",
  getStatistics: "planweave:getStatistics",
  getTaskDetail: "planweave:getTaskDetail",
  getTaskExecutionOrder: "planweave:getTaskExecutionOrder",
  getTerminalPreferences: "planweave:getTerminalPreferences",
  getTodoGroups: "planweave:getTodoGroups",
  initOrOpenProject: "planweave:initOrOpenProject",
  listBlockRunRecords: "planweave:listBlockRunRecords",
  listPendingImportRecoveries: "planweave:listPendingImportRecoveries",
  listProjects: "planweave:listProjects",
  linkProjectSourceRoot: "planweave:linkProjectSourceRoot",
  openBlockInspectorWindow: "planweave:openBlockInspectorWindow",
  openTerminal: "planweave:openTerminal",
  openRunTerminal: "planweave:openRunTerminal",
  openTaskInspectorWindow: "planweave:openTaskInspectorWindow",
  openProject: "planweave:openProject",
  pauseAutoRun: "planweave:pauseAutoRun",
  refreshChangedPackagePrompts: "planweave:refreshChangedPackagePrompts",
  refreshPackageFileChanges: "planweave:refreshPackageFileChanges",
  readProjectPrompt: "planweave:readProjectPrompt",
  readProjectPromptPolicy: "planweave:readProjectPromptPolicy",
  renameProject: "planweave:renameProject",
  renameTaskCanvas: "planweave:renameTaskCanvas",
  removeBlock: "planweave:removeBlock",
  removeDependencyEdge: "planweave:removeDependencyEdge",
  removeProject: "planweave:removeProject",
  removeTaskCanvas: "planweave:removeTaskCanvas",
  removeTaskNode: "planweave:removeTaskNode",
  reconnectDependencyEdge: "planweave:reconnectDependencyEdge",
  redoPlanGraphCommand: "planweave:redoPlanGraphCommand",
  resetDesktopLayout: "planweave:resetDesktopLayout",
  resetCanvasMapLayout: "planweave:resetCanvasMapLayout",
  resetRuntimeState: "planweave:resetRuntimeState",
  resumeAutoRun: "planweave:resumeAutoRun",
  revealPathInFinder: "planweave:revealPathInFinder",
  revealProjectInFinder: "planweave:revealProjectInFinder",
  revealTaskCanvasInFinder: "planweave:revealTaskCanvasInFinder",
  rollbackPendingImportRecovery: "planweave:rollbackPendingImportRecovery",
  saveCanvasMapLayout: "planweave:saveCanvasMapLayout",
  saveDesktopLayout: "planweave:saveDesktopLayout",
  searchProject: "planweave:searchProject",
  searchProjectWithDiagnostics: "planweave:searchProjectWithDiagnostics",
  selectTaskCanvas: "planweave:selectTaskCanvas",
  startAutoRun: "planweave:startAutoRun",
  stopAutoRun: "planweave:stopAutoRun",
  testExecutorProfile: "planweave:testExecutorProfile",
  unblockBlock: "planweave:unblockBlock",
  markBlockedBlock: "planweave:markBlockedBlock",
  dispatchBlock: "planweave:dispatchBlock",
  unlinkProjectSourceRoot: "planweave:unlinkProjectSourceRoot",
  unwatchPackageFiles: "planweave:unwatchPackageFiles",
  unwatchRuntimeState: "planweave:unwatchRuntimeState",
  updateBlockExecutor: "planweave:updateBlockExecutor",
  updateBlockPrompt: "planweave:updateBlockPrompt",
  updateBlockTitle: "planweave:updateBlockTitle",
  updateCanvasExecutionPolicy: "planweave:updateCanvasExecutionPolicy",
  updateProjectPrompt: "planweave:updateProjectPrompt",
  updateReviewPipeline: "planweave:updateReviewPipeline",
  updateTerminalPreferences: "planweave:updateTerminalPreferences",
  updateProjectPromptPolicy: "planweave:updateProjectPromptPolicy",
  updateTaskExecutor: "planweave:updateTaskExecutor",
  updateTaskPrompt: "planweave:updateTaskPrompt",
  updateTaskTitle: "planweave:updateTaskTitle",
  undoPlanGraphCommand: "planweave:undoPlanGraphCommand",
  validateGraphEdit: "planweave:validateGraphEdit",
  watchPackageFiles: "planweave:watchPackageFiles",
  watchRuntimeState: "planweave:watchRuntimeState"
} as const satisfies Record<DesktopBridgeInvokeMethod, string>;

export const packageFileChangedChannel = "planweave:packageFileChanged";
export const runtimeStateChangedChannel = "planweave:runtimeStateChanged";
export const autoRunChangedChannel = "planweave:autoRunChanged";

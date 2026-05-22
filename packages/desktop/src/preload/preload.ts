import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DesktopBridgeApi,
  DesktopLayout,
  DesktopPackageFileChangeEvent,
  DesktopProjectSummary
} from "@planweave/runtime";

const packageFileChangedChannel = "planweave:packageFileChanged";

const api: DesktopBridgeApi = {
  listProjects: () => ipcRenderer.invoke("planweave:listProjects") as Promise<DesktopProjectSummary[]>,
  chooseProjectFolder: () => ipcRenderer.invoke("planweave:chooseProjectFolder") as Promise<string | null>,
  revealProjectInFinder: (rootPath) => ipcRenderer.invoke("planweave:revealProjectInFinder", rootPath) as Promise<void>,
  detectAgentTools: () => ipcRenderer.invoke("planweave:detectAgentTools"),
  openBlockInspectorWindow: (input) => ipcRenderer.invoke("planweave:openBlockInspectorWindow", input) as Promise<void>,
  openProject: (input) => ipcRenderer.invoke("planweave:openProject", input) as Promise<DesktopProjectSummary>,
  initOrOpenProject: (rootPath) => ipcRenderer.invoke("planweave:initOrOpenProject", rootPath) as Promise<DesktopProjectSummary>,
  removeProject: (projectId) => ipcRenderer.invoke("planweave:removeProject", projectId) as Promise<void>,
  createTaskCanvas: (projectRoot, input) => ipcRenderer.invoke("planweave:createTaskCanvas", projectRoot, input),
  removeTaskCanvas: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:removeTaskCanvas", projectRoot, canvasId),
  getProjectOverview: (projectRoot) => ipcRenderer.invoke("planweave:getProjectOverview", projectRoot),
  getGraphViewModel: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:getGraphViewModel", projectRoot, canvasId),
  getTaskDetail: (projectRoot, canvasId, taskId) => ipcRenderer.invoke("planweave:getTaskDetail", projectRoot, canvasId, taskId),
  getBlockDetail: (projectRoot, canvasId, blockRef) => ipcRenderer.invoke("planweave:getBlockDetail", projectRoot, canvasId, blockRef),
  getTaskExecutionOrder: (projectRoot, canvasId, taskId) => ipcRenderer.invoke("planweave:getTaskExecutionOrder", projectRoot, canvasId, taskId),
  getTodoGroups: (projectRoot) => ipcRenderer.invoke("planweave:getTodoGroups", projectRoot),
  listBlockRunRecords: (projectRoot, canvasId, blockRef) => ipcRenderer.invoke("planweave:listBlockRunRecords", projectRoot, canvasId, blockRef),
  getRunRecord: (projectRoot, canvasId, recordId) => ipcRenderer.invoke("planweave:getRunRecord", projectRoot, canvasId, recordId),
  getReviewAttempts: (projectRoot, canvasId, blockRef) => ipcRenderer.invoke("planweave:getReviewAttempts", projectRoot, canvasId, blockRef),
  getFeedbackRecords: (projectRoot, canvasId, blockRef) => ipcRenderer.invoke("planweave:getFeedbackRecords", projectRoot, canvasId, blockRef),
  getReviewPipeline: (projectRoot, canvasId, taskId) => ipcRenderer.invoke("planweave:getReviewPipeline", projectRoot, canvasId, taskId),
  updateReviewPipeline: (projectRoot, canvasId, taskId, input) => ipcRenderer.invoke("planweave:updateReviewPipeline", projectRoot, canvasId, taskId, input),
  createTaskDraft: (projectRoot, canvasId, input) => ipcRenderer.invoke("planweave:createTaskDraft", projectRoot, canvasId, input),
  addTaskNode: (projectRoot, canvasId, input) => ipcRenderer.invoke("planweave:addTaskNode", projectRoot, canvasId, input),
  addBlock: (projectRoot, canvasId, input) => ipcRenderer.invoke("planweave:addBlock", projectRoot, canvasId, input),
  addContextNode: (projectRoot, canvasId, input) => ipcRenderer.invoke("planweave:addContextNode", projectRoot, canvasId, input),
  removeTaskNode: (projectRoot, canvasId, taskId) => ipcRenderer.invoke("planweave:removeTaskNode", projectRoot, canvasId, taskId),
  removeBlock: (projectRoot, canvasId, blockRef) => ipcRenderer.invoke("planweave:removeBlock", projectRoot, canvasId, blockRef),
  validateGraphEdit: (projectRoot, canvasId, input) => ipcRenderer.invoke("planweave:validateGraphEdit", projectRoot, canvasId, input),
  updateTaskTitle: (projectRoot, canvasId, taskId, title) => ipcRenderer.invoke("planweave:updateTaskTitle", projectRoot, canvasId, taskId, title),
  updateTaskPrompt: (projectRoot, canvasId, taskId, markdown) => ipcRenderer.invoke("planweave:updateTaskPrompt", projectRoot, canvasId, taskId, markdown),
  updateBlockTitle: (projectRoot, canvasId, blockRef, title) => ipcRenderer.invoke("planweave:updateBlockTitle", projectRoot, canvasId, blockRef, title),
  updateBlockPrompt: (projectRoot, canvasId, blockRef, markdown) => ipcRenderer.invoke("planweave:updateBlockPrompt", projectRoot, canvasId, blockRef, markdown),
  updateTaskExecutor: (projectRoot, canvasId, taskId, executorName) =>
    ipcRenderer.invoke("planweave:updateTaskExecutor", projectRoot, canvasId, taskId, executorName),
  updateBlockExecutor: (projectRoot, canvasId, blockRef, executorName) =>
    ipcRenderer.invoke("planweave:updateBlockExecutor", projectRoot, canvasId, blockRef, executorName),
  addDependencyEdge: (projectRoot, canvasId, fromTaskId, toTaskId) =>
    ipcRenderer.invoke("planweave:addDependencyEdge", projectRoot, canvasId, fromTaskId, toTaskId),
  removeDependencyEdge: (projectRoot, canvasId, fromTaskId, toTaskId) =>
    ipcRenderer.invoke("planweave:removeDependencyEdge", projectRoot, canvasId, fromTaskId, toTaskId),
  getDesktopLayout: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:getDesktopLayout", projectRoot, canvasId),
  saveDesktopLayout: (projectRoot, canvasId, layout: DesktopLayout) => ipcRenderer.invoke("planweave:saveDesktopLayout", projectRoot, canvasId, layout),
  resetDesktopLayout: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:resetDesktopLayout", projectRoot, canvasId),
  createPackageFileSnapshot: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:createPackageFileSnapshot", projectRoot, canvasId),
  detectPackageFileChanges: (projectRoot, canvasId, snapshotId) => ipcRenderer.invoke("planweave:detectPackageFileChanges", projectRoot, canvasId, snapshotId),
  refreshChangedPackagePrompts: (projectRoot, canvasId, snapshotId) =>
    ipcRenderer.invoke("planweave:refreshChangedPackagePrompts", projectRoot, canvasId, snapshotId),
  refreshPackageFileChanges: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:refreshPackageFileChanges", projectRoot, canvasId),
  getDirtyPromptRefs: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:getDirtyPromptRefs", projectRoot, canvasId),
  watchPackageFiles: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:watchPackageFiles", projectRoot, canvasId) as Promise<void>,
  unwatchPackageFiles: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:unwatchPackageFiles", projectRoot, canvasId) as Promise<void>,
  onPackageFileChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) => callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  },
  startAutoRun: (projectRoot, canvasId, scope, stepLimit) => ipcRenderer.invoke("planweave:startAutoRun", projectRoot, canvasId, scope, stepLimit),
  pauseAutoRun: (runId) => ipcRenderer.invoke("planweave:pauseAutoRun", runId),
  resumeAutoRun: (runId) => ipcRenderer.invoke("planweave:resumeAutoRun", runId),
  stopAutoRun: (runId) => ipcRenderer.invoke("planweave:stopAutoRun", runId),
  getAutoRunState: (runId) => ipcRenderer.invoke("planweave:getAutoRunState", runId),
  getLatestAutoRunSummary: (projectRoot, canvasId) => ipcRenderer.invoke("planweave:getLatestAutoRunSummary", projectRoot, canvasId),
  getStatistics: (projectRoot) => ipcRenderer.invoke("planweave:getStatistics", projectRoot),
  searchProject: (projectRoot, query, filters) => ipcRenderer.invoke("planweave:searchProject", projectRoot, query, filters)
};

contextBridge.exposeInMainWorld("planweave", api);

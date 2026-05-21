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
  openProject: (input) => ipcRenderer.invoke("planweave:openProject", input) as Promise<DesktopProjectSummary>,
  initOrOpenProject: (rootPath) => ipcRenderer.invoke("planweave:initOrOpenProject", rootPath) as Promise<DesktopProjectSummary>,
  getProjectOverview: (projectRoot) => ipcRenderer.invoke("planweave:getProjectOverview", projectRoot),
  getGraphViewModel: (projectRoot) => ipcRenderer.invoke("planweave:getGraphViewModel", projectRoot),
  getTaskDetail: (projectRoot, taskId) => ipcRenderer.invoke("planweave:getTaskDetail", projectRoot, taskId),
  getBlockDetail: (projectRoot, blockRef) => ipcRenderer.invoke("planweave:getBlockDetail", projectRoot, blockRef),
  getTaskExecutionOrder: (projectRoot, taskId) => ipcRenderer.invoke("planweave:getTaskExecutionOrder", projectRoot, taskId),
  getTodoGroups: (projectRoot) => ipcRenderer.invoke("planweave:getTodoGroups", projectRoot),
  listBlockRunRecords: (projectRoot, blockRef) => ipcRenderer.invoke("planweave:listBlockRunRecords", projectRoot, blockRef),
  getRunRecord: (projectRoot, recordId) => ipcRenderer.invoke("planweave:getRunRecord", projectRoot, recordId),
  getReviewAttempts: (projectRoot, blockRef) => ipcRenderer.invoke("planweave:getReviewAttempts", projectRoot, blockRef),
  getFeedbackRecords: (projectRoot, blockRef) => ipcRenderer.invoke("planweave:getFeedbackRecords", projectRoot, blockRef),
  getReviewPipeline: (projectRoot, taskId) => ipcRenderer.invoke("planweave:getReviewPipeline", projectRoot, taskId),
  updateReviewPipeline: (projectRoot, taskId, input) => ipcRenderer.invoke("planweave:updateReviewPipeline", projectRoot, taskId, input),
  createTaskDraft: (projectRoot, input) => ipcRenderer.invoke("planweave:createTaskDraft", projectRoot, input),
  addTaskNode: (projectRoot, input) => ipcRenderer.invoke("planweave:addTaskNode", projectRoot, input),
  addBlock: (projectRoot, input) => ipcRenderer.invoke("planweave:addBlock", projectRoot, input),
  addContextNode: (projectRoot, input) => ipcRenderer.invoke("planweave:addContextNode", projectRoot, input),
  removeTaskNode: (projectRoot, taskId) => ipcRenderer.invoke("planweave:removeTaskNode", projectRoot, taskId),
  removeBlock: (projectRoot, blockRef) => ipcRenderer.invoke("planweave:removeBlock", projectRoot, blockRef),
  validateGraphEdit: (projectRoot, input) => ipcRenderer.invoke("planweave:validateGraphEdit", projectRoot, input),
  updateTaskTitle: (projectRoot, taskId, title) => ipcRenderer.invoke("planweave:updateTaskTitle", projectRoot, taskId, title),
  updateTaskPrompt: (projectRoot, taskId, markdown) => ipcRenderer.invoke("planweave:updateTaskPrompt", projectRoot, taskId, markdown),
  updateBlockTitle: (projectRoot, blockRef, title) => ipcRenderer.invoke("planweave:updateBlockTitle", projectRoot, blockRef, title),
  updateBlockPrompt: (projectRoot, blockRef, markdown) => ipcRenderer.invoke("planweave:updateBlockPrompt", projectRoot, blockRef, markdown),
  updateTaskExecutor: (projectRoot, taskId, executorName) =>
    ipcRenderer.invoke("planweave:updateTaskExecutor", projectRoot, taskId, executorName),
  updateBlockExecutor: (projectRoot, blockRef, executorName) =>
    ipcRenderer.invoke("planweave:updateBlockExecutor", projectRoot, blockRef, executorName),
  addDependencyEdge: (projectRoot, fromTaskId, toTaskId) =>
    ipcRenderer.invoke("planweave:addDependencyEdge", projectRoot, fromTaskId, toTaskId),
  removeDependencyEdge: (projectRoot, fromTaskId, toTaskId) =>
    ipcRenderer.invoke("planweave:removeDependencyEdge", projectRoot, fromTaskId, toTaskId),
  getDesktopLayout: (projectRoot) => ipcRenderer.invoke("planweave:getDesktopLayout", projectRoot),
  saveDesktopLayout: (projectRoot, layout: DesktopLayout) => ipcRenderer.invoke("planweave:saveDesktopLayout", projectRoot, layout),
  resetDesktopLayout: (projectRoot) => ipcRenderer.invoke("planweave:resetDesktopLayout", projectRoot),
  createPackageFileSnapshot: (projectRoot) => ipcRenderer.invoke("planweave:createPackageFileSnapshot", projectRoot),
  detectPackageFileChanges: (projectRoot, snapshotId) => ipcRenderer.invoke("planweave:detectPackageFileChanges", projectRoot, snapshotId),
  refreshChangedPackagePrompts: (projectRoot, snapshotId) =>
    ipcRenderer.invoke("planweave:refreshChangedPackagePrompts", projectRoot, snapshotId),
  refreshPackageFileChanges: (projectRoot) => ipcRenderer.invoke("planweave:refreshPackageFileChanges", projectRoot),
  getDirtyPromptRefs: (projectRoot) => ipcRenderer.invoke("planweave:getDirtyPromptRefs", projectRoot),
  watchPackageFiles: (projectRoot) => ipcRenderer.invoke("planweave:watchPackageFiles", projectRoot) as Promise<void>,
  unwatchPackageFiles: (projectRoot) => ipcRenderer.invoke("planweave:unwatchPackageFiles", projectRoot) as Promise<void>,
  onPackageFileChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) => callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  },
  startAutoRun: (projectRoot, scope, stepLimit) => ipcRenderer.invoke("planweave:startAutoRun", projectRoot, scope, stepLimit),
  pauseAutoRun: (runId) => ipcRenderer.invoke("planweave:pauseAutoRun", runId),
  resumeAutoRun: (runId) => ipcRenderer.invoke("planweave:resumeAutoRun", runId),
  stopAutoRun: (runId) => ipcRenderer.invoke("planweave:stopAutoRun", runId),
  getAutoRunState: (runId) => ipcRenderer.invoke("planweave:getAutoRunState", runId),
  getLatestAutoRunSummary: (projectRoot) => ipcRenderer.invoke("planweave:getLatestAutoRunSummary", projectRoot),
  getStatistics: (projectRoot) => ipcRenderer.invoke("planweave:getStatistics", projectRoot),
  searchProject: (projectRoot, query, filters) => ipcRenderer.invoke("planweave:searchProject", projectRoot, query, filters)
};

contextBridge.exposeInMainWorld("planweave", api);

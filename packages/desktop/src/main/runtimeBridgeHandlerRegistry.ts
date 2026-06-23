import { BrowserWindow, dialog, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  createDesktopPackageFileSnapshot,
  createTaskCanvas,
  createTaskDraft,
  cloneDesktopGraphEditResult,
  detectDesktopPackageFileChanges,
  getAutoRunState,
  getBlockDetail,
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  getDesktopLayout,
  getDesktopProjectSnapshot,
  getDirtyPromptRefs,
  getFeedbackRecords,
  getGraphViewModel,
  getLatestAutoRunSummary,
  getProjectExecutionPlan,
  getProjectOverview,
  getReviewAttempts,
  getReviewPipeline,
  getRunRecord,
  getStatistics,
  getTaskDetail,
  getTaskExecutionOrder,
  getTodoGroups,
  initOrOpenProject,
  linkProjectSourceRoot,
  listBlockRunRecords,
  listProjects,
  openProject,
  pauseAutoRun,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges,
  readProjectPrompt,
  readProjectPromptPolicy,
  removeBlock,
  removeDependencyEdge,
  removeProject,
  removeTaskCanvas,
  removeTaskNode,
  reconnectDependencyEdge,
  redoDesktopPlanGraphCommand,
  resetCanvasMapLayout,
  resetDesktopLayout,
  resolveTaskCanvasWorkspace,
  resumeAutoRun,
  saveCanvasMapLayout,
  saveDesktopLayout,
  searchProject,
  selectTaskCanvas,
  startAutoRun,
  stopAutoRun,
  unblockBlock,
  unlinkProjectSourceRoot,
  updateBlockExecutor,
  updateBlockPrompt,
  updateBlockTitle,
  updateProjectPrompt,
  updateProjectPromptPolicy,
  updateReviewPipeline,
  updateTaskExecutor,
  updateTaskPrompt,
  updateTaskTitle,
  undoDesktopPlanGraphCommand,
  validateGraphEdit
} from "@planweave-ai/runtime";
import type {
  DesktopAutoRunOptions,
  DesktopAutoRunScope,
  DesktopBridgeApi,
  DesktopCanvasMapLayout,
  DesktopCanvasReference,
  DesktopGraphEditResult,
  DesktopLayout,
  GraphEditResult
} from "@planweave-ai/runtime";
import type { DesktopBridgeInvokeMethod } from "../shared/ipcChannels.js";
import { detectAgentTools } from "./agentTools.js";
import { openBlockInspectorWindow } from "./blockInspectorWindow.js";
import { openTaskInspectorWindow } from "./taskInspectorWindow.js";
import { detectRuntimeTools } from "./runtimeTools.js";

type RuntimeBridgeInvokeMethod = Exclude<DesktopBridgeInvokeMethod, "watchPackageFiles" | "unwatchPackageFiles">;

type RuntimeBridgeHandler<M extends RuntimeBridgeInvokeMethod> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<DesktopBridgeApi[M]>
) => Awaited<ReturnType<DesktopBridgeApi[M]>> | ReturnType<DesktopBridgeApi[M]> | Promise<Awaited<ReturnType<DesktopBridgeApi[M]>>>;

export type RuntimeBridgeHandlerMap = {
  [Method in RuntimeBridgeInvokeMethod]: RuntimeBridgeHandler<Method>;
};

async function invokeGraphEdit(promise: Promise<GraphEditResult>): Promise<DesktopGraphEditResult> {
  return cloneDesktopGraphEditResult(await promise);
}

async function resolveDesktopCanvasReference(ref: DesktopCanvasReference) {
  return resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId);
}

export const runtimeBridgeHandlers = {
  listProjects: () => listProjects(),
  chooseProjectFolder: async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  },
  chooseSourceRootFolder: async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  },
  revealProjectInFinder: async (_event, rootPath) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    await shell.openPath(rootPath);
  },
  revealPathInFinder: (_event, path) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    shell.showItemInFolder(path);
  },
  detectAgentTools: () => detectAgentTools(),
  detectRuntimeTools: () => detectRuntimeTools(),
  openBlockInspectorWindow: (_event, input) => openBlockInspectorWindow(input),
  openTaskInspectorWindow: (_event, input) => openTaskInspectorWindow(input),
  openProject: (_event, input) => openProject(input),
  initOrOpenProject: (_event, rootPath) => initOrOpenProject(rootPath),
  removeProject: (_event, projectId) => removeProject(projectId),
  linkProjectSourceRoot: (_event, projectId, sourceRoot) => linkProjectSourceRoot(projectId, sourceRoot),
  unlinkProjectSourceRoot: (_event, projectId) => unlinkProjectSourceRoot(projectId),
  createTaskCanvas: (_event, projectRoot, input) => createTaskCanvas(projectRoot, input),
  removeTaskCanvas: (_event, projectRoot, canvasId) => removeTaskCanvas(projectRoot, canvasId),
  selectTaskCanvas: (_event, projectRoot, canvasId) => selectTaskCanvas(projectRoot, canvasId),
  getProjectOverview: (_event, projectRoot) => getProjectOverview(projectRoot),
  getCanvasGraphViewModel: (_event, projectRoot) => getCanvasGraphViewModel(projectRoot),
  getCanvasMapLayout: (_event, projectRoot) => getCanvasMapLayout(projectRoot),
  saveCanvasMapLayout: (_event, projectRoot, layout: DesktopCanvasMapLayout) => saveCanvasMapLayout(projectRoot, layout),
  resetCanvasMapLayout: (_event, projectRoot) => resetCanvasMapLayout(projectRoot),
  getDesktopProjectSnapshot: (_event, ref) => getDesktopProjectSnapshot(ref),
  getGraphViewModel: async (_event, ref) => getGraphViewModel(await resolveDesktopCanvasReference(ref)),
  getTaskDetail: async (_event, ref, taskId) => getTaskDetail(await resolveDesktopCanvasReference(ref), taskId),
  getBlockDetail: async (_event, ref, blockRef) => getBlockDetail(await resolveDesktopCanvasReference(ref), blockRef),
  getTaskExecutionOrder: async (_event, ref, taskId) => getTaskExecutionOrder(await resolveDesktopCanvasReference(ref), taskId),
  getTodoGroups: (_event, projectRoot) => getTodoGroups(projectRoot),
  getProjectExecutionPlan: (_event, projectRoot) => getProjectExecutionPlan(projectRoot),
  readProjectPrompt: (_event, projectRoot) => readProjectPrompt(projectRoot),
  updateProjectPrompt: (_event, projectRoot, markdown) => updateProjectPrompt(projectRoot, markdown),
  readProjectPromptPolicy: (_event, projectRoot) => readProjectPromptPolicy(projectRoot),
  updateProjectPromptPolicy: (_event, projectRoot, patch) => updateProjectPromptPolicy(projectRoot, patch),
  listBlockRunRecords: async (_event, ref, blockRef) => listBlockRunRecords(await resolveDesktopCanvasReference(ref), blockRef),
  getRunRecord: async (_event, ref, recordId) => getRunRecord(await resolveDesktopCanvasReference(ref), recordId),
  getReviewAttempts: async (_event, ref, blockRef) => getReviewAttempts(await resolveDesktopCanvasReference(ref), blockRef),
  getFeedbackRecords: async (_event, ref, blockRef) => getFeedbackRecords(await resolveDesktopCanvasReference(ref), blockRef),
  getReviewPipeline: async (_event, ref, taskId) => getReviewPipeline(await resolveDesktopCanvasReference(ref), taskId),
  updateReviewPipeline: async (_event, ref, taskId, input) =>
    invokeGraphEdit(updateReviewPipeline(await resolveDesktopCanvasReference(ref), taskId, input)),
  getStatistics: (_event, projectRoot) => getStatistics(projectRoot),
  searchProject: (_event, projectRoot, query, filters) => searchProject(projectRoot, query, filters),
  createTaskDraft: async (_event, ref, input) => createTaskDraft(await resolveDesktopCanvasReference(ref), input),
  addTaskNode: async (_event, ref, input) => invokeGraphEdit(addTaskNode(await resolveDesktopCanvasReference(ref), input)),
  addBlock: async (_event, ref, input) => invokeGraphEdit(addBlock(await resolveDesktopCanvasReference(ref), input)),
  removeTaskNode: async (_event, ref, taskId) => invokeGraphEdit(removeTaskNode(await resolveDesktopCanvasReference(ref), taskId)),
  removeBlock: async (_event, ref, blockRef) => invokeGraphEdit(removeBlock(await resolveDesktopCanvasReference(ref), blockRef)),
  validateGraphEdit: async (_event, ref, input) => invokeGraphEdit(validateGraphEdit(await resolveDesktopCanvasReference(ref), input)),
  updateTaskTitle: async (_event, ref, taskId, title) => invokeGraphEdit(updateTaskTitle(await resolveDesktopCanvasReference(ref), taskId, title)),
  updateTaskPrompt: async (_event, ref, taskId, markdown, options) => invokeGraphEdit(updateTaskPrompt(await resolveDesktopCanvasReference(ref), taskId, markdown, options)),
  updateBlockTitle: async (_event, ref, blockRef, title) => invokeGraphEdit(updateBlockTitle(await resolveDesktopCanvasReference(ref), blockRef, title)),
  updateBlockPrompt: async (_event, ref, blockRef, markdown, options) => invokeGraphEdit(updateBlockPrompt(await resolveDesktopCanvasReference(ref), blockRef, markdown, options)),
  updateTaskExecutor: async (_event, ref, taskId, executorName) =>
    invokeGraphEdit(updateTaskExecutor(await resolveDesktopCanvasReference(ref), taskId, executorName)),
  updateBlockExecutor: async (_event, ref, blockRef, executorName) =>
    invokeGraphEdit(updateBlockExecutor(await resolveDesktopCanvasReference(ref), blockRef, executorName)),
  addDependencyEdge: async (_event, ref, fromTaskId, toTaskId, baseGraphVersion, layoutSnapshot) =>
    invokeGraphEdit(addDependencyEdge(await resolveDesktopCanvasReference(ref), fromTaskId, toTaskId, baseGraphVersion, layoutSnapshot)),
  removeDependencyEdge: async (_event, ref, fromTaskId, toTaskId, baseGraphVersion, layoutSnapshot) =>
    invokeGraphEdit(removeDependencyEdge(await resolveDesktopCanvasReference(ref), fromTaskId, toTaskId, baseGraphVersion, layoutSnapshot)),
  reconnectDependencyEdge: async (_event, ref, fromTaskId, oldToTaskId, newFromTaskId, newToTaskId, baseGraphVersion, layoutSnapshot) =>
    invokeGraphEdit(reconnectDependencyEdge(await resolveDesktopCanvasReference(ref), fromTaskId, oldToTaskId, newFromTaskId, newToTaskId, baseGraphVersion, layoutSnapshot)),
  undoPlanGraphCommand: async (_event, ref) => invokeGraphEdit(undoDesktopPlanGraphCommand(await resolveDesktopCanvasReference(ref))),
  redoPlanGraphCommand: async (_event, ref) => invokeGraphEdit(redoDesktopPlanGraphCommand(await resolveDesktopCanvasReference(ref))),
  getDesktopLayout: async (_event, ref) => getDesktopLayout(await resolveDesktopCanvasReference(ref)),
  saveDesktopLayout: async (_event, ref, layout: DesktopLayout) => saveDesktopLayout(await resolveDesktopCanvasReference(ref), layout),
  resetDesktopLayout: async (_event, ref) => resetDesktopLayout(await resolveDesktopCanvasReference(ref)),
  createPackageFileSnapshot: async (_event, ref) => createDesktopPackageFileSnapshot(await resolveDesktopCanvasReference(ref)),
  detectPackageFileChanges: async (_event, ref, snapshotId) => detectDesktopPackageFileChanges(await resolveDesktopCanvasReference(ref), snapshotId),
  refreshChangedPackagePrompts: async (_event, ref, snapshotId) =>
    refreshChangedDesktopPackagePrompts(await resolveDesktopCanvasReference(ref), snapshotId),
  refreshPackageFileChanges: async (_event, ref, options) => refreshPackageFileChanges(await resolveDesktopCanvasReference(ref), options),
  getDirtyPromptRefs: async (_event, ref) => getDirtyPromptRefs(await resolveDesktopCanvasReference(ref)),
  startAutoRun: (_event, ref, scope: DesktopAutoRunScope, stepLimit, options?: DesktopAutoRunOptions) =>
    startAutoRun(ref.projectRoot, ref.canvasId, scope, stepLimit, options),
  unblockBlock: async (_event, ref, blockRef, reason) => {
    await unblockBlock({ projectRoot: await resolveDesktopCanvasReference(ref), ref: blockRef, reason });
  },
  pauseAutoRun: (_event, runId) => pauseAutoRun(runId),
  resumeAutoRun: (_event, runId) => resumeAutoRun(runId),
  stopAutoRun: (_event, runId) => stopAutoRun(runId),
  getAutoRunState: (_event, runId) => getAutoRunState(runId),
  getLatestAutoRunSummary: (_event, ref) => getLatestAutoRunSummary(ref.projectRoot, ref.canvasId)
} satisfies RuntimeBridgeHandlerMap;

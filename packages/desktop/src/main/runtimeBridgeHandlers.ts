import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  createTaskCanvas,
  createDesktopPackageFileSnapshot,
  createTaskDraft,
  detectDesktopPackageFileChanges,
  getAutoRunState,
  getBlockDetail,
  getDesktopLayout,
  getDirtyPromptRefs,
  getFeedbackRecords,
  getGraphViewModel,
  getLatestAutoRunSummary,
  getProjectOverview,
  getReviewAttempts,
  getReviewPipeline,
  getRunRecord,
  getStatistics,
  getTaskDetail,
  getTaskExecutionOrder,
  getTodoGroups,
  initOrOpenProject,
  listBlockRunRecords,
  listProjects,
  openProject,
  pauseAutoRun,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges,
  removeBlock,
  removeDependencyEdge,
  removeProject,
  removeTaskCanvas,
  removeTaskNode,
  resetDesktopLayout,
  resolveTaskCanvasWorkspace,
  resumeAutoRun,
  saveDesktopLayout,
  searchProject,
  startAutoRun,
  stopAutoRun,
  unblockBlock,
  updateBlockExecutor,
  updateBlockPrompt,
  updateBlockTitle,
  updateReviewPipeline,
  updateTaskExecutor,
  updateTaskPrompt,
  updateTaskTitle,
  validateGraphEdit
} from "@planweave/runtime";
import type { DesktopAutoRunScope, DesktopCanvasReference, DesktopGraphEditResult, DesktopLayout, GraphEditResult } from "@planweave/runtime";
import type { DesktopAutoRunOptions } from "@planweave/runtime";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels.js";
import { detectAgentTools } from "./agentTools.js";
import { openBlockInspectorWindow } from "./blockInspectorWindow.js";
import { openTaskInspectorWindow } from "./taskInspectorWindow.js";
import { detectRuntimeTools } from "./runtimeTools.js";
import { cloneableGraphEditResult } from "./runtimeBridgeResult.js";

async function invokeGraphEdit(promise: Promise<GraphEditResult>): Promise<DesktopGraphEditResult> {
  return cloneableGraphEditResult(await promise);
}

async function resolveDesktopCanvasReference(ref: DesktopCanvasReference) {
  return resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId);
}

export function registerRuntimeBridgeHandlers(): void {
  ipcMain.handle(desktopBridgeInvokeChannels.listProjects, () => listProjects());
  ipcMain.handle(desktopBridgeInvokeChannels.chooseProjectFolder, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle(desktopBridgeInvokeChannels.revealProjectInFinder, async (_event, rootPath: string) => {
    await shell.openPath(rootPath);
  });
  ipcMain.handle(desktopBridgeInvokeChannels.revealPathInFinder, (_event, path: string) => {
    shell.showItemInFolder(path);
  });
  ipcMain.handle(desktopBridgeInvokeChannels.detectAgentTools, () => detectAgentTools());
  ipcMain.handle(desktopBridgeInvokeChannels.detectRuntimeTools, () => detectRuntimeTools());
  ipcMain.handle(desktopBridgeInvokeChannels.openBlockInspectorWindow, (_event, input: { blockRef: string; canvas: DesktopCanvasReference; language: string }) =>
    openBlockInspectorWindow(input)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.openTaskInspectorWindow, (_event, input: { taskId: string; canvas: DesktopCanvasReference; language: string }) =>
    openTaskInspectorWindow(input)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.openProject, (_event, input: { projectId?: string; rootPath?: string }) => openProject(input));
  ipcMain.handle(desktopBridgeInvokeChannels.initOrOpenProject, (_event, rootPath: string) => initOrOpenProject(rootPath));
  ipcMain.handle(desktopBridgeInvokeChannels.removeProject, (_event, projectId: string) => removeProject(projectId));
  ipcMain.handle(desktopBridgeInvokeChannels.createTaskCanvas, (_event, projectRoot: string, input?: Parameters<typeof createTaskCanvas>[1]) => createTaskCanvas(projectRoot, input));
  ipcMain.handle(desktopBridgeInvokeChannels.removeTaskCanvas, (_event, projectRoot: string, canvasId: string) => removeTaskCanvas(projectRoot, canvasId));
  ipcMain.handle(desktopBridgeInvokeChannels.getProjectOverview, (_event, projectRoot: string) => getProjectOverview(projectRoot));
  ipcMain.handle(desktopBridgeInvokeChannels.getGraphViewModel, async (_event, ref: DesktopCanvasReference) => getGraphViewModel(await resolveDesktopCanvasReference(ref)));
  ipcMain.handle(desktopBridgeInvokeChannels.getTaskDetail, async (_event, ref: DesktopCanvasReference, taskId: string) => getTaskDetail(await resolveDesktopCanvasReference(ref), taskId));
  ipcMain.handle(desktopBridgeInvokeChannels.getBlockDetail, async (_event, ref: DesktopCanvasReference, blockRef: string) => getBlockDetail(await resolveDesktopCanvasReference(ref), blockRef));
  ipcMain.handle(desktopBridgeInvokeChannels.getTaskExecutionOrder, async (_event, ref: DesktopCanvasReference, taskId: string) => getTaskExecutionOrder(await resolveDesktopCanvasReference(ref), taskId));
  ipcMain.handle(desktopBridgeInvokeChannels.getTodoGroups, (_event, projectRoot: string) => getTodoGroups(projectRoot));
  ipcMain.handle(desktopBridgeInvokeChannels.listBlockRunRecords, async (_event, ref: DesktopCanvasReference, blockRef: string) => listBlockRunRecords(await resolveDesktopCanvasReference(ref), blockRef));
  ipcMain.handle(desktopBridgeInvokeChannels.getRunRecord, async (_event, ref: DesktopCanvasReference, recordId: string) => getRunRecord(await resolveDesktopCanvasReference(ref), recordId));
  ipcMain.handle(desktopBridgeInvokeChannels.getReviewAttempts, async (_event, ref: DesktopCanvasReference, blockRef: string) => getReviewAttempts(await resolveDesktopCanvasReference(ref), blockRef));
  ipcMain.handle(desktopBridgeInvokeChannels.getFeedbackRecords, async (_event, ref: DesktopCanvasReference, blockRef: string) => getFeedbackRecords(await resolveDesktopCanvasReference(ref), blockRef));
  ipcMain.handle(desktopBridgeInvokeChannels.getReviewPipeline, async (_event, ref: DesktopCanvasReference, taskId: string) => getReviewPipeline(await resolveDesktopCanvasReference(ref), taskId));
  ipcMain.handle(desktopBridgeInvokeChannels.updateReviewPipeline, async (_event, ref: DesktopCanvasReference, taskId: string, input: Parameters<typeof updateReviewPipeline>[2]) =>
    invokeGraphEdit(updateReviewPipeline(await resolveDesktopCanvasReference(ref), taskId, input))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.getStatistics, (_event, projectRoot: string) => getStatistics(projectRoot));
  ipcMain.handle(desktopBridgeInvokeChannels.searchProject, (_event, projectRoot: string, query: string, filters?: Parameters<typeof searchProject>[2]) =>
    searchProject(projectRoot, query, filters)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.createTaskDraft, async (_event, ref: DesktopCanvasReference, input: Parameters<typeof createTaskDraft>[1]) => createTaskDraft(await resolveDesktopCanvasReference(ref), input));
  ipcMain.handle(desktopBridgeInvokeChannels.addTaskNode, async (_event, ref: DesktopCanvasReference, input: Parameters<typeof addTaskNode>[1]) =>
    invokeGraphEdit(addTaskNode(await resolveDesktopCanvasReference(ref), input))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.addBlock, async (_event, ref: DesktopCanvasReference, input: Parameters<typeof addBlock>[1]) => invokeGraphEdit(addBlock(await resolveDesktopCanvasReference(ref), input)));
  ipcMain.handle(desktopBridgeInvokeChannels.removeTaskNode, async (_event, ref: DesktopCanvasReference, taskId: string) => invokeGraphEdit(removeTaskNode(await resolveDesktopCanvasReference(ref), taskId)));
  ipcMain.handle(desktopBridgeInvokeChannels.removeBlock, async (_event, ref: DesktopCanvasReference, blockRef: string) => invokeGraphEdit(removeBlock(await resolveDesktopCanvasReference(ref), blockRef)));
  ipcMain.handle(desktopBridgeInvokeChannels.validateGraphEdit, async (_event, ref: DesktopCanvasReference, input: Parameters<typeof validateGraphEdit>[1]) =>
    invokeGraphEdit(validateGraphEdit(await resolveDesktopCanvasReference(ref), input))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.updateTaskTitle, async (_event, ref: DesktopCanvasReference, taskId: string, title: string) =>
    invokeGraphEdit(updateTaskTitle(await resolveDesktopCanvasReference(ref), taskId, title))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.updateTaskPrompt, async (_event, ref: DesktopCanvasReference, taskId: string, markdown: string) =>
    invokeGraphEdit(updateTaskPrompt(await resolveDesktopCanvasReference(ref), taskId, markdown))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.updateBlockTitle, async (_event, ref: DesktopCanvasReference, blockRef: string, title: string) =>
    invokeGraphEdit(updateBlockTitle(await resolveDesktopCanvasReference(ref), blockRef, title))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.updateBlockPrompt, async (_event, ref: DesktopCanvasReference, blockRef: string, markdown: string) =>
    invokeGraphEdit(updateBlockPrompt(await resolveDesktopCanvasReference(ref), blockRef, markdown))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.updateTaskExecutor, async (_event, ref: DesktopCanvasReference, taskId: string, executorName: string | null) =>
    invokeGraphEdit(updateTaskExecutor(await resolveDesktopCanvasReference(ref), taskId, executorName))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.updateBlockExecutor, async (_event, ref: DesktopCanvasReference, blockRef: string, executorName: string | null) =>
    invokeGraphEdit(updateBlockExecutor(await resolveDesktopCanvasReference(ref), blockRef, executorName))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.addDependencyEdge, async (_event, ref: DesktopCanvasReference, fromTaskId: string, toTaskId: string) =>
    invokeGraphEdit(addDependencyEdge(await resolveDesktopCanvasReference(ref), fromTaskId, toTaskId))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.removeDependencyEdge, async (_event, ref: DesktopCanvasReference, fromTaskId: string, toTaskId: string) =>
    invokeGraphEdit(removeDependencyEdge(await resolveDesktopCanvasReference(ref), fromTaskId, toTaskId))
  );
  ipcMain.handle(desktopBridgeInvokeChannels.getDesktopLayout, async (_event, ref: DesktopCanvasReference) => getDesktopLayout(await resolveDesktopCanvasReference(ref)));
  ipcMain.handle(desktopBridgeInvokeChannels.saveDesktopLayout, async (_event, ref: DesktopCanvasReference, layout: DesktopLayout) => saveDesktopLayout(await resolveDesktopCanvasReference(ref), layout));
  ipcMain.handle(desktopBridgeInvokeChannels.resetDesktopLayout, async (_event, ref: DesktopCanvasReference) => resetDesktopLayout(await resolveDesktopCanvasReference(ref)));
  ipcMain.handle(desktopBridgeInvokeChannels.createPackageFileSnapshot, async (_event, ref: DesktopCanvasReference) => createDesktopPackageFileSnapshot(await resolveDesktopCanvasReference(ref)));
  ipcMain.handle(desktopBridgeInvokeChannels.detectPackageFileChanges, async (_event, ref: DesktopCanvasReference, snapshotId?: string | null) =>
    detectDesktopPackageFileChanges(await resolveDesktopCanvasReference(ref), snapshotId)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.refreshChangedPackagePrompts, async (_event, ref: DesktopCanvasReference, snapshotId?: string | null) =>
    refreshChangedDesktopPackagePrompts(await resolveDesktopCanvasReference(ref), snapshotId)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.refreshPackageFileChanges, async (_event, ref: DesktopCanvasReference) => refreshPackageFileChanges(await resolveDesktopCanvasReference(ref)));
  ipcMain.handle(desktopBridgeInvokeChannels.getDirtyPromptRefs, async (_event, ref: DesktopCanvasReference) => getDirtyPromptRefs(await resolveDesktopCanvasReference(ref)));
  ipcMain.handle(desktopBridgeInvokeChannels.startAutoRun, (_event, ref: DesktopCanvasReference, scope: DesktopAutoRunScope, stepLimit?: number, options?: DesktopAutoRunOptions) =>
    startAutoRun(ref.projectRoot, ref.canvasId, scope, stepLimit, options)
  );
  ipcMain.handle(desktopBridgeInvokeChannels.unblockBlock, async (_event, ref: DesktopCanvasReference, blockRef: string, reason: string) => {
    await unblockBlock({ projectRoot: await resolveDesktopCanvasReference(ref), ref: blockRef, reason });
  });
  ipcMain.handle(desktopBridgeInvokeChannels.pauseAutoRun, (_event, runId: string) => pauseAutoRun(runId));
  ipcMain.handle(desktopBridgeInvokeChannels.resumeAutoRun, (_event, runId: string) => resumeAutoRun(runId));
  ipcMain.handle(desktopBridgeInvokeChannels.stopAutoRun, (_event, runId: string) => stopAutoRun(runId));
  ipcMain.handle(desktopBridgeInvokeChannels.getAutoRunState, (_event, runId: string) => getAutoRunState(runId));
  ipcMain.handle(desktopBridgeInvokeChannels.getLatestAutoRunSummary, (_event, ref: DesktopCanvasReference) => getLatestAutoRunSummary(ref.projectRoot, ref.canvasId));
}

import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import {
  addBlock,
  addContextNode,
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
  updateBlockExecutor,
  updateBlockPrompt,
  updateBlockTitle,
  updateReviewPipeline,
  updateTaskExecutor,
  updateTaskPrompt,
  updateTaskTitle,
  validateGraphEdit
} from "@planweave/runtime";
import type { DesktopAutoRunScope, DesktopGraphEditResult, DesktopLayout, GraphEditResult } from "@planweave/runtime";
import { detectAgentTools } from "./agentTools.js";
import { openBlockInspectorWindow } from "./blockInspectorWindow.js";

function cloneableGraphEditResult(result: GraphEditResult): DesktopGraphEditResult {
  const { graph: _graph, ...cloneable } = result;
  return cloneable;
}

async function invokeGraphEdit(promise: Promise<GraphEditResult>): Promise<DesktopGraphEditResult> {
  return cloneableGraphEditResult(await promise);
}

async function canvasWorkspace(projectRoot: string, canvasId?: string | null) {
  return resolveTaskCanvasWorkspace(projectRoot, canvasId);
}

export function registerRuntimeBridgeHandlers(): void {
  ipcMain.handle("planweave:listProjects", () => listProjects());
  ipcMain.handle("planweave:chooseProjectFolder", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle("planweave:revealProjectInFinder", async (_event, rootPath: string) => {
    await shell.openPath(rootPath);
  });
  ipcMain.handle("planweave:detectAgentTools", () => detectAgentTools());
  ipcMain.handle("planweave:openBlockInspectorWindow", (_event, input: { blockRef: string; canvasId?: string | null; language: string; projectRoot: string }) =>
    openBlockInspectorWindow(input)
  );
  ipcMain.handle("planweave:openProject", (_event, input: { projectId?: string; rootPath?: string }) => openProject(input));
  ipcMain.handle("planweave:initOrOpenProject", (_event, rootPath: string) => initOrOpenProject(rootPath));
  ipcMain.handle("planweave:removeProject", (_event, projectId: string) => removeProject(projectId));
  ipcMain.handle("planweave:createTaskCanvas", (_event, projectRoot: string, input?: Parameters<typeof createTaskCanvas>[1]) => createTaskCanvas(projectRoot, input));
  ipcMain.handle("planweave:removeTaskCanvas", (_event, projectRoot: string, canvasId: string) => removeTaskCanvas(projectRoot, canvasId));
  ipcMain.handle("planweave:getProjectOverview", (_event, projectRoot: string) => getProjectOverview(projectRoot));
  ipcMain.handle("planweave:getGraphViewModel", async (_event, projectRoot: string, canvasId?: string | null) => getGraphViewModel(await canvasWorkspace(projectRoot, canvasId)));
  ipcMain.handle("planweave:getTaskDetail", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string) => getTaskDetail(await canvasWorkspace(projectRoot, canvasId), taskId));
  ipcMain.handle("planweave:getBlockDetail", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string) => getBlockDetail(await canvasWorkspace(projectRoot, canvasId), blockRef));
  ipcMain.handle("planweave:getTaskExecutionOrder", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string) => getTaskExecutionOrder(await canvasWorkspace(projectRoot, canvasId), taskId));
  ipcMain.handle("planweave:getTodoGroups", (_event, projectRoot: string) => getTodoGroups(projectRoot));
  ipcMain.handle("planweave:listBlockRunRecords", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string) => listBlockRunRecords(await canvasWorkspace(projectRoot, canvasId), blockRef));
  ipcMain.handle("planweave:getRunRecord", async (_event, projectRoot: string, canvasId: string | null | undefined, recordId: string) => getRunRecord(await canvasWorkspace(projectRoot, canvasId), recordId));
  ipcMain.handle("planweave:getReviewAttempts", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string) => getReviewAttempts(await canvasWorkspace(projectRoot, canvasId), blockRef));
  ipcMain.handle("planweave:getFeedbackRecords", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string) => getFeedbackRecords(await canvasWorkspace(projectRoot, canvasId), blockRef));
  ipcMain.handle("planweave:getReviewPipeline", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string) => getReviewPipeline(await canvasWorkspace(projectRoot, canvasId), taskId));
  ipcMain.handle("planweave:updateReviewPipeline", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string, input: Parameters<typeof updateReviewPipeline>[2]) =>
    invokeGraphEdit(updateReviewPipeline(await canvasWorkspace(projectRoot, canvasId), taskId, input))
  );
  ipcMain.handle("planweave:getStatistics", (_event, projectRoot: string) => getStatistics(projectRoot));
  ipcMain.handle("planweave:searchProject", (_event, projectRoot: string, query: string, filters?: Parameters<typeof searchProject>[2]) =>
    searchProject(projectRoot, query, filters)
  );
  ipcMain.handle("planweave:createTaskDraft", async (_event, projectRoot: string, canvasId: string | null | undefined, input: Parameters<typeof createTaskDraft>[1]) => createTaskDraft(await canvasWorkspace(projectRoot, canvasId), input));
  ipcMain.handle("planweave:addTaskNode", async (_event, projectRoot: string, canvasId: string | null | undefined, input: Parameters<typeof addTaskNode>[1]) =>
    invokeGraphEdit(addTaskNode(await canvasWorkspace(projectRoot, canvasId), input))
  );
  ipcMain.handle("planweave:addBlock", async (_event, projectRoot: string, canvasId: string | null | undefined, input: Parameters<typeof addBlock>[1]) => invokeGraphEdit(addBlock(await canvasWorkspace(projectRoot, canvasId), input)));
  ipcMain.handle("planweave:addContextNode", async (_event, projectRoot: string, canvasId: string | null | undefined, input: Parameters<typeof addContextNode>[1]) =>
    invokeGraphEdit(addContextNode(await canvasWorkspace(projectRoot, canvasId), input))
  );
  ipcMain.handle("planweave:removeTaskNode", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string) => invokeGraphEdit(removeTaskNode(await canvasWorkspace(projectRoot, canvasId), taskId)));
  ipcMain.handle("planweave:removeBlock", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string) => invokeGraphEdit(removeBlock(await canvasWorkspace(projectRoot, canvasId), blockRef)));
  ipcMain.handle("planweave:validateGraphEdit", async (_event, projectRoot: string, canvasId: string | null | undefined, input: Parameters<typeof validateGraphEdit>[1]) =>
    invokeGraphEdit(validateGraphEdit(await canvasWorkspace(projectRoot, canvasId), input))
  );
  ipcMain.handle("planweave:updateTaskTitle", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string, title: string) =>
    invokeGraphEdit(updateTaskTitle(await canvasWorkspace(projectRoot, canvasId), taskId, title))
  );
  ipcMain.handle("planweave:updateTaskPrompt", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string, markdown: string) =>
    invokeGraphEdit(updateTaskPrompt(await canvasWorkspace(projectRoot, canvasId), taskId, markdown))
  );
  ipcMain.handle("planweave:updateBlockTitle", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string, title: string) =>
    invokeGraphEdit(updateBlockTitle(await canvasWorkspace(projectRoot, canvasId), blockRef, title))
  );
  ipcMain.handle("planweave:updateBlockPrompt", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string, markdown: string) =>
    invokeGraphEdit(updateBlockPrompt(await canvasWorkspace(projectRoot, canvasId), blockRef, markdown))
  );
  ipcMain.handle("planweave:updateTaskExecutor", async (_event, projectRoot: string, canvasId: string | null | undefined, taskId: string, executorName: string | null) =>
    invokeGraphEdit(updateTaskExecutor(await canvasWorkspace(projectRoot, canvasId), taskId, executorName))
  );
  ipcMain.handle("planweave:updateBlockExecutor", async (_event, projectRoot: string, canvasId: string | null | undefined, blockRef: string, executorName: string | null) =>
    invokeGraphEdit(updateBlockExecutor(await canvasWorkspace(projectRoot, canvasId), blockRef, executorName))
  );
  ipcMain.handle("planweave:addDependencyEdge", async (_event, projectRoot: string, canvasId: string | null | undefined, fromTaskId: string, toTaskId: string) =>
    invokeGraphEdit(addDependencyEdge(await canvasWorkspace(projectRoot, canvasId), fromTaskId, toTaskId))
  );
  ipcMain.handle("planweave:removeDependencyEdge", async (_event, projectRoot: string, canvasId: string | null | undefined, fromTaskId: string, toTaskId: string) =>
    invokeGraphEdit(removeDependencyEdge(await canvasWorkspace(projectRoot, canvasId), fromTaskId, toTaskId))
  );
  ipcMain.handle("planweave:getDesktopLayout", async (_event, projectRoot: string, canvasId?: string | null) => getDesktopLayout(await canvasWorkspace(projectRoot, canvasId)));
  ipcMain.handle("planweave:saveDesktopLayout", async (_event, projectRoot: string, canvasId: string | null | undefined, layout: DesktopLayout) => saveDesktopLayout(await canvasWorkspace(projectRoot, canvasId), layout));
  ipcMain.handle("planweave:resetDesktopLayout", async (_event, projectRoot: string, canvasId?: string | null) => resetDesktopLayout(await canvasWorkspace(projectRoot, canvasId)));
  ipcMain.handle("planweave:createPackageFileSnapshot", async (_event, projectRoot: string, canvasId?: string | null) => createDesktopPackageFileSnapshot(await canvasWorkspace(projectRoot, canvasId)));
  ipcMain.handle("planweave:detectPackageFileChanges", async (_event, projectRoot: string, canvasId?: string | null, snapshotId?: string | null) =>
    detectDesktopPackageFileChanges(await canvasWorkspace(projectRoot, canvasId), snapshotId)
  );
  ipcMain.handle("planweave:refreshChangedPackagePrompts", async (_event, projectRoot: string, canvasId?: string | null, snapshotId?: string | null) =>
    refreshChangedDesktopPackagePrompts(await canvasWorkspace(projectRoot, canvasId), snapshotId)
  );
  ipcMain.handle("planweave:refreshPackageFileChanges", async (_event, projectRoot: string, canvasId?: string | null) => refreshPackageFileChanges(await canvasWorkspace(projectRoot, canvasId)));
  ipcMain.handle("planweave:getDirtyPromptRefs", async (_event, projectRoot: string, canvasId?: string | null) => getDirtyPromptRefs(await canvasWorkspace(projectRoot, canvasId)));
  ipcMain.handle("planweave:startAutoRun", (_event, projectRoot: string, canvasId: string | null | undefined, scope: DesktopAutoRunScope, stepLimit?: number) =>
    startAutoRun(projectRoot, canvasId, scope, stepLimit)
  );
  ipcMain.handle("planweave:pauseAutoRun", (_event, runId: string) => pauseAutoRun(runId));
  ipcMain.handle("planweave:resumeAutoRun", (_event, runId: string) => resumeAutoRun(runId));
  ipcMain.handle("planweave:stopAutoRun", (_event, runId: string) => stopAutoRun(runId));
  ipcMain.handle("planweave:getAutoRunState", (_event, runId: string) => getAutoRunState(runId));
  ipcMain.handle("planweave:getLatestAutoRunSummary", (_event, projectRoot: string, canvasId?: string | null) => getLatestAutoRunSummary(projectRoot, canvasId));
}

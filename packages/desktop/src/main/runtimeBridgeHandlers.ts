import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import {
  addBlock,
  addContextNode,
  addDependencyEdge,
  addTaskNode,
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
  removeTaskNode,
  resetDesktopLayout,
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
  ipcMain.handle("planweave:openBlockInspectorWindow", (_event, input: { blockRef: string; language: string; projectRoot: string }) =>
    openBlockInspectorWindow(input)
  );
  ipcMain.handle("planweave:openProject", (_event, input: { projectId?: string; rootPath?: string }) => openProject(input));
  ipcMain.handle("planweave:initOrOpenProject", (_event, rootPath: string) => initOrOpenProject(rootPath));
  ipcMain.handle("planweave:removeProject", (_event, projectId: string) => removeProject(projectId));
  ipcMain.handle("planweave:getProjectOverview", (_event, projectRoot: string) => getProjectOverview(projectRoot));
  ipcMain.handle("planweave:getGraphViewModel", (_event, projectRoot: string) => getGraphViewModel(projectRoot));
  ipcMain.handle("planweave:getTaskDetail", (_event, projectRoot: string, taskId: string) => getTaskDetail(projectRoot, taskId));
  ipcMain.handle("planweave:getBlockDetail", (_event, projectRoot: string, blockRef: string) => getBlockDetail(projectRoot, blockRef));
  ipcMain.handle("planweave:getTaskExecutionOrder", (_event, projectRoot: string, taskId: string) => getTaskExecutionOrder(projectRoot, taskId));
  ipcMain.handle("planweave:getTodoGroups", (_event, projectRoot: string) => getTodoGroups(projectRoot));
  ipcMain.handle("planweave:listBlockRunRecords", (_event, projectRoot: string, blockRef: string) => listBlockRunRecords(projectRoot, blockRef));
  ipcMain.handle("planweave:getRunRecord", (_event, projectRoot: string, recordId: string) => getRunRecord(projectRoot, recordId));
  ipcMain.handle("planweave:getReviewAttempts", (_event, projectRoot: string, blockRef: string) => getReviewAttempts(projectRoot, blockRef));
  ipcMain.handle("planweave:getFeedbackRecords", (_event, projectRoot: string, blockRef: string) => getFeedbackRecords(projectRoot, blockRef));
  ipcMain.handle("planweave:getReviewPipeline", (_event, projectRoot: string, taskId: string) => getReviewPipeline(projectRoot, taskId));
  ipcMain.handle("planweave:updateReviewPipeline", (_event, projectRoot: string, taskId: string, input: Parameters<typeof updateReviewPipeline>[2]) =>
    invokeGraphEdit(updateReviewPipeline(projectRoot, taskId, input))
  );
  ipcMain.handle("planweave:getStatistics", (_event, projectRoot: string) => getStatistics(projectRoot));
  ipcMain.handle("planweave:searchProject", (_event, projectRoot: string, query: string, filters?: Parameters<typeof searchProject>[2]) =>
    searchProject(projectRoot, query, filters)
  );
  ipcMain.handle("planweave:createTaskDraft", (_event, projectRoot: string, input: Parameters<typeof createTaskDraft>[1]) => createTaskDraft(projectRoot, input));
  ipcMain.handle("planweave:addTaskNode", (_event, projectRoot: string, input: Parameters<typeof addTaskNode>[1]) =>
    invokeGraphEdit(addTaskNode(projectRoot, input))
  );
  ipcMain.handle("planweave:addBlock", (_event, projectRoot: string, input: Parameters<typeof addBlock>[1]) => invokeGraphEdit(addBlock(projectRoot, input)));
  ipcMain.handle("planweave:addContextNode", (_event, projectRoot: string, input: Parameters<typeof addContextNode>[1]) =>
    invokeGraphEdit(addContextNode(projectRoot, input))
  );
  ipcMain.handle("planweave:removeTaskNode", (_event, projectRoot: string, taskId: string) => invokeGraphEdit(removeTaskNode(projectRoot, taskId)));
  ipcMain.handle("planweave:removeBlock", (_event, projectRoot: string, blockRef: string) => invokeGraphEdit(removeBlock(projectRoot, blockRef)));
  ipcMain.handle("planweave:validateGraphEdit", (_event, projectRoot: string, input: Parameters<typeof validateGraphEdit>[1]) =>
    invokeGraphEdit(validateGraphEdit(projectRoot, input))
  );
  ipcMain.handle("planweave:updateTaskTitle", (_event, projectRoot: string, taskId: string, title: string) =>
    invokeGraphEdit(updateTaskTitle(projectRoot, taskId, title))
  );
  ipcMain.handle("planweave:updateTaskPrompt", (_event, projectRoot: string, taskId: string, markdown: string) =>
    invokeGraphEdit(updateTaskPrompt(projectRoot, taskId, markdown))
  );
  ipcMain.handle("planweave:updateBlockTitle", (_event, projectRoot: string, blockRef: string, title: string) =>
    invokeGraphEdit(updateBlockTitle(projectRoot, blockRef, title))
  );
  ipcMain.handle("planweave:updateBlockPrompt", (_event, projectRoot: string, blockRef: string, markdown: string) =>
    invokeGraphEdit(updateBlockPrompt(projectRoot, blockRef, markdown))
  );
  ipcMain.handle("planweave:updateTaskExecutor", (_event, projectRoot: string, taskId: string, executorName: string | null) =>
    invokeGraphEdit(updateTaskExecutor(projectRoot, taskId, executorName))
  );
  ipcMain.handle("planweave:updateBlockExecutor", (_event, projectRoot: string, blockRef: string, executorName: string | null) =>
    invokeGraphEdit(updateBlockExecutor(projectRoot, blockRef, executorName))
  );
  ipcMain.handle("planweave:addDependencyEdge", (_event, projectRoot: string, fromTaskId: string, toTaskId: string) =>
    invokeGraphEdit(addDependencyEdge(projectRoot, fromTaskId, toTaskId))
  );
  ipcMain.handle("planweave:removeDependencyEdge", (_event, projectRoot: string, fromTaskId: string, toTaskId: string) =>
    invokeGraphEdit(removeDependencyEdge(projectRoot, fromTaskId, toTaskId))
  );
  ipcMain.handle("planweave:getDesktopLayout", (_event, projectRoot: string) => getDesktopLayout(projectRoot));
  ipcMain.handle("planweave:saveDesktopLayout", (_event, projectRoot: string, layout: DesktopLayout) => saveDesktopLayout(projectRoot, layout));
  ipcMain.handle("planweave:resetDesktopLayout", (_event, projectRoot: string) => resetDesktopLayout(projectRoot));
  ipcMain.handle("planweave:createPackageFileSnapshot", (_event, projectRoot: string) => createDesktopPackageFileSnapshot(projectRoot));
  ipcMain.handle("planweave:detectPackageFileChanges", (_event, projectRoot: string, snapshotId?: string | null) =>
    detectDesktopPackageFileChanges(projectRoot, snapshotId)
  );
  ipcMain.handle("planweave:refreshChangedPackagePrompts", (_event, projectRoot: string, snapshotId?: string | null) =>
    refreshChangedDesktopPackagePrompts(projectRoot, snapshotId)
  );
  ipcMain.handle("planweave:refreshPackageFileChanges", (_event, projectRoot: string) => refreshPackageFileChanges(projectRoot));
  ipcMain.handle("planweave:getDirtyPromptRefs", (_event, projectRoot: string) => getDirtyPromptRefs(projectRoot));
  ipcMain.handle("planweave:startAutoRun", (_event, projectRoot: string, scope: DesktopAutoRunScope, stepLimit?: number) =>
    startAutoRun(projectRoot, scope, stepLimit)
  );
  ipcMain.handle("planweave:pauseAutoRun", (_event, runId: string) => pauseAutoRun(runId));
  ipcMain.handle("planweave:resumeAutoRun", (_event, runId: string) => resumeAutoRun(runId));
  ipcMain.handle("planweave:stopAutoRun", (_event, runId: string) => stopAutoRun(runId));
  ipcMain.handle("planweave:getAutoRunState", (_event, runId: string) => getAutoRunState(runId));
  ipcMain.handle("planweave:getLatestAutoRunSummary", (_event, projectRoot: string) => getLatestAutoRunSummary(projectRoot));
}

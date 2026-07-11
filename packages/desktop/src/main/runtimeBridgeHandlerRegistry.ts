import {
  BrowserWindow,
  dialog,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from "electron";
import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  applyCanvasLaneLayout,
  createDesktopPackageFileSnapshot,
  createProjectFromTaskCanvas,
  createTaskCanvas,
  createTaskDraft,
  cloneDesktopGraphEditResult,
  detectDesktopPackageFileChanges,
  duplicateTaskCanvas,
  getAutoRunRetrospective,
  getAutoRunState,
  getBlockDetail,
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  getDesktopGraphDiagnostics,
  getDesktopLayout,
  getDesktopProjectSnapshot,
  getDesktopRuntimeRefresh,
  getDirtyPromptRefs,
  getFeedbackRecords,
  getGraphViewModel,
  getLatestAutoRunRetrospective,
  getLatestAutoRunSummary,
  getLatestAutoRunSummaryWithDiagnostics,
  getProjectExecutionPlan,
  getProjectOverview,
  getReviewAttempts,
  getReviewPipeline,
  getRunRecord,
  listDesktopPendingAgentRequests,
  getStatistics,
  getTaskDetail,
  getTaskFileManagerPath,
  getTaskExecutionOrder,
  getTodoGroups,
  initOrOpenProject,
  linkProjectSourceRoot,
  listBlockRunRecords,
  listPendingImportRecoveries,
  listProjects,
  openProject,
  pauseAutoRun,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges,
  readProjectPrompt,
  readProjectPromptPolicy,
  renameProject,
  renameTaskCanvas,
  removeBlock,
  removeDependencyEdge,
  removeProject,
  removeTaskCanvas,
  removeTaskNode,
  reconnectDependencyEdge,
  redoDesktopPlanGraphCommand,
  resetCanvasMapLayout,
  resetDesktopLayout,
  resetDesktopRuntimeState,
  resolveTaskCanvasWorkspace,
  resumeAutoRun,
  respondToDesktopAgentRequest,
  rollbackPendingImportRecovery,
  saveCanvasMapLayout,
  saveDesktopLayout,
  searchProject,
  searchProjectWithDiagnostics,
  selectTaskCanvas,
  claimBlock,
  startAutoRun,
  stopAutoRun,
  testExecutorProfile,
  markBlockBlocked,
  unblockBlock,
  unlinkProjectSourceRoot,
  updateBlockExecutor,
  updateBlockPrompt,
  updateBlockTitle,
  updateCanvasExecutionPolicy,
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
  DesktopOpenRunTerminalInput,
  DesktopOpenTerminalInput,
  DesktopRunTerminalAvailabilityInput,
  DesktopRuntimeResetOptions,
  GraphEditResult
} from "@planweave-ai/runtime";
import {
  desktopAgentActionIdentitySchema,
  desktopAgentActionValueSchema
} from "@planweave-ai/runtime";
import type { DesktopBridgeMainInvokeMethod } from "../shared/ipcChannels.js";
import { detectAgentTools } from "./agentTools.js";
import { openBlockInspectorWindow } from "./blockInspectorWindow.js";
import { openTaskInspectorWindow } from "./taskInspectorWindow.js";
import { detectRuntimeTools } from "./runtimeTools.js";
import {
  assertTerminalAppAvailable,
  detectTerminalApps,
  getTerminalPreferences,
  isDesktopTerminalAppId,
  updateTerminalPreferences
} from "./terminalApps.js";
import { launchRunTerminal, openTerminal } from "./terminalLauncher.js";
import {
  getRunTerminalAvailability,
  resolveDesktopTerminalAttachMode,
  resolveTerminalOpenIntent,
  resolveTmuxAttachIntent
} from "./tmuxRunRecordResolver.js";

type RuntimeBridgeHandler<M extends DesktopBridgeMainInvokeMethod> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<DesktopBridgeApi[M]>
) =>
  | Awaited<ReturnType<DesktopBridgeApi[M]>>
  | ReturnType<DesktopBridgeApi[M]>
  | Promise<Awaited<ReturnType<DesktopBridgeApi[M]>>>;

const maxRunTerminalAvailabilityRecordIds = 100;

export type RuntimeBridgeHandlerMap = {
  [Method in DesktopBridgeMainInvokeMethod]: RuntimeBridgeHandler<Method>;
};

async function invokeGraphEdit(promise: Promise<GraphEditResult>): Promise<DesktopGraphEditResult> {
  return cloneDesktopGraphEditResult(await promise);
}

async function resolveDesktopCanvasReference(ref: DesktopCanvasReference) {
  return resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDesktopCanvasReference(value: unknown): DesktopCanvasReference {
  if (!isRecord(value)) {
    throw new Error("Desktop canvas reference is invalid.");
  }
  if (typeof value.projectRoot !== "string" || !value.projectRoot.trim()) {
    throw new Error("Desktop canvas reference projectRoot is invalid.");
  }
  if (
    value.canvasId !== undefined &&
    value.canvasId !== null &&
    typeof value.canvasId !== "string"
  ) {
    throw new Error("Desktop canvas reference canvasId is invalid.");
  }
  return {
    projectRoot: value.projectRoot,
    canvasId: value.canvasId
  };
}

function parseOpenRunTerminalInput(value: unknown): DesktopOpenRunTerminalInput {
  if (!isRecord(value)) {
    throw new Error("Open terminal input must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (key === "command") {
      throw new Error("Renderer must not provide terminal commands.");
    }
    if (key !== "ref" && key !== "recordId" && key !== "appId" && key !== "mode") {
      throw new Error(`Unsupported open terminal field '${key}'.`);
    }
  }
  if (typeof value.recordId !== "string" || !value.recordId.trim()) {
    throw new Error("Open terminal recordId is invalid.");
  }
  if (!isDesktopTerminalAppId(value.appId)) {
    throw new Error("Terminal app id is invalid.");
  }
  const mode = resolveDesktopTerminalAttachMode(value.mode);
  return {
    ref: parseDesktopCanvasReference(value.ref),
    recordId: value.recordId,
    appId: value.appId,
    mode
  };
}

function parseOpenTerminalInput(value: unknown): DesktopOpenTerminalInput {
  if (!isRecord(value)) {
    throw new Error("Open terminal input must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (key === "command") {
      throw new Error("Renderer must not provide terminal commands.");
    }
    if (key !== "ref" && key !== "recordId" && key !== "appId") {
      throw new Error(`Unsupported open terminal field '${key}'.`);
    }
  }
  if (
    value.recordId !== undefined &&
    value.recordId !== null &&
    (typeof value.recordId !== "string" || !value.recordId.trim())
  ) {
    throw new Error("Open terminal recordId is invalid.");
  }
  if (!isDesktopTerminalAppId(value.appId)) {
    throw new Error("Terminal app id is invalid.");
  }
  return {
    ref: parseDesktopCanvasReference(value.ref),
    recordId: value.recordId ?? null,
    appId: value.appId
  };
}

function parseRunTerminalAvailabilityInput(value: unknown): DesktopRunTerminalAvailabilityInput {
  if (!isRecord(value)) {
    throw new Error("Terminal availability input must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (key === "command") {
      throw new Error("Renderer must not provide terminal commands.");
    }
    if (key !== "ref" && key !== "recordIds") {
      throw new Error(`Unsupported terminal availability field '${key}'.`);
    }
  }
  if (
    !Array.isArray(value.recordIds) ||
    value.recordIds.some((recordId) => typeof recordId !== "string" || !recordId.trim())
  ) {
    throw new Error("Terminal availability recordIds are invalid.");
  }
  if (value.recordIds.length > maxRunTerminalAvailabilityRecordIds) {
    throw new Error(
      `Terminal availability recordIds must not exceed ${maxRunTerminalAvailabilityRecordIds}.`
    );
  }
  return {
    ref: parseDesktopCanvasReference(value.ref),
    recordIds: [...new Set(value.recordIds)]
  };
}

export const runtimeBridgeHandlers = {
  listProjects: () => listProjects(),
  chooseProjectFolder: async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  },
  chooseSourceRootFolder: async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
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
  revealTaskCanvasInFinder: async (_event, projectRoot, canvasId) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
    await shell.openPath(workspace.workspaceRoot);
  },
  revealTaskInFinder: async (_event, ref, taskId) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    const workspace = await resolveDesktopCanvasReference(ref);
    shell.showItemInFolder(await getTaskFileManagerPath(workspace, taskId));
  },
  detectAgentTools: () => detectAgentTools(),
  detectRuntimeTools: () => detectRuntimeTools(),
  detectTerminalApps: () => detectTerminalApps(),
  getTerminalPreferences: () => getTerminalPreferences(),
  updateTerminalPreferences: (_event, patch) => updateTerminalPreferences(patch),
  getRunTerminalAvailability: async (_event, input) =>
    getRunTerminalAvailability(parseRunTerminalAvailabilityInput(input)),
  openTerminal: async (_event, input) => {
    const parsedInput = parseOpenTerminalInput(input);
    await assertTerminalAppAvailable(parsedInput.appId);
    const intent = await resolveTerminalOpenIntent(parsedInput);
    await openTerminal(parsedInput.appId, intent);
    return {
      appId: parsedInput.appId,
      cwd: intent.cwd
    };
  },
  openRunTerminal: async (_event, input) => {
    const parsedInput = parseOpenRunTerminalInput(input);
    await assertTerminalAppAvailable(parsedInput.appId);
    const intent = await resolveTmuxAttachIntent(parsedInput);
    await launchRunTerminal(parsedInput.appId, intent);
    return {
      appId: parsedInput.appId,
      tmuxSessionId: intent.sessionName,
      mode: intent.mode
    };
  },
  testExecutorProfile: async (_event, ref, executorName) =>
    testExecutorProfile({ projectRoot: await resolveDesktopCanvasReference(ref), executorName }),
  openBlockInspectorWindow: (_event, input) => openBlockInspectorWindow(input),
  openTaskInspectorWindow: (_event, input) => openTaskInspectorWindow(input),
  openProject: (_event, input) => openProject(input),
  initOrOpenProject: (_event, rootPath) => initOrOpenProject(rootPath),
  removeProject: (_event, projectId) => removeProject(projectId),
  renameProject: (_event, projectId, name) => renameProject(projectId, name),
  linkProjectSourceRoot: (_event, projectId, sourceRoot) =>
    linkProjectSourceRoot(projectId, sourceRoot),
  unlinkProjectSourceRoot: (_event, projectId) => unlinkProjectSourceRoot(projectId),
  createTaskCanvas: (_event, projectRoot, input) => createTaskCanvas(projectRoot, input),
  duplicateTaskCanvas: (_event, projectRoot, canvasId, input) =>
    duplicateTaskCanvas(projectRoot, canvasId, input),
  createProjectFromTaskCanvas: (_event, projectRoot, canvasId, input) =>
    createProjectFromTaskCanvas(projectRoot, canvasId, input),
  renameTaskCanvas: (_event, projectRoot, canvasId, name) =>
    renameTaskCanvas(projectRoot, canvasId, name),
  removeTaskCanvas: (_event, projectRoot, canvasId) => removeTaskCanvas(projectRoot, canvasId),
  selectTaskCanvas: (_event, projectRoot, canvasId) => selectTaskCanvas(projectRoot, canvasId),
  getProjectOverview: (_event, projectRoot) => getProjectOverview(projectRoot),
  getCanvasGraphViewModel: (_event, projectRoot) => getCanvasGraphViewModel(projectRoot),
  getCanvasMapLayout: (_event, projectRoot) => getCanvasMapLayout(projectRoot),
  saveCanvasMapLayout: (_event, projectRoot, layout: DesktopCanvasMapLayout) =>
    saveCanvasMapLayout(projectRoot, layout),
  resetCanvasMapLayout: (_event, projectRoot) => resetCanvasMapLayout(projectRoot),
  getDesktopProjectSnapshot: (_event, ref) => getDesktopProjectSnapshot(ref),
  getDesktopRuntimeRefresh: (_event, ref) => getDesktopRuntimeRefresh(ref),
  getDesktopGraphDiagnostics: async (_event, ref) =>
    getDesktopGraphDiagnostics(await resolveDesktopCanvasReference(ref)),
  getGraphViewModel: async (_event, ref) =>
    getGraphViewModel(await resolveDesktopCanvasReference(ref)),
  getTaskDetail: async (_event, ref, taskId) =>
    getTaskDetail(await resolveDesktopCanvasReference(ref), taskId),
  getBlockDetail: async (_event, ref, blockRef) =>
    getBlockDetail(await resolveDesktopCanvasReference(ref), blockRef),
  getTaskExecutionOrder: async (_event, ref, taskId) =>
    getTaskExecutionOrder(await resolveDesktopCanvasReference(ref), taskId),
  getTodoGroups: (_event, projectRoot) => getTodoGroups(projectRoot),
  getProjectExecutionPlan: (_event, projectRoot) => getProjectExecutionPlan(projectRoot),
  readProjectPrompt: (_event, projectRoot) => readProjectPrompt(projectRoot),
  updateProjectPrompt: (_event, projectRoot, markdown) =>
    updateProjectPrompt(projectRoot, markdown),
  readProjectPromptPolicy: (_event, projectRoot) => readProjectPromptPolicy(projectRoot),
  updateProjectPromptPolicy: (_event, projectRoot, patch) =>
    updateProjectPromptPolicy(projectRoot, patch),
  listPendingImportRecoveries: (_event, projectRoot) => listPendingImportRecoveries(projectRoot),
  rollbackPendingImportRecovery: (_event, projectRoot, transactionId) =>
    rollbackPendingImportRecovery(projectRoot, transactionId),
  listBlockRunRecords: async (_event, ref, blockRef) =>
    listBlockRunRecords(await resolveDesktopCanvasReference(ref), blockRef),
  getRunRecord: async (_event, ref, recordId) =>
    getRunRecord(await resolveDesktopCanvasReference(ref), recordId),
  listPendingAgentRequests: (_event, identity) =>
    listDesktopPendingAgentRequests(desktopAgentActionIdentitySchema.parse(identity)),
  respondToAgentRequest: (_event, identity, value) =>
    respondToDesktopAgentRequest(
      desktopAgentActionIdentitySchema.parse(identity),
      desktopAgentActionValueSchema.parse(value)
    ),
  getReviewAttempts: async (_event, ref, blockRef) =>
    getReviewAttempts(await resolveDesktopCanvasReference(ref), blockRef),
  getFeedbackRecords: async (_event, ref, blockRef) =>
    getFeedbackRecords(await resolveDesktopCanvasReference(ref), blockRef),
  getReviewPipeline: async (_event, ref, taskId) =>
    getReviewPipeline(await resolveDesktopCanvasReference(ref), taskId),
  updateReviewPipeline: async (_event, ref, taskId, input) =>
    invokeGraphEdit(updateReviewPipeline(await resolveDesktopCanvasReference(ref), taskId, input)),
  getStatistics: (_event, projectRoot) => getStatistics(projectRoot),
  searchProject: (_event, projectRoot, query, filters) =>
    searchProject(projectRoot, query, filters),
  searchProjectWithDiagnostics: (_event, projectRoot, query, filters) =>
    searchProjectWithDiagnostics(projectRoot, query, filters),
  createTaskDraft: async (_event, ref, input) =>
    createTaskDraft(await resolveDesktopCanvasReference(ref), input),
  addTaskNode: async (_event, ref, input) =>
    invokeGraphEdit(addTaskNode(await resolveDesktopCanvasReference(ref), input)),
  addBlock: async (_event, ref, input) =>
    invokeGraphEdit(addBlock(await resolveDesktopCanvasReference(ref), input)),
  removeTaskNode: async (_event, ref, taskId) =>
    invokeGraphEdit(removeTaskNode(await resolveDesktopCanvasReference(ref), taskId)),
  removeBlock: async (_event, ref, blockRef) =>
    invokeGraphEdit(removeBlock(await resolveDesktopCanvasReference(ref), blockRef)),
  validateGraphEdit: async (_event, ref, input) =>
    invokeGraphEdit(validateGraphEdit(await resolveDesktopCanvasReference(ref), input)),
  updateTaskTitle: async (_event, ref, taskId, title) =>
    invokeGraphEdit(updateTaskTitle(await resolveDesktopCanvasReference(ref), taskId, title)),
  updateTaskPrompt: async (_event, ref, taskId, markdown, options) =>
    invokeGraphEdit(
      updateTaskPrompt(await resolveDesktopCanvasReference(ref), taskId, markdown, options)
    ),
  updateBlockTitle: async (_event, ref, blockRef, title) =>
    invokeGraphEdit(updateBlockTitle(await resolveDesktopCanvasReference(ref), blockRef, title)),
  updateBlockPrompt: async (_event, ref, blockRef, markdown, options) =>
    invokeGraphEdit(
      updateBlockPrompt(await resolveDesktopCanvasReference(ref), blockRef, markdown, options)
    ),
  updateTaskExecutor: async (_event, ref, taskId, executorName) =>
    invokeGraphEdit(
      updateTaskExecutor(await resolveDesktopCanvasReference(ref), taskId, executorName)
    ),
  updateBlockExecutor: async (_event, ref, blockRef, executorName) =>
    invokeGraphEdit(
      updateBlockExecutor(await resolveDesktopCanvasReference(ref), blockRef, executorName)
    ),
  updateCanvasExecutionPolicy: async (_event, ref, input) =>
    invokeGraphEdit(updateCanvasExecutionPolicy(await resolveDesktopCanvasReference(ref), input)),
  addDependencyEdge: async (_event, ref, fromTaskId, toTaskId, baseGraphVersion, layoutSnapshot) =>
    invokeGraphEdit(
      addDependencyEdge(
        await resolveDesktopCanvasReference(ref),
        fromTaskId,
        toTaskId,
        baseGraphVersion,
        layoutSnapshot
      )
    ),
  removeDependencyEdge: async (
    _event,
    ref,
    fromTaskId,
    toTaskId,
    baseGraphVersion,
    layoutSnapshot
  ) =>
    invokeGraphEdit(
      removeDependencyEdge(
        await resolveDesktopCanvasReference(ref),
        fromTaskId,
        toTaskId,
        baseGraphVersion,
        layoutSnapshot
      )
    ),
  reconnectDependencyEdge: async (
    _event,
    ref,
    fromTaskId,
    oldToTaskId,
    newFromTaskId,
    newToTaskId,
    baseGraphVersion,
    layoutSnapshot
  ) =>
    invokeGraphEdit(
      reconnectDependencyEdge(
        await resolveDesktopCanvasReference(ref),
        fromTaskId,
        oldToTaskId,
        newFromTaskId,
        newToTaskId,
        baseGraphVersion,
        layoutSnapshot
      )
    ),
  undoPlanGraphCommand: async (_event, ref) =>
    invokeGraphEdit(undoDesktopPlanGraphCommand(await resolveDesktopCanvasReference(ref))),
  redoPlanGraphCommand: async (_event, ref) =>
    invokeGraphEdit(redoDesktopPlanGraphCommand(await resolveDesktopCanvasReference(ref))),
  getDesktopLayout: async (_event, ref) =>
    getDesktopLayout(await resolveDesktopCanvasReference(ref)),
  saveDesktopLayout: async (_event, ref, layout: DesktopLayout) =>
    saveDesktopLayout(await resolveDesktopCanvasReference(ref), layout),
  resetDesktopLayout: async (_event, ref) =>
    resetDesktopLayout(await resolveDesktopCanvasReference(ref)),
  applyCanvasLaneLayout: async (_event, ref) =>
    applyCanvasLaneLayout(await resolveDesktopCanvasReference(ref)),
  createPackageFileSnapshot: async (_event, ref) =>
    createDesktopPackageFileSnapshot(await resolveDesktopCanvasReference(ref)),
  detectPackageFileChanges: async (_event, ref, snapshotId) =>
    detectDesktopPackageFileChanges(await resolveDesktopCanvasReference(ref), snapshotId),
  refreshChangedPackagePrompts: async (_event, ref, snapshotId) =>
    refreshChangedDesktopPackagePrompts(await resolveDesktopCanvasReference(ref), snapshotId),
  refreshPackageFileChanges: async (_event, ref, options) =>
    refreshPackageFileChanges(await resolveDesktopCanvasReference(ref), options),
  getDirtyPromptRefs: async (_event, ref) =>
    getDirtyPromptRefs(await resolveDesktopCanvasReference(ref)),
  startAutoRun: (
    _event,
    ref,
    scope: DesktopAutoRunScope,
    stepLimit,
    options?: DesktopAutoRunOptions
  ) => startAutoRun(ref.projectRoot, ref.canvasId, scope, stepLimit, options),
  resetRuntimeState: (_event, ref, options?: DesktopRuntimeResetOptions) =>
    resetDesktopRuntimeState(ref.projectRoot, ref.canvasId, options),
  unblockBlock: async (_event, ref, blockRef, reason) => {
    await unblockBlock({
      projectRoot: await resolveDesktopCanvasReference(ref),
      ref: blockRef,
      reason
    });
  },
  markBlockedBlock: async (_event, ref, blockRef, reason) => {
    await markBlockBlocked({
      projectRoot: await resolveDesktopCanvasReference(ref),
      ref: blockRef,
      reason
    });
  },
  dispatchBlock: async (_event, ref, blockRef) =>
    claimBlock({
      projectRoot: await resolveDesktopCanvasReference(ref),
      ref: blockRef,
      dispatch: true
    }),
  pauseAutoRun: (_event, runId) => pauseAutoRun(runId),
  resumeAutoRun: (_event, runId) => resumeAutoRun(runId),
  stopAutoRun: (_event, runId) => stopAutoRun(runId),
  getAutoRunState: (_event, runId) => getAutoRunState(runId),
  getLatestAutoRunSummary: (_event, ref) => getLatestAutoRunSummary(ref.projectRoot, ref.canvasId),
  getLatestAutoRunSummaryWithDiagnostics: (_event, ref) =>
    getLatestAutoRunSummaryWithDiagnostics(ref.projectRoot, ref.canvasId),
  getAutoRunRetrospective: (_event, ref, runId) =>
    getAutoRunRetrospective(ref.projectRoot, ref.canvasId, runId),
  getLatestAutoRunRetrospective: (_event, ref) =>
    getLatestAutoRunRetrospective(ref.projectRoot, ref.canvasId)
} satisfies RuntimeBridgeHandlerMap;

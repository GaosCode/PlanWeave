import {
  BrowserWindow,
  dialog,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from "electron";
import { z } from "zod";
import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  applyCanvasLaneLayout,
  cancelDesktopAgentRun,
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
  listPendingRunnerInteractions,
  RunnerInteractionApiError,
  getStatistics,
  getTaskDetail,
  getTaskFileManagerPath,
  getTaskExecutionOrder,
  getTaskWorkspace,
  getTaskWorkspaceRunDetail,
  listTaskWorkspaceRuns,
  retryTaskWorkspaceRun,
  getTodoGroups,
  initOrOpenProject,
  linkProjectSourceRoot,
  listBlockRunRecords,
  listPendingImportRecoveries,
  listProjects,
  openProject,
  pauseAutoRun,
  probeDesktopAgentCapabilities,
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
  resolveRunRecordArtifactPath,
  resolveTaskCanvasWorkspace,
  resumeAutoRun,
  respondToDesktopAgentRequest,
  respondToDesktopAgentAuthenticationRequest,
  respondToRunnerInteractionAction,
  sendAgentPrompt,
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
import {
  detectDevelopmentTools,
  isDesktopDevelopmentToolId,
  openProjectInDevelopmentTool
} from "./codeEditors.js";
import type {
  DesktopAutoRunOptions,
  DesktopAutoRunScope,
  DesktopBridgeApi,
  DesktopCanvasReference,
  DesktopGraphEditResult,
  DesktopLayout,
  DesktopOpenRunTerminalInput,
  DesktopOpenTerminalInput,
  DesktopRunTerminalAvailabilityInput,
  DesktopRuntimeResetOptions,
  GraphEditResult,
  TaskWorkspace,
  TaskWorkspaceInput,
  TaskWorkspaceRunDetail,
  TaskWorkspaceRunsPage
} from "@planweave-ai/runtime";
import {
  desktopAgentActionIdentitySchema,
  desktopAgentPromptIdentitySchema,
  desktopAgentPromptTextSchema,
  desktopAgentSessionActionIdentitySchema,
  desktopAgentActionValueSchema,
  agentRunControlRespondOutcomeSchema,
  runnerInteractionActionIdentitySchema,
  runnerInteractionAuditSchema,
  runnerInteractionCanvasRefSchema,
  runnerInteractionErrorCodeSchema,
  listPendingRunnerInteractionsResultSchema,
  respondToRunnerInteractionResultSchema,
  runnerPermissionInteractionDecisionSchema,
  taskWorkspaceInputSchema,
  taskWorkspaceListRunsInputSchema,
  taskWorkspaceRetryIdentitySchema,
  taskWorkspaceRunDetailInputSchema,
  taskWorkspaceRunDetailSchema,
  taskWorkspaceRunsPageSchema,
  taskWorkspaceSchema
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

function isValidationFailure(error: unknown): error is {
  issues: { path: PropertyKey[]; message: string }[];
} {
  if (!isRecord(error) || !Array.isArray(error.issues)) return false;
  return error.issues.every(
    (issue) =>
      isRecord(issue) &&
      Array.isArray(issue.path) &&
      issue.path.every((segment) => ["string", "number", "symbol"].includes(typeof segment)) &&
      typeof issue.message === "string"
  );
}

function validationFailureMessage(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "input" : issue.path.map(String).join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function runnerInteractionFailure(error: unknown) {
  const runtimeError =
    error instanceof RunnerInteractionApiError ||
    (isRecord(error) && error.name === "RunnerInteractionApiError")
      ? error
      : null;
  const errorCode = runnerInteractionErrorCodeSchema.safeParse(runtimeError?.code);
  if (runtimeError && errorCode.success && typeof runtimeError.message === "string") {
    const details = z.json().safeParse(runtimeError.details);
    return {
      ok: false as const,
      error: {
        code: errorCode.data,
        message: runtimeError.message,
        details: details.success ? details.data : null
      }
    };
  }
  if (isValidationFailure(error)) {
    return {
      ok: false as const,
      error: {
        code: "interaction_contract_invalid" as const,
        message: validationFailureMessage(error),
        details: null
      }
    };
  }
  return {
    ok: false as const,
    error: {
      code: "interaction_contract_invalid" as const,
      message: "Runner interaction IPC boundary failed.",
      details: null
    }
  };
}

function assertTaskWorkspaceResponseIdentity(
  input: TaskWorkspaceInput,
  result: TaskWorkspace
): void {
  const identityFields = [
    ["project.projectRoot", result.project.projectRoot, input.projectRoot],
    ["project.canvasId", result.project.canvasId, input.canvasId],
    ["task.taskId", result.task.taskId, input.taskId]
  ] as const;
  for (const [path, actual, expected] of identityFields) {
    if (actual !== expected) {
      throw new Error(
        `invalid Runtime response identity: ${path} '${actual}' does not match request '${expected}'.`
      );
    }
  }
  if (input.selectedRecordId != null && result.selectedRecordId !== input.selectedRecordId) {
    throw new Error(
      `invalid Runtime response identity: selectedRecordId '${result.selectedRecordId}' does not match request '${input.selectedRecordId}'.`
    );
  }
}

async function invokeTaskWorkspace(input: unknown) {
  const parsedInput = taskWorkspaceInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error(
      `Task Workspace request failed: ${validationFailureMessage(parsedInput.error)}`
    );
  }
  try {
    const result = await getTaskWorkspace(parsedInput.data);
    const parsedResult = taskWorkspaceSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new Error(`invalid Runtime response: ${validationFailureMessage(parsedResult.error)}`);
    }
    assertTaskWorkspaceResponseIdentity(parsedInput.data, parsedResult.data);
    return parsedResult.data;
  } catch (error) {
    const message = isValidationFailure(error)
      ? validationFailureMessage(error)
      : error instanceof Error && error.message.trim()
        ? error.message
        : "unknown Runtime error";
    throw new Error(`Task Workspace request failed: ${message}`);
  }
}

function assertTaskWorkspaceScopeIdentity(
  input: { projectRoot: string; canvasId: string; taskId: string },
  result: { projectRoot: string; canvasId: string; taskId: string },
  label: string
): void {
  const identityFields = [
    ["projectRoot", result.projectRoot, input.projectRoot],
    ["canvasId", result.canvasId, input.canvasId],
    ["taskId", result.taskId, input.taskId]
  ] as const;
  for (const [path, actual, expected] of identityFields) {
    if (actual !== expected) {
      throw new Error(
        `invalid Runtime response identity: ${path} '${actual}' does not match request '${expected}'.`
      );
    }
  }
  void label;
}

async function invokeTaskWorkspaceRuns(input: unknown): Promise<TaskWorkspaceRunsPage> {
  const parsedInput = taskWorkspaceListRunsInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error(
      `Task Workspace runs request failed: ${validationFailureMessage(parsedInput.error)}`
    );
  }
  try {
    const result = await listTaskWorkspaceRuns(parsedInput.data);
    const parsedResult = taskWorkspaceRunsPageSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new Error(`invalid Runtime response: ${validationFailureMessage(parsedResult.error)}`);
    }
    assertTaskWorkspaceScopeIdentity(parsedInput.data, parsedResult.data, "runs page");
    return parsedResult.data;
  } catch (error) {
    const message = isValidationFailure(error)
      ? validationFailureMessage(error)
      : error instanceof Error && error.message.trim()
        ? error.message
        : "unknown Runtime error";
    throw new Error(`Task Workspace runs request failed: ${message}`);
  }
}

async function invokeTaskWorkspaceRunDetail(input: unknown): Promise<TaskWorkspaceRunDetail> {
  const parsedInput = taskWorkspaceRunDetailInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error(
      `Task Workspace run detail request failed: ${validationFailureMessage(parsedInput.error)}`
    );
  }
  try {
    const result = await getTaskWorkspaceRunDetail(parsedInput.data);
    const parsedResult = taskWorkspaceRunDetailSchema.safeParse(result);
    if (!parsedResult.success) {
      throw new Error(`invalid Runtime response: ${validationFailureMessage(parsedResult.error)}`);
    }
    assertTaskWorkspaceScopeIdentity(parsedInput.data, parsedResult.data, "run detail");
    if (parsedResult.data.record.recordId !== parsedInput.data.recordId) {
      throw new Error(
        `invalid Runtime response identity: record.recordId '${parsedResult.data.record.recordId}' does not match request '${parsedInput.data.recordId}'.`
      );
    }
    return parsedResult.data;
  } catch (error) {
    const message = isValidationFailure(error)
      ? validationFailureMessage(error)
      : error instanceof Error && error.message.trim()
        ? error.message
        : "unknown Runtime error";
    throw new Error(`Task Workspace run detail request failed: ${message}`);
  }
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
  openProjectInDevelopmentTool: async (_event, rootPath, toolId) => {
    if (!isDesktopDevelopmentToolId(toolId)) {
      throw new Error("Development tool id is invalid.");
    }
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      return;
    }
    await openProjectInDevelopmentTool(rootPath, toolId);
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
  revealRunnerRecordArtifact: async (_event, ref, recordId, artifact) => {
    const path = await resolveRunRecordArtifactPath(
      await resolveDesktopCanvasReference(ref),
      recordId,
      artifact
    );
    if (process.env.PLANWEAVE_DESKTOP_SMOKE !== "1") shell.showItemInFolder(path);
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
  detectDevelopmentTools: () => detectDevelopmentTools(),
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
  probeDesktopAgentCapabilities: (_event, input) => probeDesktopAgentCapabilities(input),
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
  // IPC payload is untrusted; runtime saveCanvasMapLayout parses with Zod.
  saveCanvasMapLayout: (_event, projectRoot: string, layout: unknown) =>
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
  getTaskWorkspace: (_event, input) => invokeTaskWorkspace(input),
  listTaskWorkspaceRuns: (_event, input) => invokeTaskWorkspaceRuns(input),
  getTaskWorkspaceRunDetail: (_event, input) => invokeTaskWorkspaceRunDetail(input),
  retryTaskWorkspaceRun: (_event, identity) =>
    retryTaskWorkspaceRun(taskWorkspaceRetryIdentitySchema.parse(identity)),
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
  listPendingRunnerInteractions: async (_event, ref) => {
    try {
      return listPendingRunnerInteractionsResultSchema.parse({
        ok: true,
        value: await listPendingRunnerInteractions(runnerInteractionCanvasRefSchema.parse(ref))
      });
    } catch (error) {
      return listPendingRunnerInteractionsResultSchema.parse(runnerInteractionFailure(error));
    }
  },
  respondToAgentRequest: (_event, ref, recordId, identity, outcome) =>
    respondToDesktopAgentRequest(
      ref,
      recordId,
      desktopAgentActionIdentitySchema.parse(identity),
      agentRunControlRespondOutcomeSchema.parse(outcome)
    ),
  respondToAgentAuthenticationRequest: (_event, identity, value) =>
    respondToDesktopAgentAuthenticationRequest(
      desktopAgentActionIdentitySchema.parse(identity),
      desktopAgentActionValueSchema.parse(value)
    ),
  respondToRunnerInteraction: async (_event, ref, action, decision, audit) => {
    try {
      return respondToRunnerInteractionResultSchema.parse({
        ok: true,
        value: await respondToRunnerInteractionAction(
          runnerInteractionCanvasRefSchema.parse(ref),
          runnerInteractionActionIdentitySchema.parse(action),
          runnerPermissionInteractionDecisionSchema.parse(decision),
          runnerInteractionAuditSchema.parse(audit)
        )
      });
    } catch (error) {
      return respondToRunnerInteractionResultSchema.parse(runnerInteractionFailure(error));
    }
  },
  cancelAgentRun: (_event, ref, recordId, identity) =>
    cancelDesktopAgentRun(
      ref,
      recordId,
      desktopAgentSessionActionIdentitySchema.parse(identity)
    ),
  sendAgentPrompt: (_event, identity, text) =>
    sendAgentPrompt(
      desktopAgentPromptIdentitySchema.parse(identity),
      desktopAgentPromptTextSchema.parse(text)
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

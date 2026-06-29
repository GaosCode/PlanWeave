import type {
  DesktopAddBlockInput,
  DesktopAddTaskInput,
  DesktopBlockDetail,
  DesktopCanvasGraphViewModel,
  DesktopCanvasMapLayout,
  DesktopGraphEditResult,
  DesktopGraphEditValidationInput,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectExecutionPlan,
  DesktopProjectSnapshot,
  DesktopSearchFilters,
  DesktopSearchResult,
  DesktopStatistics,
  DesktopTaskDetail,
  DesktopTaskDraft,
  DesktopTaskDraftMode,
  DesktopTaskExecutionOrder,
  DesktopTodoGroups
} from "./graphTypes.js";
import type { DesktopProjectSummary, DesktopTaskCanvasSummary } from "./projectTypes.js";
import type { ProjectPromptPolicy } from "../../projectPromptPolicy.js";
import type {
  DesktopBlockRunRecordSummary,
  DesktopFeedbackRecord,
  DesktopReviewAttemptSummary,
  DesktopRunRecord
} from "./recordsTypes.js";
import type {
  DesktopReviewPipeline,
  DesktopUpdateReviewPipelineInput
} from "./reviewPipelineTypes.js";
import type {
  DesktopPackageFileChangeEvent,
  DesktopPackageFileRefreshOptions,
  DesktopPackageFileSyncResult,
  DesktopPackageFileSnapshotRef
} from "./syncTypes.js";
import type {
  DesktopAutoRunEvent,
  DesktopAutoRunOptions,
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopRuntimeResetOptions,
  DesktopRuntimeResetResult
} from "./runTypes.js";
import type { ExecutorPreflightResult } from "../../autoRun/executorPreflightTypes.js";

export type DesktopAgentKind = "codex" | "claude-code" | "opencode" | "pi";

export type DesktopAgentCliProfile = {
  kind: DesktopAgentKind;
  name: string;
  command: string;
  versionArgs: string[];
  execArgs: string[];
  fullAccessArgs: string[];
};

export type DesktopAgentDetection = DesktopAgentCliProfile & {
  installed: boolean;
  version: string | null;
  unavailableReason: string | null;
};

export type DesktopRuntimeToolAvailability = {
  tmux: {
    available: boolean;
    command: "tmux";
  };
};

export type DesktopTerminalAppId = "terminal" | "iterm2" | "ghostty";

export type DesktopTerminalAttachMode = "readOnly" | "interactive";

export type DesktopTerminalAppDetection = {
  appId: DesktopTerminalAppId;
  label: string;
  available: boolean;
  iconDataUrl: string | null;
  unavailableReason: string | null;
};

export type DesktopOpenRunTerminalInput = {
  ref: DesktopCanvasReference;
  recordId: string;
  appId: DesktopTerminalAppId;
  mode?: DesktopTerminalAttachMode;
};

export type DesktopOpenRunTerminalResult = {
  appId: DesktopTerminalAppId;
  tmuxSessionId: string;
  mode: DesktopTerminalAttachMode;
};

export type DesktopOpenTerminalInput = {
  ref: DesktopCanvasReference;
  appId: DesktopTerminalAppId;
  recordId?: string | null;
};

export type DesktopOpenTerminalResult = {
  appId: DesktopTerminalAppId;
  cwd: string;
};

export type DesktopTerminalPreferences = {
  defaultTerminalAppId: DesktopTerminalAppId | null;
};

export type DesktopRunTerminalUnavailableReason =
  | "no_tmux_session"
  | "tmux_unavailable"
  | "tmux_session_not_running"
  | "record_unavailable";

export type DesktopRunTerminalAvailabilityInput = {
  ref: DesktopCanvasReference;
  recordIds: string[];
};

export type DesktopRunTerminalAvailability = {
  recordId: string;
  tmuxSessionId: string | null;
  available: boolean;
  unavailableReason: DesktopRunTerminalUnavailableReason | null;
};

export type DesktopCanvasReference = {
  projectRoot: string;
  canvasId?: string | null;
};

export type DesktopPromptSaveOptions = {
  baseGraphVersion?: string;
  basePromptHash?: string;
};

export type DesktopBridgeApi = {
  listProjects(): Promise<DesktopProjectSummary[]>;
  chooseProjectFolder(): Promise<string | null>;
  chooseSourceRootFolder(): Promise<string | null>;
  revealProjectInFinder(rootPath: string): Promise<void>;
  revealPathInFinder(path: string): Promise<void>;
  detectAgentTools(): Promise<DesktopAgentDetection[]>;
  detectRuntimeTools(): Promise<DesktopRuntimeToolAvailability>;
  detectTerminalApps(): Promise<DesktopTerminalAppDetection[]>;
  getTerminalPreferences(): Promise<DesktopTerminalPreferences>;
  updateTerminalPreferences(patch: Partial<DesktopTerminalPreferences>): Promise<DesktopTerminalPreferences>;
  getRunTerminalAvailability(input: DesktopRunTerminalAvailabilityInput): Promise<DesktopRunTerminalAvailability[]>;
  openTerminal(input: DesktopOpenTerminalInput): Promise<DesktopOpenTerminalResult>;
  openRunTerminal(input: DesktopOpenRunTerminalInput): Promise<DesktopOpenRunTerminalResult>;
  testExecutorProfile(ref: DesktopCanvasReference, executorName: string): Promise<ExecutorPreflightResult>;
  openBlockInspectorWindow(input: { blockRef: string; canvas: DesktopCanvasReference; language: string }): Promise<void>;
  openTaskInspectorWindow(input: { taskId: string; canvas: DesktopCanvasReference; language: string }): Promise<void>;
  openProject(input: { projectId?: string; rootPath?: string }): Promise<DesktopProjectSummary>;
  initOrOpenProject(rootPath: string): Promise<DesktopProjectSummary>;
  removeProject(projectId: string): Promise<void>;
  linkProjectSourceRoot(projectId: string, sourceRoot: string): Promise<DesktopProjectSummary>;
  unlinkProjectSourceRoot(projectId: string): Promise<DesktopProjectSummary>;
  createTaskCanvas(projectRoot: string, input?: { name?: string | null }): Promise<DesktopTaskCanvasSummary>;
  renameTaskCanvas(projectRoot: string, canvasId: string, name: string): Promise<DesktopTaskCanvasSummary>;
  removeTaskCanvas(projectRoot: string, canvasId: string): Promise<DesktopTaskCanvasSummary[]>;
  selectTaskCanvas(projectRoot: string, canvasId: string): Promise<string>;
  getProjectOverview(projectRoot: string): Promise<DesktopProjectSummary>;
  getCanvasGraphViewModel(projectRoot: string): Promise<DesktopCanvasGraphViewModel>;
  getCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout>;
  saveCanvasMapLayout(projectRoot: string, layout: DesktopCanvasMapLayout): Promise<DesktopCanvasMapLayout>;
  resetCanvasMapLayout(projectRoot: string): Promise<DesktopCanvasMapLayout>;
  getDesktopProjectSnapshot(ref: DesktopCanvasReference): Promise<DesktopProjectSnapshot>;
  getGraphViewModel(ref: DesktopCanvasReference): Promise<DesktopGraphViewModel>;
  getTaskDetail(ref: DesktopCanvasReference, taskId: string): Promise<DesktopTaskDetail>;
  getBlockDetail(ref: DesktopCanvasReference, blockRef: string): Promise<DesktopBlockDetail>;
  getTaskExecutionOrder(ref: DesktopCanvasReference, taskId: string): Promise<DesktopTaskExecutionOrder>;
  getTodoGroups(projectRoot: string): Promise<DesktopTodoGroups>;
  getProjectExecutionPlan(projectRoot: string): Promise<DesktopProjectExecutionPlan>;
  readProjectPrompt(projectRoot: string): Promise<string>;
  updateProjectPrompt(projectRoot: string, markdown: string): Promise<string>;
  readProjectPromptPolicy(projectRoot: string): Promise<ProjectPromptPolicy>;
  updateProjectPromptPolicy(projectRoot: string, patch: Partial<ProjectPromptPolicy>): Promise<ProjectPromptPolicy>;
  listBlockRunRecords(ref: DesktopCanvasReference, blockRef: string): Promise<DesktopBlockRunRecordSummary[]>;
  getRunRecord(ref: DesktopCanvasReference, recordId: string): Promise<DesktopRunRecord>;
  getReviewAttempts(ref: DesktopCanvasReference, blockRef: string): Promise<DesktopReviewAttemptSummary[]>;
  getFeedbackRecords(ref: DesktopCanvasReference, blockRef: string): Promise<DesktopFeedbackRecord[]>;
  getReviewPipeline(ref: DesktopCanvasReference, taskId: string): Promise<DesktopReviewPipeline>;
  updateReviewPipeline(ref: DesktopCanvasReference, taskId: string, input: DesktopUpdateReviewPipelineInput): Promise<DesktopGraphEditResult>;
  createTaskDraft(ref: DesktopCanvasReference, input: { mode: DesktopTaskDraftMode; text: string; targetTaskId?: string | null }): Promise<DesktopTaskDraft>;
  addTaskNode(ref: DesktopCanvasReference, input: DesktopAddTaskInput): Promise<DesktopGraphEditResult>;
  addBlock(ref: DesktopCanvasReference, input: DesktopAddBlockInput): Promise<DesktopGraphEditResult>;
  removeTaskNode(ref: DesktopCanvasReference, taskId: string): Promise<DesktopGraphEditResult>;
  removeBlock(ref: DesktopCanvasReference, blockRef: string): Promise<DesktopGraphEditResult>;
  validateGraphEdit(ref: DesktopCanvasReference, input: DesktopGraphEditValidationInput): Promise<DesktopGraphEditResult>;
  updateTaskTitle(ref: DesktopCanvasReference, taskId: string, title: string): Promise<DesktopGraphEditResult>;
  updateTaskPrompt(ref: DesktopCanvasReference, taskId: string, markdown: string, options?: DesktopPromptSaveOptions): Promise<DesktopGraphEditResult>;
  updateBlockTitle(ref: DesktopCanvasReference, blockRef: string, title: string): Promise<DesktopGraphEditResult>;
  updateBlockPrompt(ref: DesktopCanvasReference, blockRef: string, markdown: string, options?: DesktopPromptSaveOptions): Promise<DesktopGraphEditResult>;
  updateTaskExecutor(ref: DesktopCanvasReference, taskId: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  updateBlockExecutor(ref: DesktopCanvasReference, blockRef: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  addDependencyEdge(
    ref: DesktopCanvasReference,
    fromTaskId: string,
    toTaskId: string,
    baseGraphVersion?: string,
    layoutSnapshot?: DesktopLayout
  ): Promise<DesktopGraphEditResult>;
  removeDependencyEdge(
    ref: DesktopCanvasReference,
    fromTaskId: string,
    toTaskId: string,
    baseGraphVersion?: string,
    layoutSnapshot?: DesktopLayout
  ): Promise<DesktopGraphEditResult>;
  reconnectDependencyEdge(
    ref: DesktopCanvasReference,
    fromTaskId: string,
    oldToTaskId: string,
    newFromTaskId: string,
    newToTaskId: string,
    baseGraphVersion?: string,
    layoutSnapshot?: DesktopLayout
  ): Promise<DesktopGraphEditResult>;
  undoPlanGraphCommand(ref: DesktopCanvasReference): Promise<DesktopGraphEditResult>;
  redoPlanGraphCommand(ref: DesktopCanvasReference): Promise<DesktopGraphEditResult>;
  getDesktopLayout(ref: DesktopCanvasReference): Promise<DesktopLayout>;
  saveDesktopLayout(ref: DesktopCanvasReference, layout: DesktopLayout): Promise<DesktopLayout>;
  resetDesktopLayout(ref: DesktopCanvasReference): Promise<DesktopLayout>;
  createPackageFileSnapshot(ref: DesktopCanvasReference): Promise<DesktopPackageFileSnapshotRef>;
  detectPackageFileChanges(ref: DesktopCanvasReference, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshChangedPackagePrompts(ref: DesktopCanvasReference, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshPackageFileChanges(ref: DesktopCanvasReference, options?: DesktopPackageFileRefreshOptions): Promise<DesktopPackageFileSyncResult>;
  getDirtyPromptRefs(ref: DesktopCanvasReference): Promise<string[]>;
  watchPackageFiles(ref: DesktopCanvasReference): Promise<void>;
  unwatchPackageFiles(ref: DesktopCanvasReference): Promise<void>;
  onPackageFileChanged(callback: (event: DesktopPackageFileChangeEvent) => void): () => void;
  onAutoRunChanged(callback: (event: DesktopAutoRunEvent) => void): () => void;
  startAutoRun(ref: DesktopCanvasReference, scope: DesktopAutoRunScope, stepLimit?: number, options?: DesktopAutoRunOptions): Promise<DesktopAutoRunState>;
  resetRuntimeState(ref: DesktopCanvasReference, options?: DesktopRuntimeResetOptions): Promise<DesktopRuntimeResetResult>;
  unblockBlock(ref: DesktopCanvasReference, blockRef: string, reason: string): Promise<void>;
  pauseAutoRun(runId: string): Promise<DesktopAutoRunState>;
  resumeAutoRun(runId: string): Promise<DesktopAutoRunState>;
  stopAutoRun(runId: string): Promise<DesktopAutoRunState>;
  getAutoRunState(runId: string): Promise<DesktopAutoRunState>;
  getLatestAutoRunSummary(ref: DesktopCanvasReference): Promise<DesktopAutoRunState | null>;
  getAutoRunRetrospective(ref: DesktopCanvasReference, runId: string): Promise<DesktopAutoRunRetrospectiveSummary>;
  getLatestAutoRunRetrospective(ref: DesktopCanvasReference): Promise<DesktopAutoRunRetrospectiveSummary | null>;
  getStatistics(projectRoot: string): Promise<DesktopStatistics>;
  searchProject(projectRoot: string, query: string, filters?: DesktopSearchFilters): Promise<DesktopSearchResult[]>;
};

import type {
  DesktopAddBlockInput,
  DesktopAddTaskInput,
  DesktopBlockDetail,
  DesktopGraphEditResult,
  DesktopGraphEditValidationInput,
  DesktopGraphViewModel,
  DesktopLayout,
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
  DesktopPackageFileSyncResult,
  DesktopPackageFileSnapshotRef
} from "./syncTypes.js";
import type {
  DesktopAutoRunOptions,
  DesktopAutoRunScope,
  DesktopAutoRunState
} from "./runTypes.js";

export type DesktopAgentKind = "codex" | "claude-code" | "opencode";

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

export type DesktopCanvasReference = {
  projectRoot: string;
  canvasId?: string | null;
};

export type DesktopBridgeApi = {
  listProjects(): Promise<DesktopProjectSummary[]>;
  chooseProjectFolder(): Promise<string | null>;
  revealProjectInFinder(rootPath: string): Promise<void>;
  revealPathInFinder(path: string): Promise<void>;
  detectAgentTools(): Promise<DesktopAgentDetection[]>;
  detectRuntimeTools(): Promise<DesktopRuntimeToolAvailability>;
  openBlockInspectorWindow(input: { blockRef: string; canvas: DesktopCanvasReference; language: string }): Promise<void>;
  openTaskInspectorWindow(input: { taskId: string; canvas: DesktopCanvasReference; language: string }): Promise<void>;
  openProject(input: { projectId?: string; rootPath?: string }): Promise<DesktopProjectSummary>;
  initOrOpenProject(rootPath: string): Promise<DesktopProjectSummary>;
  removeProject(projectId: string): Promise<void>;
  createTaskCanvas(projectRoot: string, input?: { name?: string | null }): Promise<DesktopTaskCanvasSummary>;
  removeTaskCanvas(projectRoot: string, canvasId: string): Promise<DesktopTaskCanvasSummary[]>;
  getProjectOverview(projectRoot: string): Promise<DesktopProjectSummary>;
  getGraphViewModel(ref: DesktopCanvasReference): Promise<DesktopGraphViewModel>;
  getTaskDetail(ref: DesktopCanvasReference, taskId: string): Promise<DesktopTaskDetail>;
  getBlockDetail(ref: DesktopCanvasReference, blockRef: string): Promise<DesktopBlockDetail>;
  getTaskExecutionOrder(ref: DesktopCanvasReference, taskId: string): Promise<DesktopTaskExecutionOrder>;
  getTodoGroups(projectRoot: string): Promise<DesktopTodoGroups>;
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
  updateTaskPrompt(ref: DesktopCanvasReference, taskId: string, markdown: string): Promise<DesktopGraphEditResult>;
  updateBlockTitle(ref: DesktopCanvasReference, blockRef: string, title: string): Promise<DesktopGraphEditResult>;
  updateBlockPrompt(ref: DesktopCanvasReference, blockRef: string, markdown: string): Promise<DesktopGraphEditResult>;
  updateTaskExecutor(ref: DesktopCanvasReference, taskId: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  updateBlockExecutor(ref: DesktopCanvasReference, blockRef: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  addDependencyEdge(ref: DesktopCanvasReference, fromTaskId: string, toTaskId: string): Promise<DesktopGraphEditResult>;
  removeDependencyEdge(ref: DesktopCanvasReference, fromTaskId: string, toTaskId: string): Promise<DesktopGraphEditResult>;
  getDesktopLayout(ref: DesktopCanvasReference): Promise<DesktopLayout>;
  saveDesktopLayout(ref: DesktopCanvasReference, layout: DesktopLayout): Promise<DesktopLayout>;
  resetDesktopLayout(ref: DesktopCanvasReference): Promise<DesktopLayout>;
  createPackageFileSnapshot(ref: DesktopCanvasReference): Promise<DesktopPackageFileSnapshotRef>;
  detectPackageFileChanges(ref: DesktopCanvasReference, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshChangedPackagePrompts(ref: DesktopCanvasReference, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshPackageFileChanges(ref: DesktopCanvasReference): Promise<DesktopPackageFileSyncResult>;
  getDirtyPromptRefs(ref: DesktopCanvasReference): Promise<string[]>;
  watchPackageFiles(ref: DesktopCanvasReference): Promise<void>;
  unwatchPackageFiles(ref: DesktopCanvasReference): Promise<void>;
  onPackageFileChanged(callback: (event: DesktopPackageFileChangeEvent) => void): () => void;
  startAutoRun(ref: DesktopCanvasReference, scope: DesktopAutoRunScope, stepLimit?: number, options?: DesktopAutoRunOptions): Promise<DesktopAutoRunState>;
  unblockBlock(ref: DesktopCanvasReference, blockRef: string, reason: string): Promise<void>;
  pauseAutoRun(runId: string): Promise<DesktopAutoRunState>;
  resumeAutoRun(runId: string): Promise<DesktopAutoRunState>;
  stopAutoRun(runId: string): Promise<DesktopAutoRunState>;
  getAutoRunState(runId: string): Promise<DesktopAutoRunState>;
  getLatestAutoRunSummary(ref: DesktopCanvasReference): Promise<DesktopAutoRunState | null>;
  getStatistics(projectRoot: string): Promise<DesktopStatistics>;
  searchProject(projectRoot: string, query: string, filters?: DesktopSearchFilters): Promise<DesktopSearchResult[]>;
};

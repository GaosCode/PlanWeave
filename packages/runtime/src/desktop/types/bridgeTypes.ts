import type {
  DesktopAddBlockInput,
  DesktopAddContextNodeInput,
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

export type DesktopBridgeApi = {
  listProjects(): Promise<DesktopProjectSummary[]>;
  chooseProjectFolder(): Promise<string | null>;
  revealProjectInFinder(rootPath: string): Promise<void>;
  detectAgentTools(): Promise<DesktopAgentDetection[]>;
  openBlockInspectorWindow(input: { blockRef: string; canvasId?: string | null; language: string; projectRoot: string }): Promise<void>;
  openProject(input: { projectId?: string; rootPath?: string }): Promise<DesktopProjectSummary>;
  initOrOpenProject(rootPath: string): Promise<DesktopProjectSummary>;
  removeProject(projectId: string): Promise<void>;
  createTaskCanvas(projectRoot: string, input?: { name?: string | null }): Promise<DesktopTaskCanvasSummary>;
  removeTaskCanvas(projectRoot: string, canvasId: string): Promise<DesktopTaskCanvasSummary[]>;
  getProjectOverview(projectRoot: string): Promise<DesktopProjectSummary>;
  getGraphViewModel(projectRoot: string, canvasId?: string | null): Promise<DesktopGraphViewModel>;
  getTaskDetail(projectRoot: string, canvasId: string | null | undefined, taskId: string): Promise<DesktopTaskDetail>;
  getBlockDetail(projectRoot: string, canvasId: string | null | undefined, blockRef: string): Promise<DesktopBlockDetail>;
  getTaskExecutionOrder(projectRoot: string, canvasId: string | null | undefined, taskId: string): Promise<DesktopTaskExecutionOrder>;
  getTodoGroups(projectRoot: string): Promise<DesktopTodoGroups>;
  listBlockRunRecords(projectRoot: string, canvasId: string | null | undefined, blockRef: string): Promise<DesktopBlockRunRecordSummary[]>;
  getRunRecord(projectRoot: string, canvasId: string | null | undefined, recordId: string): Promise<DesktopRunRecord>;
  getReviewAttempts(projectRoot: string, canvasId: string | null | undefined, blockRef: string): Promise<DesktopReviewAttemptSummary[]>;
  getFeedbackRecords(projectRoot: string, canvasId: string | null | undefined, blockRef: string): Promise<DesktopFeedbackRecord[]>;
  getReviewPipeline(projectRoot: string, canvasId: string | null | undefined, taskId: string): Promise<DesktopReviewPipeline>;
  updateReviewPipeline(projectRoot: string, canvasId: string | null | undefined, taskId: string, input: DesktopUpdateReviewPipelineInput): Promise<DesktopGraphEditResult>;
  createTaskDraft(projectRoot: string, canvasId: string | null | undefined, input: { mode: DesktopTaskDraftMode; text: string; targetTaskId?: string | null }): Promise<DesktopTaskDraft>;
  addTaskNode(projectRoot: string, canvasId: string | null | undefined, input: DesktopAddTaskInput): Promise<DesktopGraphEditResult>;
  addBlock(projectRoot: string, canvasId: string | null | undefined, input: DesktopAddBlockInput): Promise<DesktopGraphEditResult>;
  addContextNode(projectRoot: string, canvasId: string | null | undefined, input: DesktopAddContextNodeInput): Promise<DesktopGraphEditResult>;
  removeTaskNode(projectRoot: string, canvasId: string | null | undefined, taskId: string): Promise<DesktopGraphEditResult>;
  removeBlock(projectRoot: string, canvasId: string | null | undefined, blockRef: string): Promise<DesktopGraphEditResult>;
  validateGraphEdit(projectRoot: string, canvasId: string | null | undefined, input: DesktopGraphEditValidationInput): Promise<DesktopGraphEditResult>;
  updateTaskTitle(projectRoot: string, canvasId: string | null | undefined, taskId: string, title: string): Promise<DesktopGraphEditResult>;
  updateTaskPrompt(projectRoot: string, canvasId: string | null | undefined, taskId: string, markdown: string): Promise<DesktopGraphEditResult>;
  updateBlockTitle(projectRoot: string, canvasId: string | null | undefined, blockRef: string, title: string): Promise<DesktopGraphEditResult>;
  updateBlockPrompt(projectRoot: string, canvasId: string | null | undefined, blockRef: string, markdown: string): Promise<DesktopGraphEditResult>;
  updateTaskExecutor(projectRoot: string, canvasId: string | null | undefined, taskId: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  updateBlockExecutor(projectRoot: string, canvasId: string | null | undefined, blockRef: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  addDependencyEdge(projectRoot: string, canvasId: string | null | undefined, fromTaskId: string, toTaskId: string): Promise<DesktopGraphEditResult>;
  removeDependencyEdge(projectRoot: string, canvasId: string | null | undefined, fromTaskId: string, toTaskId: string): Promise<DesktopGraphEditResult>;
  getDesktopLayout(projectRoot: string, canvasId?: string | null): Promise<DesktopLayout>;
  saveDesktopLayout(projectRoot: string, canvasId: string | null | undefined, layout: DesktopLayout): Promise<DesktopLayout>;
  resetDesktopLayout(projectRoot: string, canvasId?: string | null): Promise<DesktopLayout>;
  createPackageFileSnapshot(projectRoot: string, canvasId?: string | null): Promise<DesktopPackageFileSnapshotRef>;
  detectPackageFileChanges(projectRoot: string, canvasId?: string | null, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshChangedPackagePrompts(projectRoot: string, canvasId?: string | null, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshPackageFileChanges(projectRoot: string, canvasId?: string | null): Promise<DesktopPackageFileSyncResult>;
  getDirtyPromptRefs(projectRoot: string, canvasId?: string | null): Promise<string[]>;
  watchPackageFiles(projectRoot: string, canvasId?: string | null): Promise<void>;
  unwatchPackageFiles(projectRoot: string, canvasId?: string | null): Promise<void>;
  onPackageFileChanged(callback: (event: DesktopPackageFileChangeEvent) => void): () => void;
  startAutoRun(projectRoot: string, canvasId: string | null | undefined, scope: DesktopAutoRunScope, stepLimit?: number): Promise<DesktopAutoRunState>;
  pauseAutoRun(runId: string): Promise<DesktopAutoRunState>;
  resumeAutoRun(runId: string): Promise<DesktopAutoRunState>;
  stopAutoRun(runId: string): Promise<DesktopAutoRunState>;
  getAutoRunState(runId: string): Promise<DesktopAutoRunState>;
  getLatestAutoRunSummary(projectRoot: string, canvasId?: string | null): Promise<DesktopAutoRunState | null>;
  getStatistics(projectRoot: string): Promise<DesktopStatistics>;
  searchProject(projectRoot: string, query: string, filters?: DesktopSearchFilters): Promise<DesktopSearchResult[]>;
};

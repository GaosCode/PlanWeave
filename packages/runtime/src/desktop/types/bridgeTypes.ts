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
import type { DesktopProjectSummary } from "./projectTypes.js";
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

export type DesktopBridgeApi = {
  listProjects(): Promise<DesktopProjectSummary[]>;
  openProject(input: { projectId?: string; rootPath?: string }): Promise<DesktopProjectSummary>;
  initOrOpenProject(rootPath: string): Promise<DesktopProjectSummary>;
  getProjectOverview(projectRoot: string): Promise<DesktopProjectSummary>;
  getGraphViewModel(projectRoot: string): Promise<DesktopGraphViewModel>;
  getTaskDetail(projectRoot: string, taskId: string): Promise<DesktopTaskDetail>;
  getBlockDetail(projectRoot: string, blockRef: string): Promise<DesktopBlockDetail>;
  getTaskExecutionOrder(projectRoot: string, taskId: string): Promise<DesktopTaskExecutionOrder>;
  getTodoGroups(projectRoot: string): Promise<DesktopTodoGroups>;
  listBlockRunRecords(projectRoot: string, blockRef: string): Promise<DesktopBlockRunRecordSummary[]>;
  getRunRecord(projectRoot: string, recordId: string): Promise<DesktopRunRecord>;
  getReviewAttempts(projectRoot: string, blockRef: string): Promise<DesktopReviewAttemptSummary[]>;
  getFeedbackRecords(projectRoot: string, blockRef: string): Promise<DesktopFeedbackRecord[]>;
  getReviewPipeline(projectRoot: string, taskId: string): Promise<DesktopReviewPipeline>;
  updateReviewPipeline(projectRoot: string, taskId: string, input: DesktopUpdateReviewPipelineInput): Promise<DesktopGraphEditResult>;
  createTaskDraft(projectRoot: string, input: { mode: DesktopTaskDraftMode; text: string; targetTaskId?: string | null }): Promise<DesktopTaskDraft>;
  addTaskNode(projectRoot: string, input: DesktopAddTaskInput): Promise<DesktopGraphEditResult>;
  addBlock(projectRoot: string, input: DesktopAddBlockInput): Promise<DesktopGraphEditResult>;
  addContextNode(projectRoot: string, input: DesktopAddContextNodeInput): Promise<DesktopGraphEditResult>;
  removeTaskNode(projectRoot: string, taskId: string): Promise<DesktopGraphEditResult>;
  removeBlock(projectRoot: string, blockRef: string): Promise<DesktopGraphEditResult>;
  validateGraphEdit(projectRoot: string, input: DesktopGraphEditValidationInput): Promise<DesktopGraphEditResult>;
  updateTaskTitle(projectRoot: string, taskId: string, title: string): Promise<DesktopGraphEditResult>;
  updateTaskPrompt(projectRoot: string, taskId: string, markdown: string): Promise<DesktopGraphEditResult>;
  updateBlockTitle(projectRoot: string, blockRef: string, title: string): Promise<DesktopGraphEditResult>;
  updateBlockPrompt(projectRoot: string, blockRef: string, markdown: string): Promise<DesktopGraphEditResult>;
  updateTaskExecutor(projectRoot: string, taskId: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  updateBlockExecutor(projectRoot: string, blockRef: string, executorName: string | null): Promise<DesktopGraphEditResult>;
  addDependencyEdge(projectRoot: string, fromTaskId: string, toTaskId: string): Promise<DesktopGraphEditResult>;
  removeDependencyEdge(projectRoot: string, fromTaskId: string, toTaskId: string): Promise<DesktopGraphEditResult>;
  getDesktopLayout(projectRoot: string): Promise<DesktopLayout>;
  saveDesktopLayout(projectRoot: string, layout: DesktopLayout): Promise<DesktopLayout>;
  resetDesktopLayout(projectRoot: string): Promise<DesktopLayout>;
  createPackageFileSnapshot(projectRoot: string): Promise<DesktopPackageFileSnapshotRef>;
  detectPackageFileChanges(projectRoot: string, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshChangedPackagePrompts(projectRoot: string, snapshotId?: string | null): Promise<DesktopPackageFileSyncResult>;
  refreshPackageFileChanges(projectRoot: string): Promise<DesktopPackageFileSyncResult>;
  getDirtyPromptRefs(projectRoot: string): Promise<string[]>;
  watchPackageFiles(projectRoot: string): Promise<void>;
  unwatchPackageFiles(projectRoot: string): Promise<void>;
  onPackageFileChanged(callback: (event: DesktopPackageFileChangeEvent) => void): () => void;
  startAutoRun(projectRoot: string, scope: DesktopAutoRunScope, stepLimit?: number): Promise<DesktopAutoRunState>;
  pauseAutoRun(runId: string): Promise<DesktopAutoRunState>;
  resumeAutoRun(runId: string): Promise<DesktopAutoRunState>;
  stopAutoRun(runId: string): Promise<DesktopAutoRunState>;
  getAutoRunState(runId: string): Promise<DesktopAutoRunState>;
  getLatestAutoRunSummary(projectRoot: string): Promise<DesktopAutoRunState | null>;
  getStatistics(projectRoot: string): Promise<DesktopStatistics>;
  searchProject(projectRoot: string, query: string, filters?: DesktopSearchFilters): Promise<DesktopSearchResult[]>;
};

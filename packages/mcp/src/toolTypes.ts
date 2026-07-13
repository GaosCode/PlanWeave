import type {
  BlockType,
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopSearchFilters,
  DesktopSearchResult,
  DesktopSearchResultKind,
  DesktopTodoItem,
  DesktopUpdateReviewPipelineInput,
  DesktopTaskDetail,
  DesktopTaskCanvasSummary,
  ExecutionReadinessReport,
  GraphInspectionResult,
  GraphEditResult,
  GraphQualityReport,
  PackageContentReadResult,
  PackageDraftImportApplyResult,
  PackageDraftImportPreview,
  PackageDraftValidationResult,
  PackageFileListResult,
  PlanStatus,
  ProjectGraphEditResult,
  ProjectTaskRef,
  PromptSourceSummary,
  ReviewHookDefinition,
  RefreshPromptsResult,
  RuntimeSchemaTopicName,
  SchemaDocument,
  ValidationReport,
  GitStatus,
  GitDiffResult,
  GitCommit,
  GitRepoInfo,
  GitCommitResult
} from "@planweave-ai/runtime";
import type { GitHubPR, GitHubPRDetail } from "./github/types.js";

export const planweaveToolNames = [
  "list_tool_groups",
  "get_schema",
  "get_planweave_guide",
  "get_authoring_rules",
  "get_plan_package_examples",
  "get_plan_package_example",
  "get_project_tree",
  "list_projects_summary",
  "list_projects",
  "open_project_summary",
  "open_project",
  "list_canvases",
  "create_project",
  "init_project",
  "create_canvas",
  "get_project_overview",
  "validate_project",
  "explain_validation_errors",
  "get_status",
  "get_prompt",
  "search_project",
  "list_ready_blocks",
  "preview_execution_graph",
  "get_project_graph",
  "get_graph_summary",
  "get_graph_slice",
  "list_tasks",
  "validate_graph_quality",
  "validate_execution_readiness",
  "get_task_detail",
  "get_block_detail",
  "get_block_summary",
  "get_block_detail_full_debug",
  "get_review_pipeline",
  "update_review_pipeline",
  "set_review_pipeline",
  "create_task",
  "update_task",
  "update_task_acceptance",
  "remove_task",
  "create_block",
  "update_block",
  "update_canvas_execution_policy",
  "update_block_planning",
  "update_block_dependencies",
  "set_block_dependencies",
  "remove_block",
  "add_dependency",
  "remove_dependency",
  "add_task_dependency",
  "remove_task_dependency",
  "set_task_dependencies",
  "bulk_create_tasks",
  "bulk_create_blocks",
  "bulk_update_tasks",
  "bulk_update_blocks",
  "bulk_remove_graph_items",
  "bulk_add_task_dependencies",
  "bulk_set_task_dependencies",
  "bulk_set_block_dependencies",
  "bulk_apply_review_pipeline",
  "bulk_update_parallel_policy",
  "add_canvas_dependency",
  "remove_canvas_dependency",
  "add_cross_task_dependency",
  "remove_cross_task_dependency",
  "read_prompt",
  "read_prompt_source",
  "get_rendered_prompt",
  "get_prompt_sources",
  "list_package_files",
  "read_package_file",
  "write_task_prompt",
  "write_block_prompt",
  "write_prompt_source",
  "update_project_prompt",
  "refresh_prompts",
  "refresh_prompts_summary",
  "refresh_prompts_full_debug",
  "export_project",
  "export_project_summary",
  "export_project_files",
  "export_project_full_debug",
  "export_plan_package",
  "export_plan_package_summary",
  "export_plan_package_files",
  "export_plan_package_full",
  "import_plan_package",
  "validate_package_draft",
  "preview_package_import",
  "import_package_draft",
  "apply_canvas_lane_layout",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "github_create_pr",
  "github_list_prs",
  "github_get_pr",
  "github_merge_pr"
] as const;

export type PlanweaveToolName = (typeof planweaveToolNames)[number];

export const debugPlanweaveToolNames = [
  "get_block_detail_full_debug",
  "refresh_prompts_full_debug",
  "export_project_full_debug",
  "export_plan_package_full"
] as const satisfies readonly PlanweaveToolName[];

export const compatPlanweaveToolNames = [
  "get_plan_package_example",
  "get_project_tree",
  "list_projects",
  "open_project",
  "init_project",
  "get_project_overview",
  "get_prompt",
  "preview_execution_graph",
  "get_project_graph",
  "get_task_detail",
  "get_block_detail",
  "update_review_pipeline",
  "get_review_pipeline",
  "update_block_dependencies",
  "add_dependency",
  "remove_dependency",
  "read_prompt",
  "write_task_prompt",
  "write_block_prompt",
  "refresh_prompts",
  "export_project",
  "export_plan_package",
  "import_plan_package",
  ...debugPlanweaveToolNames
] as const satisfies readonly PlanweaveToolName[];

const compatToolNameSet = new Set<PlanweaveToolName>(compatPlanweaveToolNames);

export const defaultPlanweaveToolNames = planweaveToolNames.filter(
  (name): name is PlanweaveToolName => !compatToolNameSet.has(name)
);

export type ExportedPlanPackageFile = {
  path: string;
  content: string;
  encoding: "utf8";
};

export type ExportedPlanPackage = {
  canvasId: string | null;
  files: ExportedPlanPackageFile[];
};

export type SanitizedExecutionStatus = Pick<
  PlanStatus,
  "projectId" | "taskTotal" | "blockTotal" | "tasks" | "blocks" | "currentRefs" | "openFeedback" | "nextClaimable" | "claimHints" | "counts" | "warnings"
> & {
  canvasId: string | null;
};

export type SearchProjectArgs = DesktopSearchFilters & {
  query: string;
};

export type SearchProjectPayload = {
  results: Array<Omit<DesktopSearchResult, "path">>;
  diagnostics: ValidationReport["warnings"];
};

export type RenderedPromptPayload = {
  canvasId: string | null;
  markdown: string;
};

export type ReadyBlock = Pick<DesktopTodoItem, "ref" | "taskId" | "blockId" | "title" | "parallelSafe" | "locks" | "reviewGate"> & {
  canvasId: string | null;
  canvasName: string | null;
};

export type ReadyBlocksPayload = {
  readyBlocks: ReadyBlock[];
};

export type RuntimeGateway = {
  getSchemaDocuments(): Record<RuntimeSchemaTopicName, SchemaDocument>;
  initProject(name: string): Promise<DesktopProjectSummary>;
  createCanvas(projectId: string, name?: string): Promise<DesktopTaskCanvasSummary>;
  listProjects(): Promise<DesktopProjectSummary[]>;
  openProject(projectId: string): Promise<DesktopProjectSummary>;
  validateProject(projectId: string): Promise<ValidationReport>;
  getStatus(projectId: string, canvasId?: string | null): Promise<SanitizedExecutionStatus>;
  getPrompt(projectId: string, canvasId: string | null | undefined, ref: string): Promise<RenderedPromptPayload>;
  searchProject(projectId: string, args: SearchProjectArgs): Promise<SearchProjectPayload>;
  listReadyBlocks(projectId: string, canvasId?: string | null): Promise<ReadyBlocksPayload>;
  getProjectGraph(projectId: string, canvasId?: string): Promise<DesktopGraphViewModel>;
  inspectGraph(
    projectId: string,
    canvasId: string | undefined,
    input: { view: "summary" | "tasks" | "slice"; taskId?: string; limit?: number; cursor?: string }
  ): Promise<GraphInspectionResult>;
  validateGraphQuality(
    projectId: string,
    canvasId: string | undefined,
    input: { reviewPolicy?: "none" | "risk-based" | "required"; gatePolicy?: "none" | "required"; heuristics?: "on" | "off"; strict?: boolean }
  ): Promise<GraphQualityReport>;
  validateExecutionReadiness(projectId: string, canvasId?: string): Promise<ExecutionReadinessReport>;
  getTaskDetail(projectId: string, taskId: string, canvasId?: string): Promise<DesktopTaskDetail>;
  getBlockDetail(projectId: string, blockRef: string, canvasId?: string): Promise<DesktopBlockDetail>;
  getReviewPipeline(projectId: string, taskId: string, canvasId?: string): Promise<DesktopReviewPipeline>;
  updateReviewPipeline(
    projectId: string,
    canvasId: string | undefined,
    taskId: string,
    input: DesktopUpdateReviewPipelineInput
  ): Promise<GraphEditResult>;
  bulkApplyReviewPipeline(
    projectId: string,
    canvasId: string | undefined,
    updates: Array<{ taskId: string; input: DesktopUpdateReviewPipelineInput }>
  ): Promise<GraphEditResult>;
  createTask(
    projectId: string,
    canvasId: string | undefined,
    input: {
      title: string;
      promptMarkdown: string;
      acceptance?: string[];
      blockTypes?: BlockType[];
      executor?: string | null;
    }
  ): Promise<GraphEditResult>;
  updateTask(
    projectId: string,
    canvasId: string | undefined,
    taskId: string,
    input: { title?: string; promptMarkdown?: string; executor?: string | null }
  ): Promise<GraphEditResult>;
  updateTaskAcceptance(projectId: string, canvasId: string | undefined, taskId: string, acceptance: string[]): Promise<GraphEditResult>;
  removeTask(projectId: string, canvasId: string | undefined, taskId: string): Promise<GraphEditResult>;
  bulkCreateTasks(
    projectId: string,
    canvasId: string | undefined,
    tasks: Array<{
      title: string;
      promptMarkdown: string;
      acceptance?: string[];
      blockTypes?: BlockType[];
      executor?: string | null;
    }>
  ): Promise<GraphEditResult>;
  createBlock(
    projectId: string,
    canvasId: string | undefined,
    input: {
      taskId: string;
      type: BlockType;
      title: string;
      promptMarkdown: string;
      executor?: string | null;
      dependsOn?: string[];
    }
  ): Promise<GraphEditResult>;
  bulkCreateBlocks(
    projectId: string,
    canvasId: string | undefined,
    blocks: Array<{
      taskId: string;
      type: BlockType;
      title: string;
      promptMarkdown: string;
      executor?: string | null;
      dependsOn?: string[];
    }>
  ): Promise<GraphEditResult>;
  updateBlock(
    projectId: string,
    canvasId: string | undefined,
    blockRef: string,
    input: { title?: string; promptMarkdown?: string; executor?: string | null }
  ): Promise<GraphEditResult>;
  bulkUpdateTasks(
    projectId: string,
    canvasId: string | undefined,
    updates: Array<{ taskId: string; input: { title?: string; promptMarkdown?: string; executor?: string | null; acceptance?: string[] } }>
  ): Promise<GraphEditResult>;
  bulkUpdateBlocks(
    projectId: string,
    canvasId: string | undefined,
    updates: Array<{
      blockRef: string;
      input: {
        title?: string;
        promptMarkdown?: string;
        executor?: string | null;
        dependsOn?: string[];
        parallelSafe?: boolean;
        parallelLocks?: string[];
        reviewRequired?: boolean;
        maxFeedbackCycles?: number;
        reviewHook?: ReviewHookDefinition | null;
      };
    }>
  ): Promise<GraphEditResult>;
  bulkRemoveGraphItems(
    projectId: string,
    canvasId: string | undefined,
    input: {
      tasks: string[];
      blocks: string[];
      taskDependencyEdges: Array<{ dependentTaskId: string; dependsOnTaskId: string }>;
      blockDependencyRefs: Array<{ blockRef: string; dependsOnBlockId: string }>;
    }
  ): Promise<GraphEditResult>;
  updateCanvasExecutionPolicy(
    projectId: string,
    canvasId: string | undefined,
    input: {
      defaultExecutor?: string | null;
      parallelEnabled?: boolean;
      maxConcurrent?: number;
    }
  ): Promise<GraphEditResult>;
  updateBlockPlanning(
    projectId: string,
    canvasId: string | undefined,
    blockRef: string,
    input: {
      parallelSafe?: boolean;
      parallelLocks?: string[];
      reviewRequired?: boolean;
      maxFeedbackCycles?: number;
      reviewHook?: ReviewHookDefinition | null;
    }
  ): Promise<GraphEditResult>;
  bulkUpdateParallelPolicy(
    projectId: string,
    canvasId: string | undefined,
    input: {
      canvasPolicy?: {
        defaultExecutor?: string | null;
        parallelEnabled?: boolean;
        maxConcurrent?: number;
      };
      blocks: Array<{ blockRef: string; input: { parallelSafe?: boolean; parallelLocks?: string[] } }>;
    }
  ): Promise<GraphEditResult>;
  updateBlockDependencies(projectId: string, canvasId: string | undefined, blockRef: string, dependsOn: string[]): Promise<GraphEditResult>;
  removeBlock(projectId: string, canvasId: string | undefined, blockRef: string): Promise<GraphEditResult>;
  addDependency(projectId: string, canvasId: string | undefined, fromTaskId: string, toTaskId: string): Promise<GraphEditResult>;
  removeDependency(projectId: string, canvasId: string | undefined, fromTaskId: string, toTaskId: string): Promise<GraphEditResult>;
  setTaskDependencies(projectId: string, canvasId: string | undefined, taskId: string, dependsOn: string[]): Promise<GraphEditResult>;
  bulkAddTaskDependencies(
    projectId: string,
    canvasId: string | undefined,
    edges: Array<{ dependentTaskId: string; dependsOnTaskId: string }>
  ): Promise<GraphEditResult>;
  bulkSetTaskDependencies(
    projectId: string,
    canvasId: string | undefined,
    updates: Array<{ taskId: string; dependsOn: string[] }>
  ): Promise<GraphEditResult>;
  bulkSetBlockDependencies(
    projectId: string,
    canvasId: string | undefined,
    updates: Array<{ blockRef: string; dependsOn: string[] }>
  ): Promise<GraphEditResult>;
  applyCanvasLaneLayout(
    projectId: string,
    canvasId: string | undefined,
    input: { columnWidth?: number; rowHeight?: number; startX?: number; startY?: number }
  ): Promise<DesktopLayout>;
  addCanvasDependency(projectId: string, fromCanvasId: string, toCanvasId: string): Promise<ProjectGraphEditResult>;
  removeCanvasDependency(projectId: string, fromCanvasId: string, toCanvasId: string): Promise<ProjectGraphEditResult>;
  addCrossTaskDependency(projectId: string, from: ProjectTaskRef, to: ProjectTaskRef): Promise<ProjectGraphEditResult>;
  removeCrossTaskDependency(projectId: string, from: ProjectTaskRef, to: ProjectTaskRef): Promise<ProjectGraphEditResult>;
  readProjectPrompt(projectId: string): Promise<string>;
  listPackageFiles(projectId: string, canvasId: string | undefined, limit?: number, cursor?: string): Promise<PackageFileListResult>;
  readPackageFile(projectId: string, canvasId: string | undefined, path: string, maxBytes?: number): Promise<PackageContentReadResult>;
  readPromptSource(
    projectId: string,
    canvasId: string | undefined,
    input: { target: "project" | "task" | "block"; taskId?: string; blockRef?: string; maxBytes?: number }
  ): Promise<PackageContentReadResult>;
  readRenderedPrompt(projectId: string, canvasId: string | undefined, ref: string, maxBytes?: number): Promise<PackageContentReadResult>;
  getPromptSources(projectId: string, canvasId: string | undefined, ref: string): Promise<{ ref: string; sources: PromptSourceSummary[] }>;
  updateProjectPrompt(projectId: string, markdown: string): Promise<string>;
  refreshPrompts(projectId: string, canvasId?: string): Promise<RefreshPromptsResult>;
  exportPlanPackage(projectId: string, canvasId?: string): Promise<ExportedPlanPackage>;
  exportProject(projectId: string): Promise<{
    project: DesktopProjectSummary;
    projectPromptMarkdown: string;
    planPackages: ExportedPlanPackage[];
  }>;
  importPlanPackage(input: {
    name: string;
    files: ExportedPlanPackageFile[];
    overwrite?: boolean;
  }): Promise<{ project: DesktopProjectSummary; validation: ValidationReport; importedFiles: number }>;
  validatePackageDraft(draftRoot: string): Promise<PackageDraftValidationResult>;
  previewPackageDraftImport(input: { draftRoot: string; projectId: string; canvasId?: string }): Promise<PackageDraftImportPreview>;
  importPackageDraft(input: { draftRoot: string; projectId: string; canvasId?: string }): Promise<PackageDraftImportApplyResult>;
  gitStatus(projectId: string): Promise<GitStatus>;
  gitDiff(projectId: string, staged?: boolean, files?: string[]): Promise<GitDiffResult>;
  gitLog(projectId: string, maxCount?: number): Promise<GitCommit[]>;
  gitCommit(projectId: string, message: string): Promise<GitCommitResult>;
  gitRepoInfo(projectId: string): Promise<GitRepoInfo>;
  githubCreatePR(projectId: string, title: string, head: string, base: string, body?: string): Promise<GitHubPR>;
  githubListPRs(projectId: string, state?: string): Promise<GitHubPR[]>;
  githubGetPR(projectId: string, prNumber: number): Promise<GitHubPRDetail>;
  githubMergePR(projectId: string, prNumber: number, method?: "merge" | "squash" | "rebase"): Promise<{ merged: boolean; message: string }>;
};

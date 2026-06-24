import type {
  BlockType,
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopSearchFilters,
  DesktopSearchResult,
  DesktopSearchResultKind,
  DesktopTodoItem,
  DesktopUpdateReviewPipelineInput,
  DesktopTaskDetail,
  DesktopTaskCanvasSummary,
  GraphEditResult,
  PlanStatus,
  ProjectGraphEditResult,
  ProjectTaskRef,
  ReviewHookDefinition,
  RefreshPromptsResult,
  RuntimeSchemaTopicName,
  SchemaDocument,
  ValidationReport
} from "@planweave-ai/runtime";

export const planweaveToolNames = [
  "get_schema",
  "get_planweave_guide",
  "get_authoring_rules",
  "get_plan_package_example",
  "get_project_tree",
  "list_projects",
  "open_project",
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
  "get_task_detail",
  "get_block_detail",
  "get_review_pipeline",
  "update_review_pipeline",
  "create_task",
  "update_task",
  "update_task_acceptance",
  "remove_task",
  "create_block",
  "update_block",
  "update_canvas_execution_policy",
  "update_block_planning",
  "update_block_dependencies",
  "remove_block",
  "add_dependency",
  "remove_dependency",
  "add_canvas_dependency",
  "remove_canvas_dependency",
  "add_cross_task_dependency",
  "remove_cross_task_dependency",
  "read_prompt",
  "write_task_prompt",
  "write_block_prompt",
  "update_project_prompt",
  "refresh_prompts",
  "export_project",
  "export_plan_package",
  "import_plan_package"
] as const;

export type PlanweaveToolName = (typeof planweaveToolNames)[number];

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
  getTaskDetail(projectId: string, taskId: string, canvasId?: string): Promise<DesktopTaskDetail>;
  getBlockDetail(projectId: string, blockRef: string, canvasId?: string): Promise<DesktopBlockDetail>;
  getReviewPipeline(projectId: string, taskId: string, canvasId?: string): Promise<DesktopReviewPipeline>;
  updateReviewPipeline(
    projectId: string,
    canvasId: string | undefined,
    taskId: string,
    input: DesktopUpdateReviewPipelineInput
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
  updateBlock(
    projectId: string,
    canvasId: string | undefined,
    blockRef: string,
    input: { title?: string; promptMarkdown?: string; executor?: string | null }
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
  updateBlockDependencies(projectId: string, canvasId: string | undefined, blockRef: string, dependsOn: string[]): Promise<GraphEditResult>;
  removeBlock(projectId: string, canvasId: string | undefined, blockRef: string): Promise<GraphEditResult>;
  addDependency(projectId: string, canvasId: string | undefined, fromTaskId: string, toTaskId: string): Promise<GraphEditResult>;
  removeDependency(projectId: string, canvasId: string | undefined, fromTaskId: string, toTaskId: string): Promise<GraphEditResult>;
  addCanvasDependency(projectId: string, fromCanvasId: string, toCanvasId: string): Promise<ProjectGraphEditResult>;
  removeCanvasDependency(projectId: string, fromCanvasId: string, toCanvasId: string): Promise<ProjectGraphEditResult>;
  addCrossTaskDependency(projectId: string, from: ProjectTaskRef, to: ProjectTaskRef): Promise<ProjectGraphEditResult>;
  removeCrossTaskDependency(projectId: string, from: ProjectTaskRef, to: ProjectTaskRef): Promise<ProjectGraphEditResult>;
  readProjectPrompt(projectId: string): Promise<string>;
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
};

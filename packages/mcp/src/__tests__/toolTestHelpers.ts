import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopTaskDetail,
  ExecutionReadinessReport,
  GraphEditResult,
  GraphInspectionResult,
  GraphQualityReport,
  PackageContentReadResult,
  PackageDraftImportApplyResult,
  PackageDraftImportPreview,
  PackageDraftValidationResult,
  PackageFileListResult,
  PlanStatus,
  ProjectGraphEditResult,
  PromptSourceSummary,
  RefreshPromptsResult,
  RuntimeSchemaTopicName,
  SchemaDocument,
  ValidationReport
} from "@planweave-ai/runtime";
import { vi } from "vitest";
import type { RuntimeGateway } from "../tools.js";

export const project: DesktopProjectSummary = {
  projectId: "project-1",
  name: "Project One",
  kind: "external",
  rootPath: "/sensitive/source",
  sourceRoot: "/sensitive/source",
  workspaceRoot: "/sensitive/home/projects/project-1",
  activeCanvasId: "default",
  taskCanvases: [
    {
      canvasId: "default",
      name: "Default",
      taskCount: 1,
      diagnostics: [],
      missingPromptCount: 0,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z"
    }
  ]
};

export const schemaDocument: SchemaDocument = {
  name: "manifest",
  summary: "Manifest schema",
  path: "package/manifest.json",
  ownership: "runtime",
  validation: ["validatePackage"],
  schema: { type: "object" },
  notes: []
};

export const schemaDocuments = {
  manifest: schemaDocument,
  project: { ...schemaDocument, name: "project" },
  state: { ...schemaDocument, name: "state" },
  layout: { ...schemaDocument, name: "layout" }
} satisfies Record<RuntimeSchemaTopicName, SchemaDocument>;

export const validValidationSummary: ValidationReport["summary"] = {
  errorCount: 0,
  warningCount: 0,
  groups: []
};

export type TestGateway = RuntimeGateway & {
  openProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<DesktopProjectSummary>>>;
  validateProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<ValidationReport>>>;
  getStatus: ReturnType<RuntimeGateway["getStatus"] & typeof vi.fn>;
  getPrompt: ReturnType<RuntimeGateway["getPrompt"] & typeof vi.fn>;
  searchProject: ReturnType<RuntimeGateway["searchProject"] & typeof vi.fn>;
  listReadyBlocks: ReturnType<RuntimeGateway["listReadyBlocks"] & typeof vi.fn>;
  createCanvas: ReturnType<RuntimeGateway["createCanvas"] & typeof vi.fn>;
  getProjectGraph: ReturnType<typeof vi.fn<(projectId: string, canvasId?: string) => Promise<DesktopGraphViewModel>>>;
  inspectGraph: ReturnType<typeof vi.fn<RuntimeGateway["inspectGraph"]>>;
  validateGraphQuality: ReturnType<typeof vi.fn<RuntimeGateway["validateGraphQuality"]>>;
  validateExecutionReadiness: ReturnType<typeof vi.fn<RuntimeGateway["validateExecutionReadiness"]>>;
  getTaskDetail: ReturnType<typeof vi.fn<(projectId: string, taskId: string, canvasId?: string) => Promise<DesktopTaskDetail>>>;
  getBlockDetail: ReturnType<typeof vi.fn<(projectId: string, blockRef: string, canvasId?: string) => Promise<DesktopBlockDetail>>>;
  getReviewPipeline: ReturnType<typeof vi.fn<(projectId: string, taskId: string, canvasId?: string) => Promise<DesktopReviewPipeline>>>;
  updateReviewPipeline: ReturnType<RuntimeGateway["updateReviewPipeline"] & typeof vi.fn>;
  bulkApplyReviewPipeline: ReturnType<RuntimeGateway["bulkApplyReviewPipeline"] & typeof vi.fn>;
  createTask: ReturnType<RuntimeGateway["createTask"] & typeof vi.fn>;
  bulkCreateTasks: ReturnType<RuntimeGateway["bulkCreateTasks"] & typeof vi.fn>;
  updateTask: ReturnType<RuntimeGateway["updateTask"] & typeof vi.fn>;
  bulkUpdateTasks: ReturnType<RuntimeGateway["bulkUpdateTasks"] & typeof vi.fn>;
  updateTaskAcceptance: ReturnType<RuntimeGateway["updateTaskAcceptance"] & typeof vi.fn>;
  createBlock: ReturnType<RuntimeGateway["createBlock"] & typeof vi.fn>;
  bulkCreateBlocks: ReturnType<RuntimeGateway["bulkCreateBlocks"] & typeof vi.fn>;
  updateBlock: ReturnType<RuntimeGateway["updateBlock"] & typeof vi.fn>;
  bulkUpdateBlocks: ReturnType<RuntimeGateway["bulkUpdateBlocks"] & typeof vi.fn>;
  bulkRemoveGraphItems: ReturnType<RuntimeGateway["bulkRemoveGraphItems"] & typeof vi.fn>;
  updateCanvasExecutionPolicy: ReturnType<RuntimeGateway["updateCanvasExecutionPolicy"] & typeof vi.fn>;
  updateBlockPlanning: ReturnType<RuntimeGateway["updateBlockPlanning"] & typeof vi.fn>;
  bulkUpdateParallelPolicy: ReturnType<RuntimeGateway["bulkUpdateParallelPolicy"] & typeof vi.fn>;
  updateBlockDependencies: ReturnType<RuntimeGateway["updateBlockDependencies"] & typeof vi.fn>;
  addDependency: ReturnType<RuntimeGateway["addDependency"] & typeof vi.fn>;
  removeDependency: ReturnType<RuntimeGateway["removeDependency"] & typeof vi.fn>;
  setTaskDependencies: ReturnType<RuntimeGateway["setTaskDependencies"] & typeof vi.fn>;
  bulkAddTaskDependencies: ReturnType<RuntimeGateway["bulkAddTaskDependencies"] & typeof vi.fn>;
  bulkSetTaskDependencies: ReturnType<RuntimeGateway["bulkSetTaskDependencies"] & typeof vi.fn>;
  bulkSetBlockDependencies: ReturnType<RuntimeGateway["bulkSetBlockDependencies"] & typeof vi.fn>;
  applyCanvasLaneLayout: ReturnType<RuntimeGateway["applyCanvasLaneLayout"] & typeof vi.fn>;
  addCanvasDependency: ReturnType<RuntimeGateway["addCanvasDependency"] & typeof vi.fn>;
  removeCanvasDependency: ReturnType<RuntimeGateway["removeCanvasDependency"] & typeof vi.fn>;
  addCrossTaskDependency: ReturnType<RuntimeGateway["addCrossTaskDependency"] & typeof vi.fn>;
  removeCrossTaskDependency: ReturnType<RuntimeGateway["removeCrossTaskDependency"] & typeof vi.fn>;
  readProjectPrompt: ReturnType<typeof vi.fn<(projectId: string) => Promise<string>>>;
  listPackageFiles: ReturnType<typeof vi.fn<RuntimeGateway["listPackageFiles"]>>;
  readPackageFile: ReturnType<typeof vi.fn<RuntimeGateway["readPackageFile"]>>;
  readPromptSource: ReturnType<typeof vi.fn<RuntimeGateway["readPromptSource"]>>;
  readRenderedPrompt: ReturnType<typeof vi.fn<RuntimeGateway["readRenderedPrompt"]>>;
  getPromptSources: ReturnType<typeof vi.fn<RuntimeGateway["getPromptSources"]>>;
  updateProjectPrompt: ReturnType<typeof vi.fn<(projectId: string, markdown: string) => Promise<string>>>;
  refreshPrompts: ReturnType<typeof vi.fn<(projectId: string, canvasId?: string) => Promise<RefreshPromptsResult>>>;
  exportPlanPackage: ReturnType<RuntimeGateway["exportPlanPackage"] & typeof vi.fn>;
  importPlanPackage: ReturnType<RuntimeGateway["importPlanPackage"] & typeof vi.fn>;
  validatePackageDraft: ReturnType<typeof vi.fn<RuntimeGateway["validatePackageDraft"]>>;
  previewPackageDraftImport: ReturnType<typeof vi.fn<RuntimeGateway["previewPackageDraftImport"]>>;
  importPackageDraft: ReturnType<typeof vi.fn<RuntimeGateway["importPackageDraft"]>>;
};

export function readJson(result: CallToolResult): unknown {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("Expected text tool content.");
  }
  return JSON.parse(first.text);
}

export function createGateway(): TestGateway {
  const layout: DesktopLayout = {
    version: "desktop-layout/v1",
    projectId: "project-1",
    nodes: [{ nodeId: "T-001", x: 80, y: 80 }],
    updatedAt: "2026-06-19T00:00:00.000Z"
  };
  const taskDetail: DesktopTaskDetail = {
    taskId: "T-001",
    title: "Implement feature",
    status: "planned",
    executor: null,
    promptMarkdown: "# Task",
    promptMissing: false,
    acceptance: ["Works"],
    blockOrder: ["T-001#I-001", "T-001#R-001"]
  };
  const blockDetail: DesktopBlockDetail = {
    ref: "T-001#I-001",
    taskId: "T-001",
    blockId: "I-001",
    type: "implementation",
    title: "Implement",
    status: "ready",
    executor: null,
    effectiveExecutor: "codex",
    promptMarkdown: "# Block",
    promptMissing: false,
    promptSurfaceMarkdown: "# Surface",
    promptSources: [],
    dependencies: [],
    latestRunId: null,
    latestReviewAttemptId: null,
    activeFeedbackId: null,
    exceptionReason: null,
    reviewGate: null
  };
  const status: Omit<PlanStatus, "projectRoot"> & { canvasId: string | null } = {
    projectId: "project-1",
    canvasId: "default",
    taskTotal: 1,
    blockTotal: 1,
    tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
    blocks: [
      {
        ref: "T-001#I-001",
        taskId: "T-001",
        blockId: "I-001",
        type: "implementation",
        status: "ready",
        reason: null,
        completionReason: null,
        lastRunId: null,
        latestReviewAttemptId: null,
        activeFeedbackId: null
      }
    ],
    currentRefs: [],
    currentFeedbackId: null,
    currentReviewBlockRef: null,
    openFeedback: [],
    nextClaimable: ["T-001#I-001"],
    nextParallelClaimable: ["T-001#I-001"],
    nextSequentialClaimable: [],
    nextParallelDispatchable: ["T-001#I-001"],
    claimHints: [
      {
        ref: "T-001#I-001",
        taskId: "T-001",
        blockId: "I-001",
        blockType: "implementation",
        status: "ready",
        statusReason: null,
        ready: true,
        readyReason: "ready",
        blockedByBlocks: [],
        blockedByTasks: [],
        blockedByProject: [],
        parallelSafe: true,
        sequentialOnly: false,
        recommendedCommand: "planweave claim T-001#I-001",
        dispatchable: true,
        dispatchCommand: "planweave dispatch T-001#I-001",
        reviewGate: null
      }
    ],
    warnings: [
      {
        code: "status_manifest_warning",
        message: "Manifest warning at /sensitive/home/projects/project-1/canvases/default/package/manifest.json",
        path: "/sensitive/home/projects/project-1/canvases/default/package/manifest.json"
      }
    ],
    counts: {
      tasks: { planned: 0, ready: 1, in_progress: 0, implemented: 0 },
      blocks: { planned: 0, ready: 1, in_progress: 0, completed: 0, needs_changes: 0, blocked: 0, diverged: 0 },
      feedback: { open: 0, in_progress: 0, resolved: 0, dismissed: 0 }
    },
    orphanState: [],
    orphanResults: []
  };
  const searchResult = {
    kind: "prompt" as const,
    canvasId: "default",
    canvasName: "Default",
    ref: "T-001#I-001",
    title: "Implement",
    excerpt: "needle appears here"
  };
  const readyBlock = {
    canvasId: "default",
    canvasName: "Default",
    ref: "T-001#I-001",
    taskId: "T-001",
    blockId: "I-001",
    title: "Implement",
    parallelSafe: true,
    locks: ["repo"],
    reviewGate: null
  };
  const graph: DesktopGraphViewModel = {
    projectId: "project-1",
    projectTitle: "Project One",
    executorOptions: ["codex"],
    tasks: [
      {
        taskId: "T-001",
        title: "Implement feature",
        status: "planned",
        executor: null,
        executorLabel: "default",
        promptMarkdown: "# Task",
        promptMissing: false,
        promptPreview: "Task",
        blocks: [{ ref: "T-001#I-001", blockId: "I-001", type: "implementation", title: "Implement", status: "ready", executor: null, promptMissing: false, exceptionReason: null }],
        blockPreview: [],
        hiddenBlockRefs: [],
        overflowBlockCount: 0,
        exceptions: []
      }
    ],
    edges: [],
    diagnostics: [],
    dirtyPromptRefs: []
  };
  const graphInspectionSummary: GraphInspectionResult = {
    view: "summary",
    project: {
      id: "project-1",
      title: "Project One",
      description: "Demo"
    },
    canvas: {
      id: "default",
      title: "Project One"
    },
    counts: {
      taskCount: 1,
      blockCount: 1,
      reviewBlockCount: 0,
      taskDependencyCount: 0,
      readyBlockCount: 1,
      diagnosticCount: 0
    },
    tasksPreview: [
      {
        taskId: "T-001",
        title: "Implement feature",
        status: "ready",
        acceptanceCount: 1,
        blockCount: 1,
        reviewBlockCount: 0,
        dependsOn: [],
        dependents: [],
        promptMissing: false
      }
    ],
    page: { limit: 50, cursor: null, nextCursor: null, total: 1, truncated: false }
  };
  const graphInspectionTasks: GraphInspectionResult = {
    view: "tasks",
    tasks: graphInspectionSummary.tasksPreview,
    page: graphInspectionSummary.page
  };
  const graphInspectionSlice: GraphInspectionResult = {
    view: "slice",
    taskId: "T-001",
    center: graphInspectionSummary.tasksPreview[0],
    dependencies: { limit: 50, total: 0, truncated: false, items: [] },
    dependents: { limit: 50, total: 0, truncated: false, items: [] },
    edges: { limit: 50, total: 0, truncated: false, items: [] },
    blocks: {
      limit: 50,
      total: 1,
      truncated: false,
      items: [{ ref: "T-001#I-001", blockId: "I-001", type: "implementation", title: "Implement", status: "ready", dependsOn: [] }]
    }
  };
  const graphQuality: GraphQualityReport = {
    ok: true,
    summary: {
      taskCount: 1,
      blockCount: 1,
      taskDependencyCount: 0,
      reviewBlockCount: 0,
      orphanTaskCount: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      score: 100
    },
    diagnostics: []
  };
  const readiness: ExecutionReadinessReport = {
    ok: true,
    summary: {
      taskCount: 1,
      blockCount: 1,
      readyBlockCount: 1,
      currentRefCount: 0,
      openFeedbackCount: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0
    },
    diagnostics: [],
    nextClaimable: ["T-001#I-001"]
  };
  const reviewPipeline: DesktopReviewPipeline = {
    taskId: "T-001",
    taskTitle: "Implement feature",
    packageDefaults: { maxFeedbackCycles: 2, completionPolicy: "strict" },
    steps: [
      {
        blockRef: "T-001#R-001",
        blockId: "R-001",
        title: "Review",
        enabled: true,
        preset: "general",
        triggerCondition: "after_required_work_completed",
        inputContext: "latest implementation reports",
        passCriteria: "All acceptance criteria are satisfied.",
        feedbackFormat: "Actionable feedback.",
        maxFeedbackCycles: 2,
        hook: null,
        promptMarkdown: "# Review"
      }
    ]
  };
  const graphEditResult: GraphEditResult = {
    ok: true,
    affectedTasks: ["T-001"],
    diagnostics: [],
    graph: {
      blocksByTask: new Map([["T-001", ["T-001#I-001", "T-001#R-001"]]]),
      reviewBlocksByTask: new Map([["T-001", ["T-001#R-001"]]])
    } as GraphEditResult["graph"]
  };
  const projectGraphEditResult: ProjectGraphEditResult = {
    ok: true,
    diagnostics: [],
    graph: {
      version: "plan-project/v1",
      canvases: [
        { id: "default", type: "canvas", title: "Default", packageDir: "package", stateFile: "state.json", resultsDir: "results" },
        {
          id: "canvas-new",
          type: "canvas",
          title: "New",
          packageDir: "canvases/canvas-new/package",
          stateFile: "canvases/canvas-new/state.json",
          resultsDir: "canvases/canvas-new/results"
        }
      ],
      edges: [{ from: "canvas-new", to: "default", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: "canvas-new", taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    }
  };
  const contentRead: PackageContentReadResult = {
    contentRef: {
      kind: "package_file",
      path: "manifest.json",
      hash: "hash",
      sizeBytes: 2
    },
    content: "{}",
    truncated: false
  };
  const packageFiles: PackageFileListResult = {
    files: [
      {
        path: "manifest.json",
        sizeBytes: 2,
        hash: "hash",
        owner: { kind: "manifest" },
        preview: "{}",
        contentRef: contentRead.contentRef
      }
    ],
    pagination: { limit: 50, cursor: null, nextCursor: null, total: 1, hasMore: false }
  };
  const promptSources: PromptSourceSummary[] = [
    {
      kind: "block",
      label: "Block prompt T-001#I-001",
      included: true,
      empty: false,
      missing: false,
      disabledReason: null,
      preview: "Block"
    }
  ];
  const draftValidation: PackageDraftValidationResult = {
    ok: true,
    draftRoot: "/draft",
    mode: "single-canvas",
    validation: { ok: true, errors: [], warnings: [], summary: validValidationSummary },
    canvases: []
  };
  const draftPreview: PackageDraftImportPreview = {
    ...draftValidation,
    target: { projectRoot: "/project", canvasId: "default" },
    fileDiffs: [{ path: "package/manifest.json", type: "changed" }],
    effects: [
      { type: "replace_package", path: "package" },
      { type: "reset_state", path: "state.json" },
      { type: "reset_results", path: "results" }
    ],
    summary: { fileCount: 1, added: 0, changed: 1, removed: 0, unchanged: 0 }
  };
  const draftImport: PackageDraftImportApplyResult = {
    ...draftPreview,
    applied: true
  };
  return {
    getSchemaDocuments() {
      return schemaDocuments;
    },
    async listProjects() {
      return [project];
    },
    openProject: vi.fn(async () => project),
    validateProject: vi.fn(async () => ({ ok: true, errors: [], warnings: [], summary: validValidationSummary })),
    getStatus: vi.fn(async () => status),
    getPrompt: vi.fn(async (_projectId, canvasId) => ({ canvasId: canvasId ?? "default", markdown: "# Rendered prompt" })),
    searchProject: vi.fn(async () => ({ results: [searchResult], diagnostics: [] })),
    listReadyBlocks: vi.fn(async () => ({ readyBlocks: [readyBlock] })),
    getProjectGraph: vi.fn(async () => graph),
    inspectGraph: vi.fn(async (_projectId, _canvasId, input) => {
      if (input.view === "tasks") {
        return graphInspectionTasks;
      }
      if (input.view === "slice") {
        return graphInspectionSlice;
      }
      return graphInspectionSummary;
    }),
    validateGraphQuality: vi.fn(async () => graphQuality),
    validateExecutionReadiness: vi.fn(async () => readiness),
    getTaskDetail: vi.fn(async () => taskDetail),
    getBlockDetail: vi.fn(async () => blockDetail),
    getReviewPipeline: vi.fn(async () => reviewPipeline),
    updateReviewPipeline: vi.fn(async () => graphEditResult),
    bulkApplyReviewPipeline: vi.fn(async () => graphEditResult),
    initProject: vi.fn(async () => project),
    createCanvas: vi.fn(async (_projectId, name) => ({
      canvasId: "canvas-new",
      name: name ?? "New canvas",
      taskCount: 0,
      missingPromptCount: 0,
      diagnostics: [],
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z"
    })),
    createTask: vi.fn(async () => graphEditResult),
    bulkCreateTasks: vi.fn(async () => graphEditResult),
    updateTask: vi.fn(async () => graphEditResult),
    bulkUpdateTasks: vi.fn(async () => graphEditResult),
    updateTaskAcceptance: vi.fn(async () => graphEditResult),
    removeTask: vi.fn(async () => graphEditResult),
    createBlock: vi.fn(async () => graphEditResult),
    bulkCreateBlocks: vi.fn(async () => graphEditResult),
    updateBlock: vi.fn(async () => graphEditResult),
    bulkUpdateBlocks: vi.fn(async () => graphEditResult),
    bulkRemoveGraphItems: vi.fn(async () => graphEditResult),
    updateCanvasExecutionPolicy: vi.fn(async () => graphEditResult),
    updateBlockPlanning: vi.fn(async () => graphEditResult),
    bulkUpdateParallelPolicy: vi.fn(async () => graphEditResult),
    updateBlockDependencies: vi.fn(async () => graphEditResult),
    removeBlock: vi.fn(async () => graphEditResult),
    addDependency: vi.fn(async () => graphEditResult),
    removeDependency: vi.fn(async () => graphEditResult),
    setTaskDependencies: vi.fn(async () => graphEditResult),
    bulkAddTaskDependencies: vi.fn(async () => graphEditResult),
    bulkSetTaskDependencies: vi.fn(async () => graphEditResult),
    bulkSetBlockDependencies: vi.fn(async () => graphEditResult),
    applyCanvasLaneLayout: vi.fn(async () => layout),
    addCanvasDependency: vi.fn(async () => projectGraphEditResult),
    removeCanvasDependency: vi.fn(async () => projectGraphEditResult),
    addCrossTaskDependency: vi.fn(async () => projectGraphEditResult),
    removeCrossTaskDependency: vi.fn(async () => projectGraphEditResult),
    readProjectPrompt: vi.fn(async () => "# Project"),
    listPackageFiles: vi.fn(async () => packageFiles),
    readPackageFile: vi.fn(async () => contentRead),
    readPromptSource: vi.fn(async () => ({ ...contentRead, contentRef: { ...contentRead.contentRef, kind: "prompt_source", path: "nodes/T-001/prompt.md" } })),
    readRenderedPrompt: vi.fn(async () => ({ ...contentRead, contentRef: { ...contentRead.contentRef, kind: "rendered_prompt", ref: "T-001#I-001" }, content: "# Rendered prompt" })),
    getPromptSources: vi.fn(async () => ({ ref: "T-001#I-001", sources: promptSources })),
    updateProjectPrompt: vi.fn(async (_projectId, markdown) => markdown),
    refreshPrompts: vi.fn(async () => ({ prompts: [{ ref: "T-001#I-001", path: "", markdown: "# Surface" }] })),
    exportPlanPackage: vi.fn(async () => ({ canvasId: "default", files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }] })),
    exportProject: vi.fn(async () => ({
      project,
      projectPromptMarkdown: "# Project",
      planPackages: [{ canvasId: "default", files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }] }]
    })),
    importPlanPackage: vi.fn(async () => ({
      project,
      validation: { ok: true, errors: [], warnings: [], summary: validValidationSummary },
      importedFiles: 1
    })),
    validatePackageDraft: vi.fn(async () => draftValidation),
    previewPackageDraftImport: vi.fn(async () => draftPreview),
    importPackageDraft: vi.fn(async () => draftImport),
    gitStatus: vi.fn(async () => ({ branch: "main", ahead: 0, behind: 0, files: [], clean: true })),
    gitDiff: vi.fn(async () => ({ hunks: [], raw: "" })),
    gitLog: vi.fn(async () => []),
    gitCommit: vi.fn(async (_projectId, message) => ({ hash: "abc123", message })),
    gitRepoInfo: vi.fn(async () => ({ owner: "owner", repo: "repo", remotes: [], defaultRemote: "origin" })),
    githubCreatePR: vi.fn(async (_projectId, title, head, base) => ({
      number: 1, title, state: "open", htmlUrl: "https://github.com/owner/repo/pull/1", headBranch: head, baseBranch: base,
      author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", draft: false, mergeable: true
    })),
    githubListPRs: vi.fn(async () => []),
    githubGetPR: vi.fn(async (_projectId, prNumber) => ({
      number: prNumber, title: "PR", state: "open", htmlUrl: `https://github.com/owner/repo/pull/${prNumber}`,
      headBranch: "feature", baseBranch: "main", author: "user", createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", draft: false, mergeable: true, body: "", additions: 1, deletions: 0,
      changedFiles: 1, mergeStateStatus: "clean"
    })),
    githubMergePR: vi.fn(async () => ({ merged: true, message: "merged" }))
  };
}

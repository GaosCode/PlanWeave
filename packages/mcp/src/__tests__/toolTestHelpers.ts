import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopTaskDetail,
  GraphEditResult,
  PlanStatus,
  ProjectGraphEditResult,
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

export type TestGateway = RuntimeGateway & {
  openProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<DesktopProjectSummary>>>;
  validateProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<ValidationReport>>>;
  getStatus: ReturnType<RuntimeGateway["getStatus"] & typeof vi.fn>;
  getPrompt: ReturnType<RuntimeGateway["getPrompt"] & typeof vi.fn>;
  searchProject: ReturnType<RuntimeGateway["searchProject"] & typeof vi.fn>;
  listReadyBlocks: ReturnType<RuntimeGateway["listReadyBlocks"] & typeof vi.fn>;
  createCanvas: ReturnType<RuntimeGateway["createCanvas"] & typeof vi.fn>;
  getProjectGraph: ReturnType<typeof vi.fn<(projectId: string, canvasId?: string) => Promise<DesktopGraphViewModel>>>;
  getTaskDetail: ReturnType<typeof vi.fn<(projectId: string, taskId: string, canvasId?: string) => Promise<DesktopTaskDetail>>>;
  getBlockDetail: ReturnType<typeof vi.fn<(projectId: string, blockRef: string, canvasId?: string) => Promise<DesktopBlockDetail>>>;
  getReviewPipeline: ReturnType<typeof vi.fn<(projectId: string, taskId: string, canvasId?: string) => Promise<DesktopReviewPipeline>>>;
  updateReviewPipeline: ReturnType<RuntimeGateway["updateReviewPipeline"] & typeof vi.fn>;
  createTask: ReturnType<RuntimeGateway["createTask"] & typeof vi.fn>;
  updateTask: ReturnType<RuntimeGateway["updateTask"] & typeof vi.fn>;
  updateTaskAcceptance: ReturnType<RuntimeGateway["updateTaskAcceptance"] & typeof vi.fn>;
  createBlock: ReturnType<RuntimeGateway["createBlock"] & typeof vi.fn>;
  updateBlock: ReturnType<RuntimeGateway["updateBlock"] & typeof vi.fn>;
  updateCanvasExecutionPolicy: ReturnType<RuntimeGateway["updateCanvasExecutionPolicy"] & typeof vi.fn>;
  updateBlockPlanning: ReturnType<RuntimeGateway["updateBlockPlanning"] & typeof vi.fn>;
  updateBlockDependencies: ReturnType<RuntimeGateway["updateBlockDependencies"] & typeof vi.fn>;
  addDependency: ReturnType<RuntimeGateway["addDependency"] & typeof vi.fn>;
  addCanvasDependency: ReturnType<RuntimeGateway["addCanvasDependency"] & typeof vi.fn>;
  removeCanvasDependency: ReturnType<RuntimeGateway["removeCanvasDependency"] & typeof vi.fn>;
  addCrossTaskDependency: ReturnType<RuntimeGateway["addCrossTaskDependency"] & typeof vi.fn>;
  removeCrossTaskDependency: ReturnType<RuntimeGateway["removeCrossTaskDependency"] & typeof vi.fn>;
  readProjectPrompt: ReturnType<typeof vi.fn<(projectId: string) => Promise<string>>>;
  updateProjectPrompt: ReturnType<typeof vi.fn<(projectId: string, markdown: string) => Promise<string>>>;
  refreshPrompts: ReturnType<typeof vi.fn<(projectId: string, canvasId?: string) => Promise<RefreshPromptsResult>>>;
  exportPlanPackage: ReturnType<RuntimeGateway["exportPlanPackage"] & typeof vi.fn>;
  importPlanPackage: ReturnType<RuntimeGateway["importPlanPackage"] & typeof vi.fn>;
};

export function readJson(result: CallToolResult): unknown {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("Expected text tool content.");
  }
  return JSON.parse(first.text);
}

export function createGateway(): TestGateway {
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
    graph: {} as GraphEditResult["graph"]
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
  return {
    getSchemaDocuments() {
      return { manifest: schemaDocument, project: { ...schemaDocument, name: "project" } } satisfies Record<RuntimeSchemaTopicName, SchemaDocument>;
    },
    async listProjects() {
      return [project];
    },
    openProject: vi.fn(async () => project),
    validateProject: vi.fn(async () => ({ ok: true, errors: [], warnings: [] })),
    getStatus: vi.fn(async () => status),
    getPrompt: vi.fn(async (_projectId, canvasId) => ({ canvasId: canvasId ?? "default", markdown: "# Rendered prompt" })),
    searchProject: vi.fn(async () => ({ results: [searchResult], diagnostics: [] })),
    listReadyBlocks: vi.fn(async () => ({ readyBlocks: [readyBlock] })),
    getProjectGraph: vi.fn(async () => graph),
    getTaskDetail: vi.fn(async () => taskDetail),
    getBlockDetail: vi.fn(async () => blockDetail),
    getReviewPipeline: vi.fn(async () => reviewPipeline),
    updateReviewPipeline: vi.fn(async () => graphEditResult),
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
    updateTask: vi.fn(async () => graphEditResult),
    updateTaskAcceptance: vi.fn(async () => graphEditResult),
    removeTask: vi.fn(async () => graphEditResult),
    createBlock: vi.fn(async () => graphEditResult),
    updateBlock: vi.fn(async () => graphEditResult),
    updateCanvasExecutionPolicy: vi.fn(async () => graphEditResult),
    updateBlockPlanning: vi.fn(async () => graphEditResult),
    updateBlockDependencies: vi.fn(async () => graphEditResult),
    removeBlock: vi.fn(async () => graphEditResult),
    addDependency: vi.fn(async () => graphEditResult),
    removeDependency: vi.fn(async () => graphEditResult),
    addCanvasDependency: vi.fn(async () => projectGraphEditResult),
    removeCanvasDependency: vi.fn(async () => projectGraphEditResult),
    addCrossTaskDependency: vi.fn(async () => projectGraphEditResult),
    removeCrossTaskDependency: vi.fn(async () => projectGraphEditResult),
    readProjectPrompt: vi.fn(async () => "# Project"),
    updateProjectPrompt: vi.fn(async (_projectId, markdown) => markdown),
    refreshPrompts: vi.fn(async () => ({ prompts: [{ ref: "T-001#I-001", path: "", markdown: "# Surface" }] })),
    exportPlanPackage: vi.fn(async () => ({ canvasId: "default", files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }] })),
    exportProject: vi.fn(async () => ({
      project,
      projectPromptMarkdown: "# Project",
      planPackages: [{ canvasId: "default", files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }] }]
    })),
    importPlanPackage: vi.fn(async () => ({ project, validation: { ok: true, errors: [], warnings: [] }, importedFiles: 1 }))
  };
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopReviewPipeline,
  DesktopTaskDetail,
  RuntimeSchemaTopicName,
  SchemaDocument,
  ValidationReport
} from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { handlePlanweaveTool, type RuntimeGateway } from "../tools.js";

const project: DesktopProjectSummary = {
  projectId: "project-1",
  name: "Project One",
  rootPath: "/sensitive/source",
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

const schemaDocument: SchemaDocument = {
  name: "manifest",
  summary: "Manifest schema",
  path: "package/manifest.json",
  ownership: "runtime",
  validation: ["validatePackage"],
  schema: { type: "object" },
  notes: []
};

function readJson(result: CallToolResult): unknown {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("Expected text tool content.");
  }
  return JSON.parse(first.text);
}

function createGateway(): RuntimeGateway & {
  openProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<DesktopProjectSummary>>>;
  validateProject: ReturnType<typeof vi.fn<(projectId: string) => Promise<ValidationReport>>>;
  getProjectOverview: ReturnType<typeof vi.fn<(projectId: string) => Promise<DesktopProjectSummary>>>;
  getProjectGraph: ReturnType<typeof vi.fn<(projectId: string, canvasId?: string) => Promise<DesktopGraphViewModel>>>;
  getTaskDetail: ReturnType<typeof vi.fn<(projectId: string, taskId: string, canvasId?: string) => Promise<DesktopTaskDetail>>>;
  getBlockDetail: ReturnType<typeof vi.fn<(projectId: string, blockRef: string, canvasId?: string) => Promise<DesktopBlockDetail>>>;
  getReviewPipeline: ReturnType<typeof vi.fn<(projectId: string, taskId: string, canvasId?: string) => Promise<DesktopReviewPipeline>>>;
} {
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
        blocks: [
          {
            ref: "T-001#I-001",
            blockId: "I-001",
            type: "implementation",
            title: "Implement",
            status: "ready",
            executor: null,
            promptMissing: false,
            exceptionReason: null
          }
        ],
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
    packageDefaults: {
      maxFeedbackCycles: 2,
      completionPolicy: "strict"
    },
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
  return {
    getSchemaDocuments() {
      return {
        manifest: schemaDocument,
        project: {
          ...schemaDocument,
          name: "project"
        }
      } satisfies Record<RuntimeSchemaTopicName, SchemaDocument>;
    },
    async listProjects() {
      return [project];
    },
    openProject: vi.fn(async () => project),
    validateProject: vi.fn(async () => ({
      ok: true,
      errors: [],
      warnings: []
    })),
    getProjectOverview: vi.fn(async () => project),
    getProjectGraph: vi.fn(async () => graph),
    getTaskDetail: vi.fn(async () => taskDetail),
    getBlockDetail: vi.fn(async () => blockDetail),
    getReviewPipeline: vi.fn(async () => reviewPipeline)
  };
}

describe("handlePlanweaveTool", () => {
  it("returns schema documents as JSON text content", async () => {
    const result = readJson(await handlePlanweaveTool("get_schema", { topic: "manifest" }, createGateway()));

    expect(result).toEqual({
      topic: "manifest",
      documents: {
        manifest: schemaDocument
      }
    });
  });

  it("lists projects without exposing local paths", async () => {
    const result = readJson(await handlePlanweaveTool("list_projects", undefined, createGateway()));

    expect(result).toEqual({
      projects: [
        {
          projectId: "project-1",
          name: "Project One",
          activeCanvasId: "default",
          taskCanvases: project.taskCanvases
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("/sensitive");
  });

  it("opens projects by projectId only", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("open_project", { projectId: "project-1", rootPath: "/ignored" }, gateway));

    expect(gateway.openProject).toHaveBeenCalledWith("project-1");
    expect(JSON.stringify(result)).not.toContain("/ignored");
    expect(JSON.stringify(result)).not.toContain("/sensitive");
  });

  it("validates projects by projectId only", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("validate_project", { projectId: "project-1" }, gateway));

    expect(gateway.validateProject).toHaveBeenCalledWith("project-1");
    expect(result).toEqual({
      ok: true,
      errors: [],
      warnings: []
    });
  });

  it("returns project overview without exposing local paths", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("get_project_overview", { projectId: "project-1" }, gateway));

    expect(gateway.getProjectOverview).toHaveBeenCalledWith("project-1");
    expect(result).toEqual({
      project: {
        projectId: "project-1",
        name: "Project One",
        activeCanvasId: "default",
        taskCanvases: project.taskCanvases
      }
    });
    expect(JSON.stringify(result)).not.toContain("/sensitive");
  });

  it("returns graph details for a selected canvas", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("get_project_graph", { projectId: "project-1", canvasId: "default" }, gateway));

    expect(gateway.getProjectGraph).toHaveBeenCalledWith("project-1", "default");
    expect(result).toMatchObject({
      graph: {
        projectId: "project-1",
        tasks: [
          {
            taskId: "T-001",
            blocks: [
              {
                ref: "T-001#I-001"
              }
            ]
          }
        ]
      }
    });
  });

  it("returns task, block, and review pipeline details", async () => {
    const gateway = createGateway();

    await expect(handlePlanweaveTool("get_task_detail", { projectId: "project-1", canvasId: "default", taskId: "T-001" }, gateway)).resolves.toMatchObject({
      structuredContent: {
        task: {
          taskId: "T-001"
        }
      }
    });
    await expect(handlePlanweaveTool("get_block_detail", { projectId: "project-1", canvasId: "default", taskId: "T-001", blockId: "I-001" }, gateway)).resolves.toMatchObject({
      structuredContent: {
        block: {
          ref: "T-001#I-001"
        }
      }
    });
    await expect(handlePlanweaveTool("get_review_pipeline", { projectId: "project-1", canvasId: "default", taskId: "T-001" }, gateway)).resolves.toMatchObject({
      structuredContent: {
        reviewPipeline: {
          taskId: "T-001"
        }
      }
    });

    expect(gateway.getTaskDetail).toHaveBeenCalledWith("project-1", "T-001", "default");
    expect(gateway.getBlockDetail).toHaveBeenCalledWith("project-1", "T-001#I-001", "default");
    expect(gateway.getReviewPipeline).toHaveBeenCalledWith("project-1", "T-001", "default");
  });

  it("rejects missing projectId", async () => {
    await expect(handlePlanweaveTool("open_project", { rootPath: "/not-accepted" }, createGateway())).rejects.toThrow("projectId is required");
  });
});

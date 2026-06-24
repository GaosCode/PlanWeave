import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createGateway, project, readJson, schemaDocument } from "./toolTestHelpers.js";
import { planweaveToolDefinitions } from "../toolDefinitions.js";
import { handlePlanweaveTool, planweaveToolNames } from "../tools.js";

describe("handlePlanweaveTool", () => {
  it("keeps compatibility aliases in the exported tool list", () => {
    expect(planweaveToolNames).toEqual(expect.arrayContaining([
      "get_project_overview",
      "preview_execution_graph",
      "write_task_prompt",
      "write_block_prompt"
    ]));
  });

  it("returns schema documents as JSON text content", async () => {
    const result = readJson(await handlePlanweaveTool("get_schema", { topic: "manifest" }, createGateway()));

    expect(result).toEqual({
      topic: "manifest",
      documents: {
        manifest: schemaDocument
      }
    });
  });

  it("returns a PlanWeave guide with storage layout and tool navigation", async () => {
    const result = readJson(await handlePlanweaveTool("get_planweave_guide", undefined, createGateway()));

    expect(result).toMatchObject({
      guide: {
        summary: expect.stringContaining("MCP tools"),
        workspaceLayout: expect.arrayContaining([
          expect.stringContaining("default canvas"),
          expect.stringContaining("canvases/default/package"),
          expect.stringContaining("legacy default canvas data")
        ]),
        toolSelection: expect.arrayContaining([
          expect.objectContaining({ need: expect.stringContaining("Find local projects"), tool: "get_project_tree" }),
          expect.objectContaining({ need: expect.stringContaining("parallel execution"), tool: "update_canvas_execution_policy" }),
          expect.objectContaining({ need: expect.stringContaining("parallel-safe"), tool: "update_block_planning" })
        ]),
        concepts: expect.arrayContaining([
          expect.objectContaining({
            name: "Parallel execution policy",
            description: expect.stringContaining("execution.parallel.enabled")
          })
        ]),
        nonGoals: expect.arrayContaining([
          expect.stringContaining("currently selected PlanWeave Desktop project")
        ])
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

  it("returns a project tree for selecting the correct registered project", async () => {
    const gateway = createGateway();
    const eccoProject = {
      ...project,
      projectId: "ecco-the-dolphin-f7761c39",
      name: "Ecco the Dolphin"
    };
    const tidesingerProject = {
      ...project,
      projectId: "tidesinger-e7bb1716",
      name: "TIDESINGER"
    };
    gateway.listProjects = async () => [eccoProject, tidesingerProject];

    const result = readJson(await handlePlanweaveTool("get_project_tree", undefined, gateway));

    expect(result).toMatchObject({
      desktopSelection: null,
      projects: [
        {
          project: {
            projectId: "ecco-the-dolphin-f7761c39",
            name: "Ecco the Dolphin",
            activeCanvasId: "default"
          },
          validation: { ok: true },
          status: {
            projectId: "project-1",
            warnings: [
              {
                path: "canvases/default/package/manifest.json"
              }
            ]
          },
          readyBlocks: [
            {
              ref: "T-001#I-001"
            }
          ],
          canvases: [
            {
              canvasId: "default",
              taskCount: 1,
              tasks: [
                {
                  taskId: "T-001",
                  blockCount: 1
                }
              ]
            }
          ],
          errors: []
        },
        {
          project: {
            projectId: "tidesinger-e7bb1716",
            name: "TIDESINGER",
            activeCanvasId: "default"
          }
        }
      ]
    });
    expect(JSON.stringify(result)).toContain("Use project.projectId and canvasId exactly as returned here");
    expect(JSON.stringify(result)).not.toContain("/sensitive");
    expect(gateway.validateProject).toHaveBeenCalledWith("ecco-the-dolphin-f7761c39");
    expect(gateway.validateProject).toHaveBeenCalledWith("tidesinger-e7bb1716");
    expect(gateway.getProjectGraph).toHaveBeenCalledWith("ecco-the-dolphin-f7761c39", "default");
    expect(gateway.getProjectGraph).toHaveBeenCalledWith("tidesinger-e7bb1716", "default");
  });

  it("keeps other PlanWeave context visible when one context reader fails", async () => {
    const gateway = createGateway();
    gateway.getProjectGraph.mockRejectedValueOnce(new Error("Could not read /sensitive/home/projects/project-1/canvases/default/package/manifest.json"));

    const result = readJson(await handlePlanweaveTool("get_project_tree", { projectId: "project-1" }, gateway));

    expect(result).toMatchObject({
      projects: [
        {
          project: {
            projectId: "project-1"
          },
          validation: { ok: true },
          canvases: [],
          errors: [
            {
              scope: "get_project_graph:project-1:default",
              message: "Could not read canvases/default/package/manifest.json"
            }
          ]
        }
      ],
      errors: []
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

  it("keeps get_project_overview as an open_project compatibility alias", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("get_project_overview", { projectId: "project-1" }, gateway));

    expect(gateway.openProject).toHaveBeenCalledWith("project-1");
    expect(result).toMatchObject({ project: { projectId: "project-1" } });
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

  it("returns sanitized execution status by projectId and canvasId", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("get_status", { projectId: "project-1", canvasId: "default" }, gateway));

    expect(gateway.getStatus).toHaveBeenCalledWith("project-1", "default");
    expect(result).toMatchObject({
      projectId: "project-1",
      canvasId: "default",
      taskTotal: 1,
      blockTotal: 1,
      currentRefs: [],
      openFeedback: [],
      nextClaimable: ["T-001#I-001"],
      counts: {
        tasks: { ready: 1 },
        blocks: { ready: 1 },
        feedback: { open: 0 }
      },
      warnings: [
        {
          code: "status_manifest_warning",
          message: "Manifest warning at canvases/default/package/manifest.json",
          path: "canvases/default/package/manifest.json"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("projectRoot");
    expect(JSON.stringify(result)).not.toContain("/sensitive");
  });

  it("returns rendered prompts without writing source prompts", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("get_prompt", { projectId: "project-1", canvasId: "default", ref: "T-001#I-001" }, gateway));

    expect(gateway.getPrompt).toHaveBeenCalledWith("project-1", "default", "T-001#I-001");
    expect(result).toEqual({
      projectId: "project-1",
      canvasId: "default",
      ref: "T-001#I-001",
      markdown: "# Rendered prompt"
    });
    expect(gateway.updateBlock).not.toHaveBeenCalled();
    expect(gateway.updateTask).not.toHaveBeenCalled();
  });

  it("returns the resolved canvas id for rendered prompts when canvasId is omitted", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("get_prompt", { projectId: "project-1", ref: "T-001#I-001" }, gateway));

    expect(gateway.getPrompt).toHaveBeenCalledWith("project-1", undefined, "T-001#I-001");
    expect(result).toEqual({
      projectId: "project-1",
      canvasId: "default",
      ref: "T-001#I-001",
      markdown: "# Rendered prompt"
    });
  });

  it("searches projects with validated filters and sanitized results", async () => {
    const gateway = createGateway();
    gateway.searchProject.mockResolvedValueOnce({
      results: [
        {
          kind: "prompt",
          canvasId: "default",
          canvasName: "Default",
          ref: "T-001#I-001",
          title: "Run log https://example.com/docs/path /api/status /Users/me/My Project/results/T-001/run.log",
          excerpt: "needle appears in /Users/me/My Project/canvases/default/package/nodes/T-001/prompt.md"
        }
      ],
      diagnostics: [
        {
          code: "search_manifest_read_failed",
          message: "Could not read /sensitive/home/projects/project-1/canvases/default/package/manifest.json",
          path: "/sensitive/home/projects/project-1/canvases/default/package/manifest.json"
        }
      ]
    });
    const result = readJson(
      await handlePlanweaveTool(
        "search_project",
        { projectId: "project-1", canvasId: "default", query: "  needle  ", kinds: ["prompt"], limit: 5 },
        gateway
      )
    );

    expect(gateway.searchProject).toHaveBeenCalledWith("project-1", {
      query: "needle",
      canvasId: "default",
      kinds: ["prompt"],
      limit: 5
    });
    expect(result).toEqual({
      results: [
        {
          kind: "prompt",
          canvasId: "default",
          canvasName: "Default",
          ref: "T-001#I-001",
          title: "Run log https://example.com/docs/path /api/status results/T-001/run.log",
          excerpt: "needle appears in canvases/default/package/nodes/T-001/prompt.md"
        }
      ],
      diagnostics: [
        {
          code: "search_manifest_read_failed",
          message: "Could not read canvases/default/package/manifest.json",
          path: "canvases/default/package/manifest.json"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("/sensitive");
    expect(JSON.stringify(result)).not.toContain("/sensitive/home/projects/project-1/canvases/default/package/manifest.json");
    expect(JSON.stringify(result)).not.toContain("/sensitive/home/projects/project-1/results/T-001/run.log");
    expect(JSON.stringify(result)).not.toContain("/Users/me/My Project");
    expect(JSON.stringify(result)).toContain("https://example.com/docs/path");
    expect(JSON.stringify(result)).toContain("/api/status");
    expect(JSON.stringify(result)).toContain("search_manifest_read_failed");
  });

  it("rejects invalid search query, kinds, and limit", async () => {
    const gateway = createGateway();

    await expect(handlePlanweaveTool("search_project", { projectId: "project-1", query: " " }, gateway)).rejects.toThrow("query is required");
    await expect(handlePlanweaveTool("search_project", { projectId: "project-1", query: "needle", kinds: ["unknown"] }, gateway)).rejects.toThrow(
      "kinds[0] must be one of"
    );
    await expect(handlePlanweaveTool("search_project", { projectId: "project-1", query: "needle", limit: 101 }, gateway)).rejects.toThrow(
      "limit must be an integer from 1 to 100"
    );
  });

  it("lists ready blocks from the selected ready queue", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("list_ready_blocks", { projectId: "project-1", canvasId: "default" }, gateway));

    expect(gateway.listReadyBlocks).toHaveBeenCalledWith("project-1", "default");
    expect(result).toEqual({
      readyBlocks: [
        {
          canvasId: "default",
          canvasName: "Default",
          ref: "T-001#I-001",
          taskId: "T-001",
          blockId: "I-001",
          title: "Implement",
          parallelSafe: true,
          locks: ["repo"],
          reviewGate: null
        }
      ]
    });
  });

  it("rejects local path arguments for read-only context tools", async () => {
    const gateway = createGateway();

    await expect(handlePlanweaveTool("get_status", { projectId: "project-1", rootPath: "/ignored" }, gateway)).rejects.toThrow(
      "rootPath is not accepted"
    );
    await expect(handlePlanweaveTool("get_prompt", { projectId: "project-1", ref: "T-001#I-001", projectRoot: "/ignored" }, gateway)).rejects.toThrow(
      "projectRoot is not accepted"
    );
    await expect(handlePlanweaveTool("list_ready_blocks", { projectId: "project-1", workspaceRoot: "/ignored" }, gateway)).rejects.toThrow(
      "workspaceRoot is not accepted"
    );
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

  it("keeps preview_execution_graph as a get_project_graph compatibility alias", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("preview_execution_graph", { projectId: "project-1", canvasId: "default" }, gateway));

    expect(gateway.getProjectGraph).toHaveBeenCalledWith("project-1", "default");
    expect(result).toMatchObject({ graph: { projectId: "project-1" } });
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

  it("returns authoring rules and an importable package example", async () => {
    const rules = readJson(await handlePlanweaveTool("get_authoring_rules", undefined, createGateway()));
    const example = readJson(await handlePlanweaveTool("get_plan_package_example", undefined, createGateway()));

    expect(rules).toMatchObject({
      rules: expect.arrayContaining([expect.stringContaining("projectId")])
    });
    expect(example).toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ path: "manifest.json", encoding: "utf8" })])
    });
  });

  it("initializes managed projects without accepting root paths", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("init_project", { name: "New Project", rootPath: "/ignored" }, gateway));

    expect(gateway.initProject).toHaveBeenCalledWith("New Project");
    expect(result).toEqual({
      project: {
        projectId: "project-1",
        name: "Project One",
        activeCanvasId: "default",
        taskCanvases: project.taskCanvases
      }
    });
    expect(JSON.stringify(result)).not.toContain("/ignored");
  });

  it("creates a new task canvas in a registered project", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("create_canvas", { projectId: "project-1", name: "Release plan", canvasId: "ignored" }, gateway));

    expect(gateway.createCanvas).toHaveBeenCalledWith("project-1", "Release plan");
    expect(result).toEqual({
      canvas: {
        canvasId: "canvas-new",
        name: "Release plan",
        taskCount: 0,
        missingPromptCount: 0,
        diagnostics: [],
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:00.000Z"
      }
    });
  });

  it("dispatches graph write tools through the runtime gateway", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool(
      "create_task",
      { projectId: "project-1", canvasId: "default", title: "New task", promptMarkdown: "# Task", blockTypes: ["implementation", "review"] },
      gateway
    );
    await handlePlanweaveTool(
      "update_block",
      { projectId: "project-1", canvasId: "default", taskId: "T-001", blockId: "I-001", title: "Implement v2", executor: null },
      gateway
    );
    await handlePlanweaveTool("add_dependency", { projectId: "project-1", fromTaskId: "T-001", toTaskId: "T-002" }, gateway);

    expect(gateway.createTask).toHaveBeenCalledWith("project-1", "default", {
      title: "New task",
      promptMarkdown: "# Task",
      acceptance: undefined,
      blockTypes: ["implementation", "review"],
      executor: undefined
    });
    expect(gateway.updateBlock).toHaveBeenCalledWith("project-1", "default", "T-001#I-001", {
      title: "Implement v2",
      promptMarkdown: undefined,
      executor: null
    });
    expect(gateway.addDependency).toHaveBeenCalledWith("project-1", undefined, "T-001", "T-002");
  });

  it("dispatches planning write tools through the runtime gateway", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool("update_task_acceptance", {
      projectId: "project-1",
      canvasId: "default",
      taskId: "T-001",
      acceptance: ["Acceptance one", "Acceptance two"]
    }, gateway);
    await handlePlanweaveTool("update_block_dependencies", {
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-001#B-002",
      dependsOn: ["B-001"]
    }, gateway);
    await handlePlanweaveTool("update_canvas_execution_policy", {
      projectId: "project-1",
      canvasId: "default",
      defaultExecutor: null,
      parallelEnabled: true,
      maxConcurrent: 3
    }, gateway);
    await handlePlanweaveTool("update_block_planning", {
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-001#B-001",
      parallelSafe: true,
      parallelLocks: ["repo"]
    }, gateway);
    await handlePlanweaveTool("update_review_pipeline", {
      projectId: "project-1",
      canvasId: "default",
      taskId: "T-001",
      packageDefaults: { maxFeedbackCycles: 3, completionPolicy: "strict" },
      steps: [
        {
          blockRef: "T-001#R-001",
          title: "Architecture review",
          enabled: true,
          preset: "architecture",
          triggerCondition: "manual",
          inputContext: "implementation report",
          passCriteria: "Boundaries remain clear.",
          feedbackFormat: "Findings by severity.",
          maxFeedbackCycles: 2,
          hook: null,
          promptMarkdown: "# Architecture review"
        }
      ]
    }, gateway);

    expect(gateway.updateTaskAcceptance).toHaveBeenCalledWith("project-1", "default", "T-001", [
      "Acceptance one",
      "Acceptance two"
    ]);
    expect(gateway.updateBlockDependencies).toHaveBeenCalledWith("project-1", "default", "T-001#B-002", ["B-001"]);
    expect(gateway.updateCanvasExecutionPolicy).toHaveBeenCalledWith("project-1", "default", {
      defaultExecutor: null,
      parallelEnabled: true,
      maxConcurrent: 3
    });
    expect(gateway.updateBlockPlanning).toHaveBeenCalledWith("project-1", "default", "T-001#B-001", {
      parallelSafe: true,
      parallelLocks: ["repo"],
      reviewRequired: undefined,
      maxFeedbackCycles: undefined,
      reviewHook: undefined
    });
    expect(gateway.updateReviewPipeline).toHaveBeenCalledWith("project-1", "default", "T-001", {
      packageDefaults: { maxFeedbackCycles: 3, completionPolicy: "strict" },
      steps: [
        {
          blockId: "R-001",
          blockRef: "T-001#R-001",
          title: "Architecture review",
          enabled: true,
          preset: "architecture",
          triggerCondition: "manual",
          inputContext: "implementation report",
          passCriteria: "Boundaries remain clear.",
          feedbackFormat: "Findings by severity.",
          maxFeedbackCycles: 2,
          hook: null,
          promptMarkdown: "# Architecture review"
        }
      ]
    });
  });

  it("uses update_review_pipeline input defaults in both definition and parser paths", async () => {
    const gateway = createGateway();
    const input = {
      projectId: " project-1 ",
      canvasId: " default ",
      taskId: " T-001 ",
      steps: [
        {
          blockRef: " T-001#R-001 ",
          title: " Architecture review ",
          preset: " architecture ",
          inputContext: " implementation report ",
          passCriteria: " Boundaries remain clear. ",
          feedbackFormat: " Findings by severity. ",
          promptMarkdown: "# Architecture review"
        }
      ]
    };
    const definitionShape = planweaveToolDefinitions.update_review_pipeline.inputSchema;

    expect(definitionShape).toBeDefined();
    expect(z.object(definitionShape!).parse(input)).toMatchObject({
      projectId: "project-1",
      canvasId: "default",
      taskId: "T-001",
      steps: [
        {
          blockId: "R-001",
          blockRef: "T-001#R-001",
          title: "Architecture review",
          enabled: true,
          preset: "architecture",
          triggerCondition: "after_required_work_completed",
          inputContext: "implementation report",
          passCriteria: "Boundaries remain clear.",
          feedbackFormat: "Findings by severity.",
          maxFeedbackCycles: 1,
          hook: null,
          promptMarkdown: "# Architecture review"
        }
      ]
    });

    await handlePlanweaveTool("update_review_pipeline", input, gateway);

    expect(gateway.updateReviewPipeline).toHaveBeenCalledWith("project-1", "default", "T-001", {
      packageDefaults: undefined,
      steps: [
        {
          blockId: "R-001",
          blockRef: "T-001#R-001",
          title: "Architecture review",
          enabled: true,
          preset: "architecture",
          triggerCondition: "after_required_work_completed",
          inputContext: "implementation report",
          passCriteria: "Boundaries remain clear.",
          feedbackFormat: "Findings by severity.",
          maxFeedbackCycles: 1,
          hook: null,
          promptMarkdown: "# Architecture review"
        }
      ]
    });
  });

  it("normalizes target write tool inputs through shared schemas", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool(
      "create_task",
      {
        projectId: " project-1 ",
        canvasId: " default ",
        title: " New task ",
        promptMarkdown: "# Task",
        acceptance: null,
        blockTypes: null,
        executor: ""
      },
      gateway
    );
    await handlePlanweaveTool(
      "update_block",
      { projectId: "project-1", canvasId: "default", blockRef: " T-001#I-001 ", title: " Implement v2 ", executor: "" },
      gateway
    );

    expect(gateway.createTask).toHaveBeenCalledWith("project-1", "default", {
      title: "New task",
      promptMarkdown: "# Task",
      acceptance: undefined,
      blockTypes: undefined,
      executor: null
    });
    expect(gateway.updateBlock).toHaveBeenCalledWith("project-1", "default", "T-001#I-001", {
      title: "Implement v2",
      promptMarkdown: undefined,
      executor: null
    });
    await expect(handlePlanweaveTool("update_task", { projectId: "project-1", taskId: "T-001" }, gateway)).rejects.toThrow(
      "At least one of title, promptMarkdown, or executor must be provided."
    );
  });

  it("dispatches project graph dependency tools through the runtime gateway", async () => {
    const gateway = createGateway();

    const canvasResult = readJson(await handlePlanweaveTool("add_canvas_dependency", {
      projectId: "project-1",
      fromCanvasId: "canvas-new",
      toCanvasId: "default"
    }, gateway));
    await handlePlanweaveTool("remove_canvas_dependency", {
      projectId: "project-1",
      fromCanvasId: "canvas-new",
      toCanvasId: "default"
    }, gateway);
    await handlePlanweaveTool("add_cross_task_dependency", {
      projectId: "project-1",
      fromCanvasId: "canvas-new",
      fromTaskId: "T-001",
      toCanvasId: "default",
      toTaskId: "T-001"
    }, gateway);
    await handlePlanweaveTool("remove_cross_task_dependency", {
      projectId: "project-1",
      fromCanvasId: "canvas-new",
      fromTaskId: "T-001",
      toCanvasId: "default",
      toTaskId: "T-001"
    }, gateway);

    expect(canvasResult).toMatchObject({ projectGraphEdit: { ok: true } });
    expect(gateway.addCanvasDependency).toHaveBeenCalledWith("project-1", "canvas-new", "default");
    expect(gateway.removeCanvasDependency).toHaveBeenCalledWith("project-1", "canvas-new", "default");
    expect(gateway.addCrossTaskDependency).toHaveBeenCalledWith(
      "project-1",
      { canvasId: "canvas-new", taskId: "T-001" },
      { canvasId: "default", taskId: "T-001" }
    );
    expect(gateway.removeCrossTaskDependency).toHaveBeenCalledWith(
      "project-1",
      { canvasId: "canvas-new", taskId: "T-001" },
      { canvasId: "default", taskId: "T-001" }
    );
  });

  it("reads prompt surfaces and writes prompt markdown through update tools", async () => {
    const gateway = createGateway();
    const projectPrompt = readJson(await handlePlanweaveTool("read_prompt", { projectId: "project-1", target: "project" }, gateway));
    const blockPrompt = readJson(
      await handlePlanweaveTool("read_prompt", { projectId: "project-1", target: "block", blockRef: "T-001#I-001", rendered: true }, gateway)
    );

    await handlePlanweaveTool("update_task", { projectId: "project-1", taskId: "T-001", promptMarkdown: "# Changed" }, gateway);
    await handlePlanweaveTool("update_project_prompt", { projectId: "project-1", markdown: "# Project v2" }, gateway);

    expect(projectPrompt).toMatchObject({ target: "project", markdown: "# Project" });
    expect(blockPrompt).toMatchObject({ target: "block", blockRef: "T-001#I-001", markdown: "# Surface", rendered: true });
    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", undefined, "T-001", { promptMarkdown: "# Changed" });
    expect(gateway.updateProjectPrompt).toHaveBeenCalledWith("project-1", "# Project v2");
  });

  it("keeps prompt writing compatibility aliases wired to update tools", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool("write_task_prompt", { projectId: "project-1", canvasId: "default", taskId: "T-001", markdown: "# Task v2" }, gateway);
    await handlePlanweaveTool("write_block_prompt", { projectId: "project-1", canvasId: "default", blockRef: "T-001#I-001", markdown: "# Block v2" }, gateway);

    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", "default", "T-001", { promptMarkdown: "# Task v2" });
    expect(gateway.updateBlock).toHaveBeenCalledWith("project-1", "default", "T-001#I-001", { promptMarkdown: "# Block v2" });
  });

  it("exports and imports package file sets as structured content", async () => {
    const gateway = createGateway();
    const exported = readJson(await handlePlanweaveTool("export_plan_package", { projectId: "project-1", canvasId: "default" }, gateway));
    const imported = readJson(
      await handlePlanweaveTool(
        "import_plan_package",
        { name: "Imported", files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }] },
        gateway
      )
    );

    expect(exported).toMatchObject({
      planPackage: {
        canvasId: "default",
        files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }]
      }
    });
    expect(gateway.importPlanPackage).toHaveBeenCalledWith({
      name: "Imported",
      files: [{ path: "manifest.json", content: "{}", encoding: "utf8" }],
      overwrite: false
    });
    expect(imported).toMatchObject({ importedFiles: 1, validation: { ok: true } });
  });

  it("explains validation errors with repair suggestions", async () => {
    const gateway = createGateway();
    gateway.validateProject.mockResolvedValueOnce({
      ok: false,
      errors: [{ code: "missing_prompt", message: "Prompt is missing.", path: "nodes/T-001/prompt.md" }],
      warnings: []
    });

    const result = readJson(await handlePlanweaveTool("explain_validation_errors", { projectId: "project-1" }, gateway));

    expect(result).toMatchObject({
      ok: false,
      explanations: [
        {
          code: "missing_prompt",
          severity: "error",
          suggestedAction: expect.stringContaining("update_task or update_block")
        }
      ]
    });
  });

  it("rejects missing projectId", async () => {
    await expect(handlePlanweaveTool("open_project", { rootPath: "/not-accepted" }, createGateway())).rejects.toThrow("projectId is required");
  });
});

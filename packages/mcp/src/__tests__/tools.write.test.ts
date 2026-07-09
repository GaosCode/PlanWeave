import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createGateway, project, readJson } from "./toolTestHelpers.js";
import { planweaveToolDefinitions } from "../toolDefinitions.js";
import { handlePlanweaveTool } from "../tools.js";

describe("MCP tools: write tools", () => {
  it("dispatches graph write tools through the runtime gateway", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool(
      "create_task",
      {
        projectId: "project-1",
        canvasId: "default",
        title: "New task",
        promptMarkdown: "# Task",
        blockTypes: ["implementation", "review"]
      },
      gateway
    );
    await handlePlanweaveTool(
      "update_block",
      {
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-001",
        blockId: "I-001",
        title: "Implement v2",
        executor: null
      },
      gateway
    );
    await handlePlanweaveTool(
      "create_block",
      {
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-001",
        type: "implementation",
        title: "Follow-up",
        promptMarkdown: "# Follow-up"
      },
      gateway
    );
    await handlePlanweaveTool(
      "create_block",
      {
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-001",
        type: "implementation",
        title: "Explicit follow-up",
        promptMarkdown: "# Explicit follow-up",
        dependsOn: []
      },
      gateway
    );
    await handlePlanweaveTool(
      "add_dependency",
      { projectId: "project-1", fromTaskId: "T-001", toTaskId: "T-002" },
      gateway
    );

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
    expect(gateway.createBlock).toHaveBeenNthCalledWith(1, "project-1", "default", {
      taskId: "T-001",
      type: "implementation",
      title: "Follow-up",
      promptMarkdown: "# Follow-up",
      executor: undefined,
      dependsOn: undefined
    });
    expect(gateway.createBlock).toHaveBeenNthCalledWith(2, "project-1", "default", {
      taskId: "T-001",
      type: "implementation",
      title: "Explicit follow-up",
      promptMarkdown: "# Explicit follow-up",
      executor: undefined,
      dependsOn: []
    });
    expect(gateway.addDependency).toHaveBeenCalledWith("project-1", undefined, "T-001", "T-002");
  });

  it("dispatches planning write tools through the runtime gateway", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool(
      "update_task_acceptance",
      {
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-001",
        acceptance: ["Acceptance one", "Acceptance two"]
      },
      gateway
    );
    await handlePlanweaveTool(
      "update_block_dependencies",
      {
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-001#B-002",
        dependsOn: ["B-001"]
      },
      gateway
    );
    await handlePlanweaveTool(
      "update_canvas_execution_policy",
      {
        projectId: "project-1",
        canvasId: "default",
        defaultExecutor: null,
        parallelEnabled: true,
        maxConcurrent: 3
      },
      gateway
    );
    await handlePlanweaveTool(
      "update_block_planning",
      {
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-001#B-001",
        parallelSafe: true,
        parallelLocks: ["repo"]
      },
      gateway
    );
    await handlePlanweaveTool(
      "update_review_pipeline",
      {
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
      },
      gateway
    );

    expect(gateway.updateTaskAcceptance).toHaveBeenCalledWith("project-1", "default", "T-001", [
      "Acceptance one",
      "Acceptance two"
    ]);
    expect(gateway.updateBlockDependencies).toHaveBeenCalledWith(
      "project-1",
      "default",
      "T-001#B-002",
      ["B-001"]
    );
    expect(gateway.updateCanvasExecutionPolicy).toHaveBeenCalledWith("project-1", "default", {
      defaultExecutor: null,
      parallelEnabled: true,
      maxConcurrent: 3
    });
    expect(gateway.updateBlockPlanning).toHaveBeenCalledWith(
      "project-1",
      "default",
      "T-001#B-001",
      {
        exclusive: false,
        parallelSafe: true,
        parallelLocks: ["repo"],
        reviewRequired: undefined,
        maxFeedbackCycles: undefined,
        reviewHook: undefined
      }
    );
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
      {
        projectId: "project-1",
        canvasId: "default",
        blockRef: " T-001#I-001 ",
        title: " Implement v2 ",
        executor: ""
      },
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
    await expect(
      handlePlanweaveTool("update_task", { projectId: "project-1", taskId: "T-001" }, gateway)
    ).rejects.toThrow("At least one of title, promptMarkdown, or executor must be provided.");
  });

  it("dispatches project graph dependency tools through the runtime gateway", async () => {
    const gateway = createGateway();

    const canvasResult = readJson(
      await handlePlanweaveTool(
        "add_canvas_dependency",
        {
          projectId: "project-1",
          fromCanvasId: "canvas-new",
          toCanvasId: "default"
        },
        gateway
      )
    );
    await handlePlanweaveTool(
      "remove_canvas_dependency",
      {
        projectId: "project-1",
        fromCanvasId: "canvas-new",
        toCanvasId: "default"
      },
      gateway
    );
    await handlePlanweaveTool(
      "add_cross_task_dependency",
      {
        projectId: "project-1",
        fromCanvasId: "canvas-new",
        fromTaskId: "T-001",
        toCanvasId: "default",
        toTaskId: "T-001"
      },
      gateway
    );
    await handlePlanweaveTool(
      "remove_cross_task_dependency",
      {
        projectId: "project-1",
        fromCanvasId: "canvas-new",
        fromTaskId: "T-001",
        toCanvasId: "default",
        toTaskId: "T-001"
      },
      gateway
    );

    expect(canvasResult).toMatchObject({ projectGraphEdit: { ok: true } });
    expect(gateway.addCanvasDependency).toHaveBeenCalledWith("project-1", "canvas-new", "default");
    expect(gateway.removeCanvasDependency).toHaveBeenCalledWith(
      "project-1",
      "canvas-new",
      "default"
    );
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
    const projectPrompt = readJson(
      await handlePlanweaveTool(
        "read_prompt",
        { projectId: "project-1", target: "project" },
        gateway
      )
    );
    const blockSourcePrompt = readJson(
      await handlePlanweaveTool(
        "read_prompt",
        { projectId: "project-1", target: "block", blockRef: "T-001#I-001" },
        gateway
      )
    );
    const blockPrompt = readJson(
      await handlePlanweaveTool(
        "read_prompt",
        { projectId: "project-1", target: "block", blockRef: "T-001#I-001", rendered: true },
        gateway
      )
    );

    await handlePlanweaveTool(
      "update_task",
      { projectId: "project-1", taskId: "T-001", promptMarkdown: "# Changed" },
      gateway
    );
    await handlePlanweaveTool(
      "update_project_prompt",
      { projectId: "project-1", markdown: "# Project v2" },
      gateway
    );

    expect(projectPrompt).toMatchObject({ target: "project", markdown: "# Project" });
    expect(blockSourcePrompt).toMatchObject({
      target: "block",
      blockRef: "T-001#I-001",
      markdown: "# Block",
      rendered: false
    });
    expect(JSON.stringify(blockSourcePrompt)).not.toContain("# Surface");
    expect(blockPrompt).toMatchObject({
      target: "block",
      blockRef: "T-001#I-001",
      markdown: "# Surface",
      rendered: true
    });
    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", undefined, "T-001", {
      promptMarkdown: "# Changed"
    });
    expect(gateway.updateProjectPrompt).toHaveBeenCalledWith("project-1", "# Project v2");
  });

  it("keeps prompt writing compatibility aliases wired to update tools", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool(
      "write_task_prompt",
      { projectId: "project-1", canvasId: "default", taskId: "T-001", markdown: "# Task v2" },
      gateway
    );
    await handlePlanweaveTool(
      "write_block_prompt",
      {
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-001#I-001",
        markdown: "# Block v2"
      },
      gateway
    );
    await handlePlanweaveTool(
      "write_prompt_source",
      {
        projectId: "project-1",
        canvasId: "default",
        target: "task",
        taskId: "T-001",
        markdown: "# Task v3"
      },
      gateway
    );
    await handlePlanweaveTool(
      "write_prompt_source",
      { projectId: "project-1", target: "project", markdown: "# Project v3" },
      gateway
    );

    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", "default", "T-001", {
      promptMarkdown: "# Task v2"
    });
    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", "default", "T-001", {
      promptMarkdown: "# Task v3"
    });
    expect(gateway.updateBlock).toHaveBeenCalledWith("project-1", "default", "T-001#I-001", {
      promptMarkdown: "# Block v2"
    });
    expect(gateway.updateProjectPrompt).toHaveBeenCalledWith("project-1", "# Project v3");
  });
});

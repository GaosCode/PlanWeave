import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import type { GraphEditResult } from "@planweave-ai/runtime";
import { createGateway } from "./toolTestHelpers.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { handlePlanweaveTool } from "../tools.js";

function readToolBody(
  result: Awaited<ReturnType<typeof handlePlanweaveTool>>
): Record<string, unknown> {
  return JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}") as Record<
    string,
    unknown
  >;
}

describe("dependency MCP tools", () => {
  it("dispatches Phase 7 bulk graph item tools through dedicated gateway methods", async () => {
    const gateway = createGateway();

    const createTasksResult = await handlePlanweaveTool(
      "bulk_create_tasks",
      {
        projectId: "project-1",
        canvasId: "default",
        tasks: [
          {
            title: "Implement bulk",
            promptMarkdown: "# Implement bulk",
            acceptance: ["Done"],
            blockTypes: ["implementation"],
            executor: "codex"
          }
        ]
      },
      gateway
    );
    const createBlocksResult = await handlePlanweaveTool(
      "bulk_create_blocks",
      {
        projectId: "project-1",
        canvasId: "default",
        blocks: [
          {
            taskId: "T-001",
            type: "implementation",
            title: "Wire bulk",
            promptMarkdown: "# Wire bulk",
            executor: null,
            dependsOn: []
          }
        ]
      },
      gateway
    );
    const updateTasksResult = await handlePlanweaveTool(
      "bulk_update_tasks",
      {
        projectId: "project-1",
        canvasId: "default",
        updates: [{ taskId: "T-001", title: "Updated task" }]
      },
      gateway
    );
    const updateBlocksResult = await handlePlanweaveTool(
      "bulk_update_blocks",
      {
        projectId: "project-1",
        canvasId: "default",
        updates: [
          {
            blockRef: "T-001#B-001",
            promptMarkdown: "# Updated block",
            sharedResources: ["api"]
          }
        ]
      },
      gateway
    );
    const removeItemsResult = await handlePlanweaveTool(
      "bulk_remove_graph_items",
      {
        projectId: "project-1",
        canvasId: "default",
        tasks: ["T-003"],
        blocks: ["T-001#B-002"],
        taskDependencyEdges: [{ dependentTaskId: "T-002", dependsOnTaskId: "T-001" }],
        blockDependencyRefs: [{ blockRef: "T-001#B-002", dependsOnBlockId: "B-001" }]
      },
      gateway
    );

    for (const [toolName, result] of [
      ["bulk_create_tasks", createTasksResult],
      ["bulk_create_blocks", createBlocksResult],
      ["bulk_update_tasks", updateTasksResult],
      ["bulk_update_blocks", updateBlocksResult],
      ["bulk_remove_graph_items", removeItemsResult]
    ] as const) {
      const body = readToolBody(result);
      expect(z.object(planweaveToolOutputSchemas[toolName]).safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ bulkEdit: { ok: true, affectedTasks: ["T-001"] } });
      expect(body).not.toHaveProperty("edit");
      expect(body).not.toHaveProperty("graph");
      expect(body).not.toHaveProperty("promptMarkdown");
    }
    expect(readToolBody(updateBlocksResult)).toMatchObject({
      bulkEdit: { affectedBlocks: ["T-001#B-001"], counts: { affectedBlockCount: 1 } }
    });
    expect(readToolBody(removeItemsResult)).toMatchObject({
      bulkEdit: { affectedBlocks: ["T-001#B-002"], counts: { affectedBlockCount: 1 } }
    });
    expect(gateway.bulkCreateTasks).toHaveBeenCalledWith("project-1", "default", [
      {
        title: "Implement bulk",
        promptMarkdown: "# Implement bulk",
        acceptance: ["Done"],
        blockTypes: ["implementation"],
        executor: "codex"
      }
    ]);
    expect(gateway.bulkCreateBlocks).toHaveBeenCalledWith("project-1", "default", [
      {
        taskId: "T-001",
        type: "implementation",
        title: "Wire bulk",
        promptMarkdown: "# Wire bulk",
        executor: null,
        dependsOn: []
      }
    ]);
    expect(gateway.bulkUpdateTasks).toHaveBeenCalledWith("project-1", "default", [
      {
        taskId: "T-001",
        input: {
          title: "Updated task",
          promptMarkdown: undefined,
          executor: undefined,
          acceptance: undefined
        }
      }
    ]);
    expect(gateway.bulkUpdateBlocks).toHaveBeenCalledWith("project-1", "default", [
      {
        blockRef: "T-001#B-001",
        input: {
          title: undefined,
          promptMarkdown: "# Updated block",
          executor: undefined,
          dependsOn: undefined,
          sharedResources: ["api"],
          reviewRequired: undefined,
          maxFeedbackCycles: undefined,
          reviewHook: undefined
        }
      }
    ]);
    expect(gateway.bulkRemoveGraphItems).toHaveBeenCalledWith("project-1", "default", {
      tasks: ["T-003"],
      blocks: ["T-001#B-002"],
      taskDependencyEdges: [{ dependentTaskId: "T-002", dependsOnTaskId: "T-001" }],
      blockDependencyRefs: [{ blockRef: "T-001#B-002", dependsOnBlockId: "B-001" }]
    });
    expect(gateway.createTask).not.toHaveBeenCalled();
    expect(gateway.createBlock).not.toHaveBeenCalled();
    expect(gateway.updateTask).not.toHaveBeenCalled();
    expect(gateway.updateBlock).not.toHaveBeenCalled();
    expect(gateway.removeTask).not.toHaveBeenCalled();
    expect(gateway.removeBlock).not.toHaveBeenCalled();
    expect(gateway.removeDependency).not.toHaveBeenCalled();
    expect(gateway.updateBlockDependencies).not.toHaveBeenCalled();
  });

  it("dispatches semantic task dependency and bulk dependency tools transactionally through gateway methods", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool(
      "add_task_dependency",
      {
        projectId: "project-1",
        canvasId: "default",
        dependentTaskId: "T-002",
        dependsOnTaskId: "T-001"
      },
      gateway
    );
    await handlePlanweaveTool(
      "remove_task_dependency",
      {
        projectId: "project-1",
        canvasId: "default",
        dependentTaskId: "T-002",
        dependsOnTaskId: "T-001"
      },
      gateway
    );
    await handlePlanweaveTool(
      "set_task_dependencies",
      {
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-002",
        dependsOn: []
      },
      gateway
    );
    const bulkAddResult = await handlePlanweaveTool(
      "bulk_add_task_dependencies",
      {
        projectId: "project-1",
        canvasId: "default",
        edges: [{ dependentTaskId: "T-002", dependsOnTaskId: "T-001" }]
      },
      gateway
    );
    const bulkSetTaskResult = await handlePlanweaveTool(
      "bulk_set_task_dependencies",
      {
        projectId: "project-1",
        canvasId: "default",
        updates: [{ taskId: "T-002", dependsOn: [] }]
      },
      gateway
    );
    const bulkSetBlockResult = await handlePlanweaveTool(
      "bulk_set_block_dependencies",
      {
        projectId: "project-1",
        canvasId: "default",
        updates: [{ blockRef: "T-001#R-001", dependsOn: [] }]
      },
      gateway
    );

    for (const [toolName, result] of [
      ["bulk_add_task_dependencies", bulkAddResult],
      ["bulk_set_task_dependencies", bulkSetTaskResult],
      ["bulk_set_block_dependencies", bulkSetBlockResult]
    ] as const) {
      const body = readToolBody(result);
      expect(z.object(planweaveToolOutputSchemas[toolName]).safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        bulkEdit: { ok: true, counts: { affectedTaskCount: 1, diagnosticCount: 0 } }
      });
      expect(body).not.toHaveProperty("edit");
      expect(body).not.toHaveProperty("graph");
      expect(body).not.toHaveProperty("promptMarkdown");
    }
    expect(readToolBody(bulkSetBlockResult)).toMatchObject({
      bulkEdit: { affectedBlocks: ["T-001#R-001"], counts: { affectedBlockCount: 1 } }
    });

    expect(gateway.addDependency).toHaveBeenCalledWith("project-1", "default", "T-002", "T-001");
    expect(gateway.removeDependency).toHaveBeenCalledWith("project-1", "default", "T-002", "T-001");
    expect(gateway.setTaskDependencies).toHaveBeenCalledWith("project-1", "default", "T-002", []);
    expect(gateway.bulkAddTaskDependencies).toHaveBeenCalledWith("project-1", "default", [
      { dependentTaskId: "T-002", dependsOnTaskId: "T-001" }
    ]);
    expect(gateway.bulkSetTaskDependencies).toHaveBeenCalledWith("project-1", "default", [
      { taskId: "T-002", dependsOn: [] }
    ]);
    expect(gateway.bulkSetBlockDependencies).toHaveBeenCalledWith("project-1", "default", [
      { blockRef: "T-001#R-001", dependsOn: [] }
    ]);
  });

  it("allows set_block_dependencies to clear dependencies by block ref", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool(
      "set_block_dependencies",
      {
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-001#R-001",
        dependsOn: []
      },
      gateway
    );

    expect(gateway.updateBlockDependencies).toHaveBeenCalledWith(
      "project-1",
      "default",
      "T-001#R-001",
      []
    );
  });

  it("dispatches priority bulk review and parallel policy tools after validating all inputs", async () => {
    const gateway = createGateway();

    const reviewResult = await handlePlanweaveTool(
      "bulk_apply_review_pipeline",
      {
        projectId: "project-1",
        canvasId: "default",
        updates: [
          {
            taskId: "T-001",
            packageDefaults: { maxFeedbackCycles: 2, completionPolicy: "strict" },
            steps: [
              {
                blockRef: "T-001#R-001",
                title: "Review feature",
                enabled: true,
                preset: "manual",
                triggerCondition: "after_required_work_completed",
                inputContext: "Implementation report",
                passCriteria: "No blocking defects",
                feedbackFormat: "Actionable findings",
                maxFeedbackCycles: 2,
                hook: null,
                promptMarkdown: "# Review\n"
              }
            ]
          }
        ]
      },
      gateway
    );
    const parallelResult = await handlePlanweaveTool(
      "bulk_update_parallel_policy",
      {
        projectId: "project-1",
        canvasId: "default",
        canvasPolicy: { parallelEnabled: true, maxConcurrent: 3 },
        blocks: [{ blockRef: "T-001#B-001", sharedResources: ["api"] }]
      },
      gateway
    );

    for (const [toolName, result] of [
      ["bulk_apply_review_pipeline", reviewResult],
      ["bulk_update_parallel_policy", parallelResult]
    ] as const) {
      const body = readToolBody(result);
      expect(z.object(planweaveToolOutputSchemas[toolName]).safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        bulkEdit: {
          ok: true,
          counts: { affectedTaskCount: 1, affectedBlockCount: 1, diagnosticCount: 0 }
        }
      });
      expect(body).not.toHaveProperty("edit");
      expect(body).not.toHaveProperty("graph");
      expect(body).not.toHaveProperty("promptMarkdown");
    }
    expect(readToolBody(reviewResult)).toMatchObject({
      bulkEdit: { affectedBlocks: ["T-001#R-001"] }
    });
    expect(readToolBody(parallelResult)).toMatchObject({
      bulkEdit: { affectedBlocks: ["T-001#B-001"] }
    });
    expect(gateway.bulkApplyReviewPipeline).toHaveBeenCalledWith("project-1", "default", [
      expect.objectContaining({
        taskId: "T-001",
        input: expect.objectContaining({
          packageDefaults: { maxFeedbackCycles: 2, completionPolicy: "strict" }
        })
      })
    ]);
    expect(gateway.bulkUpdateParallelPolicy).toHaveBeenCalledWith("project-1", "default", {
      canvasPolicy: { defaultExecutor: undefined, parallelEnabled: true, maxConcurrent: 3 },
      blocks: [
        {
          blockRef: "T-001#B-001",
          input: { sharedResources: ["api"] }
        }
      ]
    });
    expect(gateway.updateReviewPipeline).not.toHaveBeenCalled();
    expect(gateway.updateCanvasExecutionPolicy).not.toHaveBeenCalled();
    expect(gateway.updateBlockPlanning).not.toHaveBeenCalled();
  });

  it("reports real review block refs for generated bulk review pipeline steps", async () => {
    const gateway = createGateway();
    gateway.bulkApplyReviewPipeline.mockResolvedValueOnce({
      ok: true,
      affectedTasks: ["T-001"],
      diagnostics: [],
      graph: {
        reviewBlocksByTask: new Map([["T-001", ["T-001#R-002"]]])
      } as GraphEditResult["graph"]
    });

    const result = await handlePlanweaveTool(
      "bulk_apply_review_pipeline",
      {
        projectId: "project-1",
        canvasId: "default",
        updates: [
          {
            taskId: "T-001",
            steps: [
              {
                title: "Generated review",
                enabled: true,
                preset: "manual",
                triggerCondition: "after_required_work_completed",
                inputContext: "Implementation report",
                passCriteria: "No blocking defects",
                feedbackFormat: "Actionable findings",
                maxFeedbackCycles: 1,
                hook: null,
                promptMarkdown: "# Generated review\n"
              }
            ]
          }
        ]
      },
      gateway
    );

    const body = readToolBody(result);
    expect(
      z.object(planweaveToolOutputSchemas.bulk_apply_review_pipeline).safeParse(body).success
    ).toBe(true);
    expect(body).not.toHaveProperty("graph");
    expect(body).not.toHaveProperty("promptMarkdown");
    expect(body).not.toHaveProperty("edit");
    expect(body).toMatchObject({
      bulkEdit: {
        affectedBlocks: ["T-001#R-002"],
        counts: { affectedBlockCount: 1 }
      }
    });
    const affectedBlocks = (body.bulkEdit as { affectedBlocks: string[] }).affectedBlocks;
    expect(affectedBlocks).not.toContain("T-001#");
    expect(affectedBlocks.every((ref) => !ref.endsWith("#"))).toBe(true);
  });

  it("rejects duplicate task ids in one bulk review pipeline request before dispatch", async () => {
    const gateway = createGateway();
    const update = {
      taskId: "T-001",
      steps: [
        {
          blockRef: "T-001#R-001",
          title: "Review feature",
          enabled: true,
          preset: "manual",
          triggerCondition: "after_required_work_completed",
          inputContext: "Implementation report",
          passCriteria: "No blocking defects",
          feedbackFormat: "Actionable findings",
          maxFeedbackCycles: 1,
          hook: null,
          promptMarkdown: "# Review\n"
        }
      ]
    };

    await expect(
      handlePlanweaveTool(
        "bulk_apply_review_pipeline",
        {
          projectId: "project-1",
          canvasId: "default",
          updates: [update, update]
        },
        gateway
      )
    ).rejects.toThrow("updates must not contain duplicate taskId: T-001");

    expect(gateway.bulkApplyReviewPipeline).not.toHaveBeenCalled();
  });

  it("does not dispatch bulk writes when validation fails before execution", async () => {
    const gateway = createGateway();

    await expect(
      handlePlanweaveTool(
        "bulk_update_parallel_policy",
        {
          projectId: "project-1",
          canvasId: "default",
          blocks: [{ blockRef: "T-001#B-001" }]
        },
        gateway
      )
    ).rejects.toThrow("At least one block planning field must be provided.");

    expect(gateway.bulkUpdateParallelPolicy).not.toHaveBeenCalled();
  });

  it("rejects invalid nested structured edit inputs before gateway dispatch", async () => {
    const gateway = createGateway();

    await expect(
      handlePlanweaveTool(
        "bulk_add_task_dependencies",
        { projectId: "project-1", canvasId: "default", edges: [] },
        gateway
      )
    ).rejects.toThrow("edges must contain at least one dependency.");

    await expect(
      handlePlanweaveTool(
        "bulk_set_task_dependencies",
        {
          projectId: "project-1",
          canvasId: "default",
          updates: [{ taskId: "T-001", dependsOn: "B-001" }]
        },
        gateway
      )
    ).rejects.toThrow();

    await expect(
      handlePlanweaveTool(
        "bulk_update_blocks",
        {
          projectId: "project-1",
          canvasId: "default",
          updates: [{ blockRef: "T-001#B-001", parallelSafe: true, sharedResources: ["api"] }]
        },
        gateway
      )
    ).rejects.toThrow("Unrecognized key");

    await expect(
      handlePlanweaveTool(
        "bulk_update_blocks",
        {
          projectId: "project-1",
          canvasId: "default",
          updates: [
            {
              blockRef: "T-001#B-001",
              reviewHook: {
                id: "hook-1",
                type: "shell",
                command: "echo",
                args: [],
                executionPolicy: "trusted-local"
              }
            }
          ]
        },
        gateway
      )
    ).rejects.toThrow();

    await expect(
      handlePlanweaveTool(
        "update_canvas_execution_policy",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    ).rejects.toThrow("At least one execution policy field must be provided.");

    await expect(
      handlePlanweaveTool(
        "bulk_remove_graph_items",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    ).rejects.toThrow("bulk_remove_graph_items requires at least one item to remove.");

    await expect(
      handlePlanweaveTool(
        "bulk_set_block_dependencies",
        {
          projectId: "project-1",
          canvasId: "default",
          updates: [{ dependsOn: [] }]
        },
        gateway
      )
    ).rejects.toThrow("blockRef is required unless taskId and blockId are provided.");

    expect(gateway.bulkAddTaskDependencies).not.toHaveBeenCalled();
    expect(gateway.bulkSetTaskDependencies).not.toHaveBeenCalled();
    expect(gateway.bulkUpdateBlocks).not.toHaveBeenCalled();
    expect(gateway.updateCanvasExecutionPolicy).not.toHaveBeenCalled();
    expect(gateway.bulkRemoveGraphItems).not.toHaveBeenCalled();
    expect(gateway.bulkSetBlockDependencies).not.toHaveBeenCalled();
  });

  it("applies canvas lane layout through the runtime gateway", async () => {
    const gateway = createGateway();

    const result = await handlePlanweaveTool(
      "apply_canvas_lane_layout",
      {
        projectId: "project-1",
        canvasId: "default",
        columnWidth: 400,
        rowHeight: 200,
        startX: 40,
        startY: 60
      },
      gateway
    );

    const body = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
    expect(
      z.object(planweaveToolOutputSchemas.apply_canvas_lane_layout).safeParse(body).success
    ).toBe(true);
    expect(body).toMatchObject({
      nodeCount: 1,
      bounds: { minX: 80, minY: 80, maxX: 80, maxY: 80, width: 0, height: 0 },
      summary: { nodeCount: 1 }
    });
    expect(body).not.toHaveProperty("layout");
    expect(gateway.applyCanvasLaneLayout).toHaveBeenCalledWith("project-1", "default", {
      columnWidth: 400,
      rowHeight: 200,
      startX: 40,
      startY: 60
    });
  });
});

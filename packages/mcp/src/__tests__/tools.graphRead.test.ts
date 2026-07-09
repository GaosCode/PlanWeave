import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createGateway, project, readJson } from "./toolTestHelpers.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { handlePlanweaveTool } from "../tools.js";

describe("MCP tools: graph read", () => {
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

  it("routes graph summary, task list, slice, quality, and readiness through runtime graph services", async () => {
    const gateway = createGateway();

    const summary = readJson(await handlePlanweaveTool("get_graph_summary", { projectId: "project-1", canvasId: "default", limit: 10 }, gateway));
    const tasks = readJson(await handlePlanweaveTool("list_tasks", { projectId: "project-1", canvasId: "default", cursor: "next:10" }, gateway));
    const slice = readJson(await handlePlanweaveTool("get_graph_slice", { projectId: "project-1", canvasId: "default", taskId: "T-001", limit: 5 }, gateway));
    const quality = readJson(
      await handlePlanweaveTool(
        "validate_graph_quality",
        { projectId: "project-1", canvasId: "default", reviewPolicy: "required", gatePolicy: "required", heuristics: "on", strict: true },
        gateway
      )
    );
    const readiness = readJson(await handlePlanweaveTool("validate_execution_readiness", { projectId: "project-1", canvasId: "default" }, gateway));

    expect(gateway.inspectGraph).toHaveBeenCalledWith("project-1", "default", { view: "summary", limit: 10, cursor: undefined });
    expect(gateway.inspectGraph).toHaveBeenCalledWith("project-1", "default", { view: "tasks", limit: undefined, cursor: "next:10" });
    expect(gateway.inspectGraph).toHaveBeenCalledWith("project-1", "default", { view: "slice", taskId: "T-001", limit: 5 });
    expect(gateway.validateGraphQuality).toHaveBeenCalledWith("project-1", "default", {
      reviewPolicy: "required",
      gatePolicy: "required",
      heuristics: "on",
      strict: true
    });
    expect(gateway.validateExecutionReadiness).toHaveBeenCalledWith("project-1", "default");
    expect(z.object(planweaveToolOutputSchemas.get_graph_summary).safeParse(summary).success).toBe(true);
    expect(z.object(planweaveToolOutputSchemas.list_tasks).safeParse(tasks).success).toBe(true);
    expect(z.object(planweaveToolOutputSchemas.get_graph_slice).safeParse(slice).success).toBe(true);
    expect(z.object(planweaveToolOutputSchemas.validate_graph_quality).safeParse(quality).success).toBe(true);
    expect(z.object(planweaveToolOutputSchemas.validate_execution_readiness).safeParse(readiness).success).toBe(true);
    expect(summary).toMatchObject({ graph: { view: "summary" } });
    expect(tasks).toMatchObject({ graph: { view: "tasks" } });
    expect(slice).toMatchObject({ graph: { view: "slice" } });
    expect(quality).toMatchObject({ graphQuality: { ok: true, summary: { score: 100 } } });
    expect(readiness).toMatchObject({ readiness: { ok: true, nextClaimable: ["T-001#I-001"] } });
  });

  it("rejects cursor pagination at the get_graph_slice tool boundary", async () => {
    await expect(
      handlePlanweaveTool("get_graph_slice", { projectId: "project-1", canvasId: "default", taskId: "T-001", limit: 5, cursor: "next:5" }, createGateway())
    ).rejects.toThrow("get_graph_slice does not support cursor pagination");
  });

  it("keeps get_block_detail legacy output and exposes bounded summary/full-debug tools", async () => {
    const gateway = createGateway();

    await expect(handlePlanweaveTool("get_task_detail", { projectId: "project-1", canvasId: "default", taskId: "T-001" }, gateway)).resolves.toMatchObject({
      structuredContent: {
        task: {
          taskId: "T-001"
        }
      }
    });
    const legacyBlock = readJson(
      await handlePlanweaveTool("get_block_detail", { projectId: "project-1", canvasId: "default", taskId: "T-001", blockId: "I-001" }, gateway)
    );
    const summaryBlock = readJson(
      await handlePlanweaveTool("get_block_summary", { projectId: "project-1", canvasId: "default", blockRef: "T-001#I-001" }, gateway)
    );
    const viewSummaryBlock = readJson(
      await handlePlanweaveTool("get_block_detail", { projectId: "project-1", canvasId: "default", blockRef: "T-001#I-001", view: "summary" }, gateway)
    );
    const debugBlock = readJson(
      await handlePlanweaveTool("get_block_detail_full_debug", { projectId: "project-1", canvasId: "default", blockRef: "T-001#I-001" }, gateway)
    );

    expect(legacyBlock).toMatchObject({
      block: {
        ref: "T-001#I-001",
        promptMarkdown: "# Block",
        promptSurfaceMarkdown: "# Surface"
      }
    });
    expect(summaryBlock).toMatchObject({
      block: {
        ref: "T-001#I-001",
        promptMarkdownAvailable: true,
        renderedPromptAvailable: true,
        promptSourceCount: 0
      }
    });
    expect(viewSummaryBlock).toEqual(summaryBlock);
    expect(JSON.stringify(summaryBlock)).not.toContain("promptSurfaceMarkdown");
    expect(JSON.stringify(summaryBlock)).not.toContain("# Surface");
    expect(JSON.stringify(summaryBlock)).not.toContain("# Block");
    expect(debugBlock).toMatchObject({
      block: {
        promptMarkdown: "# Block",
        promptSurfaceMarkdown: "# Surface"
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
});

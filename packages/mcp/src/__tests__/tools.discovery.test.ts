import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createGateway, project, readJson } from "./toolTestHelpers.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { handlePlanweaveTool } from "../tools.js";

describe("MCP discovery tools", () => {
  it("returns a PlanWeave guide with storage layout and tool navigation", async () => {
    const result = readJson(
      await handlePlanweaveTool("get_planweave_guide", undefined, createGateway())
    );

    expect(result).toMatchObject({
      guide: {
        summary: expect.stringContaining("MCP tools"),
        workspaceLayout: expect.arrayContaining([
          expect.stringContaining("default canvas"),
          expect.stringContaining("canvases/default/package"),
          expect.stringContaining("legacy default canvas data")
        ]),
        toolSelection: expect.arrayContaining([
          expect.objectContaining({
            need: expect.stringContaining("Find local projects"),
            tool: "list_projects_summary"
          }),
          expect.objectContaining({
            need: expect.stringContaining("Inspect one canvas DAG"),
            tool: "get_graph_summary or get_graph_slice"
          }),
          expect.objectContaining({
            need: expect.stringContaining("parallel execution"),
            tool: "update_canvas_execution_policy"
          }),
          expect.objectContaining({
            need: expect.stringContaining("locks"),
            tool: "update_block_planning"
          })
        ]),
        concepts: expect.arrayContaining([
          expect.objectContaining({
            name: "Parallel execution policy",
            description: expect.stringContaining("exclusive")
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
    const summary = readJson(
      await handlePlanweaveTool("list_projects_summary", undefined, createGateway())
    );

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
    expect(summary).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("/sensitive");
  });

  it("opens project summaries and lists canvases without task bodies", async () => {
    const gateway = createGateway();
    const opened = readJson(
      await handlePlanweaveTool("open_project_summary", { projectId: "project-1" }, gateway)
    );
    const canvases = readJson(
      await handlePlanweaveTool("list_canvases", { projectId: "project-1" }, gateway)
    );

    expect(gateway.openProject).toHaveBeenCalledWith("project-1");
    expect(
      z.object(planweaveToolOutputSchemas.open_project_summary).safeParse(opened).success
    ).toBe(true);
    expect(z.object(planweaveToolOutputSchemas.list_canvases).safeParse(canvases).success).toBe(
      true
    );
    expect(opened).toMatchObject({
      project: { projectId: "project-1", activeCanvasId: "default" }
    });
    expect(canvases).toMatchObject({ projectId: "project-1", canvases: [{ canvasId: "default" }] });
    expect(JSON.stringify(canvases)).not.toContain("promptMarkdown");
  });

  it("lists package example templates before returning selected file content", async () => {
    const list = readJson(
      await handlePlanweaveTool("get_plan_package_examples", undefined, createGateway())
    );
    const selected = readJson(
      await handlePlanweaveTool("get_plan_package_examples", { template: "basic" }, createGateway())
    );

    expect(
      z.object(planweaveToolOutputSchemas.get_plan_package_examples).safeParse(list).success
    ).toBe(true);
    expect(
      z.object(planweaveToolOutputSchemas.get_plan_package_examples).safeParse(selected).success
    ).toBe(true);
    expect(list).toMatchObject({
      examples: expect.arrayContaining([
        expect.objectContaining({ template: "basic" }),
        expect.objectContaining({ template: "large_dag_with_review_loop" })
      ]),
      notes: [expect.stringContaining("large_dag_with_review_loop")]
    });
    expect(list.files).toBeUndefined();
    expect(selected.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "manifest.json" })])
    );
    const large = readJson(
      await handlePlanweaveTool(
        "get_plan_package_examples",
        { template: "large_dag_with_review_loop" },
        createGateway()
      )
    );
    expect(
      z.object(planweaveToolOutputSchemas.get_plan_package_examples).safeParse(large).success
    ).toBe(true);
    expect(large).toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ path: "manifest.json" }),
        expect.objectContaining({ path: "nodes/T-006/blocks/R-001.prompt.md" })
      ]),
      notes: [expect.stringContaining("apply_canvas_lane_layout")]
    });
    await expect(
      handlePlanweaveTool("get_plan_package_examples", { template: "missing" }, createGateway())
    ).rejects.toThrow("Unknown package example template 'missing'");
  });
});

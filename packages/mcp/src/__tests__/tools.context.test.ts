import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createGateway, project, readJson } from "./toolTestHelpers.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { handlePlanweaveTool } from "../tools.js";

describe("MCP tools: project context", () => {
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
    expect(JSON.stringify(result)).toContain(
      "Use project.projectId and canvasId exactly as returned here"
    );
    expect(JSON.stringify(result)).not.toContain("/sensitive");
    expect(gateway.validateProject).toHaveBeenCalledWith("ecco-the-dolphin-f7761c39");
    expect(gateway.validateProject).toHaveBeenCalledWith("tidesinger-e7bb1716");
    expect(gateway.getProjectGraph).toHaveBeenCalledWith("ecco-the-dolphin-f7761c39", "default");
    expect(gateway.getProjectGraph).toHaveBeenCalledWith("tidesinger-e7bb1716", "default");
  });

  it("keeps other PlanWeave context visible when one context reader fails", async () => {
    const gateway = createGateway();
    gateway.getProjectGraph.mockRejectedValueOnce(
      new Error(
        "Could not read /sensitive/home/projects/project-1/canvases/default/package/manifest.json"
      )
    );

    const result = readJson(
      await handlePlanweaveTool("get_project_tree", { projectId: "project-1" }, gateway)
    );

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
    const result = readJson(
      await handlePlanweaveTool(
        "open_project",
        { projectId: "project-1", rootPath: "/ignored" },
        gateway
      )
    );

    expect(gateway.openProject).toHaveBeenCalledWith("project-1");
    expect(JSON.stringify(result)).not.toContain("/ignored");
    expect(JSON.stringify(result)).not.toContain("/sensitive");
  });

  it("keeps get_project_overview as an open_project compatibility alias", async () => {
    const gateway = createGateway();
    const result = readJson(
      await handlePlanweaveTool("get_project_overview", { projectId: "project-1" }, gateway)
    );

    expect(gateway.openProject).toHaveBeenCalledWith("project-1");
    expect(result).toMatchObject({ project: { projectId: "project-1" } });
  });

  it("validates projects by projectId only", async () => {
    const gateway = createGateway();
    const result = readJson(
      await handlePlanweaveTool("validate_project", { projectId: "project-1" }, gateway)
    );
    const outputSchema = z.object(planweaveToolOutputSchemas.validate_project);

    expect(gateway.validateProject).toHaveBeenCalledWith("project-1");
    expect(outputSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      ok: true,
      errors: [],
      warnings: [],
      summary: {
        errorCount: 0,
        warningCount: 0,
        groups: []
      }
    });
  });

  it("returns sanitized execution status by projectId and canvasId", async () => {
    const gateway = createGateway();
    const result = readJson(
      await handlePlanweaveTool(
        "get_status",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    );

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
    const result = readJson(
      await handlePlanweaveTool(
        "get_prompt",
        { projectId: "project-1", canvasId: "default", ref: "T-001#I-001" },
        gateway
      )
    );

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
    const result = readJson(
      await handlePlanweaveTool(
        "get_prompt",
        { projectId: "project-1", ref: "T-001#I-001" },
        gateway
      )
    );

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
          title:
            "Run log https://example.com/docs/path /api/status /Users/me/My Project/results/T-001/run.log",
          excerpt:
            "needle appears in /Users/me/My Project/canvases/default/package/nodes/T-001/prompt.md",
          match: {
            field: "body",
            start: 0,
            length: 6,
            excerpt:
              "needle appears in /Users/me/My Project/canvases/default/package/nodes/T-001/prompt.md",
            excerptStart: 0
          }
        }
      ],
      diagnostics: [
        {
          code: "search_manifest_read_failed",
          message:
            "Could not read /sensitive/home/projects/project-1/canvases/default/package/manifest.json",
          path: "/sensitive/home/projects/project-1/canvases/default/package/manifest.json"
        }
      ]
    });
    const result = readJson(
      await handlePlanweaveTool(
        "search_project",
        {
          projectId: "project-1",
          canvasId: "default",
          query: "  needle  ",
          kinds: ["prompt"],
          limit: 5
        },
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
          excerpt: "needle appears in canvases/default/package/nodes/T-001/prompt.md",
          match: {
            field: "body",
            start: 0,
            length: 6,
            excerpt: "needle appears in canvases/default/package/nodes/T-001/prompt.md",
            excerptStart: 0
          }
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
    expect(JSON.stringify(result)).not.toContain(
      "/sensitive/home/projects/project-1/canvases/default/package/manifest.json"
    );
    expect(JSON.stringify(result)).not.toContain(
      "/sensitive/home/projects/project-1/results/T-001/run.log"
    );
    expect(JSON.stringify(result)).not.toContain("/Users/me/My Project");
    expect(JSON.stringify(result)).toContain("https://example.com/docs/path");
    expect(JSON.stringify(result)).toContain("/api/status");
    expect(JSON.stringify(result)).toContain("search_manifest_read_failed");
  });

  it("rejects invalid search query, kinds, and limit", async () => {
    const gateway = createGateway();

    await expect(
      handlePlanweaveTool("search_project", { projectId: "project-1", query: " " }, gateway)
    ).rejects.toThrow("query is required");
    await expect(
      handlePlanweaveTool(
        "search_project",
        { projectId: "project-1", query: "needle", kinds: ["unknown"] },
        gateway
      )
    ).rejects.toThrow("kinds[0] must be one of");
    await expect(
      handlePlanweaveTool(
        "search_project",
        { projectId: "project-1", query: "needle", limit: 101 },
        gateway
      )
    ).rejects.toThrow("limit must be an integer from 1 to 100");
  });

  it("lists ready blocks from the selected ready queue", async () => {
    const gateway = createGateway();
    const result = readJson(
      await handlePlanweaveTool(
        "list_ready_blocks",
        { projectId: "project-1", canvasId: "default" },
        gateway
      )
    );

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
          dispatchable: true,
          sharedResources: ["repo"],
          reviewGate: null
        }
      ]
    });
  });

  it("rejects local path arguments for read-only context tools", async () => {
    const gateway = createGateway();

    await expect(
      handlePlanweaveTool("get_status", { projectId: "project-1", rootPath: "/ignored" }, gateway)
    ).rejects.toThrow("rootPath is not accepted");
    await expect(
      handlePlanweaveTool(
        "get_prompt",
        { projectId: "project-1", ref: "T-001#I-001", projectRoot: "/ignored" },
        gateway
      )
    ).rejects.toThrow("projectRoot is not accepted");
    await expect(
      handlePlanweaveTool(
        "list_ready_blocks",
        { projectId: "project-1", workspaceRoot: "/ignored" },
        gateway
      )
    ).rejects.toThrow("workspaceRoot is not accepted");
  });

  it("creates managed projects without accepting root paths", async () => {
    const gateway = createGateway();
    const result = readJson(
      await handlePlanweaveTool(
        "create_project",
        { name: "New Project", rootPath: "/ignored" },
        gateway
      )
    );

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

  it("keeps init_project as a compatibility alias for create_project", async () => {
    const gateway = createGateway();
    const result = readJson(
      await handlePlanweaveTool("init_project", { name: "New Project" }, gateway)
    );

    expect(gateway.initProject).toHaveBeenCalledWith("New Project");
    expect(result).toMatchObject({
      project: {
        projectId: "project-1",
        name: "Project One"
      }
    });
  });

  it("creates a new task canvas in a registered project", async () => {
    const gateway = createGateway();
    const result = readJson(
      await handlePlanweaveTool(
        "create_canvas",
        { projectId: "project-1", name: "Release plan", canvasId: "ignored" },
        gateway
      )
    );

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

  it("explains validation errors with repair suggestions", async () => {
    const gateway = createGateway();
    gateway.validateProject.mockResolvedValueOnce({
      ok: false,
      errors: [
        { code: "missing_prompt", message: "Prompt is missing.", path: "nodes/T-001/prompt.md" }
      ],
      warnings: [],
      summary: {
        errorCount: 1,
        warningCount: 0,
        groups: [
          {
            code: "missing_prompt",
            message: "Prompt is missing.",
            count: 1,
            examples: ["nodes/T-001/prompt.md"]
          }
        ]
      }
    });

    const result = readJson(
      await handlePlanweaveTool("explain_validation_errors", { projectId: "project-1" }, gateway)
    );

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
    await expect(
      handlePlanweaveTool("open_project", { rootPath: "/not-accepted" }, createGateway())
    ).rejects.toThrow("projectId is required");
  });
});

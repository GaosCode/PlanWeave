import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";
import { createGateway, project, readJson, schemaDocument, schemaDocuments } from "./toolTestHelpers.js";
import { planweaveToolDefinitions } from "../toolDefinitions.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { defaultPlanweaveToolNames, handlePlanweaveTool, planweaveToolNames } from "../tools.js";

describe("handlePlanweaveTool", () => {
  it("keeps compatibility aliases in the exported tool list", () => {
    expect(planweaveToolNames).toEqual(expect.arrayContaining([
      "get_project_overview",
      "preview_execution_graph",
      "write_task_prompt",
      "write_block_prompt"
    ]));
  });

  it("keeps MCP tool names, definitions, and output schemas in sync", () => {
    expect(Object.keys(planweaveToolDefinitions).sort()).toEqual([...planweaveToolNames].sort());
    expect(Object.keys(planweaveToolOutputSchemas).sort()).toEqual([...planweaveToolNames].sort());
  });

  it("returns Git/GitHub envelopes that match their output schemas and forwards merge method", async () => {
    const gateway = createGateway();
    const cases = [
      ["git_status", { projectId: "project-1" }],
      ["git_diff", { projectId: "project-1" }],
      ["git_log", { projectId: "project-1" }],
      ["git_commit", { projectId: "project-1", message: "test commit" }],
      ["github_create_pr", { projectId: "project-1", title: "PR", head: "feature", base: "main" }],
      ["github_list_prs", { projectId: "project-1" }],
      ["github_get_pr", { projectId: "project-1", prNumber: 1 }],
      ["github_merge_pr", { projectId: "project-1", prNumber: 1, method: "squash" }]
    ] as const;
    for (const [name, args] of cases) {
      const value = readJson(await handlePlanweaveTool(name, args, gateway));
      expect(z.object(planweaveToolOutputSchemas[name]).safeParse(value).success, name).toBe(true);
    }
    expect(gateway.githubMergePR).toHaveBeenCalledWith("project-1", 1, "squash");
  });

  it("lists default-discoverable tool groups separately from compat-only aliases", async () => {
    const result = readJson(await handlePlanweaveTool("list_tool_groups", undefined, createGateway()));
    const recommendedTools = result.groups.flatMap((group: { recommendedTools: string[] }) => group.recommendedTools);
    const defaultToolNames = new Set<string>(defaultPlanweaveToolNames);

    expect(result).toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({
          name: "graph_read",
          recommendedTools: expect.arrayContaining(["get_graph_summary", "get_graph_slice", "validate_graph_quality"])
        }),
        expect.objectContaining({
          name: "package_draft_import",
          recommendedTools: expect.arrayContaining(["validate_package_draft", "preview_package_import", "import_package_draft"])
        })
      ]),
      compatOnlyGroups: expect.arrayContaining([
        expect.objectContaining({
          name: "legacy_aliases",
          recommendedTools: expect.arrayContaining(["get_project_graph", "get_block_detail"])
        })
      ])
    });
    expect(result.groups.map((group: { name: string }) => group.name)).not.toContain("legacy_aliases");
    expect(recommendedTools).not.toEqual(expect.arrayContaining(["get_project_graph", "get_block_detail", "refresh_prompts", "export_plan_package"]));
    expect(recommendedTools.every((tool: string) => defaultToolNames.has(tool))).toBe(true);
    expect(defaultToolNames.has("create_project")).toBe(true);
    expect(defaultToolNames.has("init_project")).toBe(false);
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

  it("returns schema topic summaries by default without dumping full schema documents", async () => {
    const result = readJson(await handlePlanweaveTool("get_schema", undefined, createGateway()));

    expect(result).toMatchObject({
      topic: null,
      topics: expect.arrayContaining([
        expect.objectContaining({ name: "manifest", summary: schemaDocuments.manifest.summary }),
        expect.objectContaining({ name: "state", summary: schemaDocuments.state.summary }),
        expect.objectContaining({ name: "layout", summary: schemaDocuments.layout.summary })
      ]),
      documents: {}
    });
    expect(JSON.stringify(result)).not.toContain("\"schema\"");
  });

  it("returns state and layout schema documents by topic", async () => {
    await expect(readJson(await handlePlanweaveTool("get_schema", { topic: "state" }, createGateway()))).toEqual({
      topic: "state",
      documents: {
        state: schemaDocuments.state
      }
    });
    await expect(readJson(await handlePlanweaveTool("get_schema", { topic: "layout" }, createGateway()))).toEqual({
      topic: "layout",
      documents: {
        layout: schemaDocuments.layout
      }
    });
  });

  it("reports the complete runtime schema topic list for unknown topics", async () => {
    await expect(handlePlanweaveTool("get_schema", { topic: "unknown" }, createGateway())).rejects.toThrow(
      `topic must be one of: ${runtimeSchemaTopicOrder.join(", ")}.`
    );
  });

  it("uses runtime schema topics in MCP get_schema input and output schemas", () => {
    const inputSchema = z.object(planweaveToolDefinitions.get_schema.inputSchema ?? {});
    const outputSchema = z.object(planweaveToolOutputSchemas.get_schema);

    for (const topic of runtimeSchemaTopicOrder) {
      expect(inputSchema.safeParse({ topic }).success).toBe(true);
      expect(outputSchema.safeParse({ topic, documents: { [topic]: schemaDocuments[topic] } }).success).toBe(true);
    }
    expect(outputSchema.safeParse({ topic: null, topics: [], documents: {} }).success).toBe(true);
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
          excerpt: "needle appears in /Users/me/My Project/canvases/default/package/nodes/T-001/prompt.md",
          match: {
            field: "body",
            start: 0,
            length: 6,
            excerpt: "needle appears in /Users/me/My Project/canvases/default/package/nodes/T-001/prompt.md",
            excerptStart: 0
          }
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

  it("creates managed projects without accepting root paths", async () => {
    const gateway = createGateway();
    const result = readJson(await handlePlanweaveTool("create_project", { name: "New Project", rootPath: "/ignored" }, gateway));

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
    const result = readJson(await handlePlanweaveTool("init_project", { name: "New Project" }, gateway));

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
    await handlePlanweaveTool(
      "create_block",
      { projectId: "project-1", canvasId: "default", taskId: "T-001", type: "implementation", title: "Follow-up", promptMarkdown: "# Follow-up" },
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
    const blockSourcePrompt = readJson(await handlePlanweaveTool("read_prompt", { projectId: "project-1", target: "block", blockRef: "T-001#I-001" }, gateway));
    const blockPrompt = readJson(
      await handlePlanweaveTool("read_prompt", { projectId: "project-1", target: "block", blockRef: "T-001#I-001", rendered: true }, gateway)
    );

    await handlePlanweaveTool("update_task", { projectId: "project-1", taskId: "T-001", promptMarkdown: "# Changed" }, gateway);
    await handlePlanweaveTool("update_project_prompt", { projectId: "project-1", markdown: "# Project v2" }, gateway);

    expect(projectPrompt).toMatchObject({ target: "project", markdown: "# Project" });
    expect(blockSourcePrompt).toMatchObject({ target: "block", blockRef: "T-001#I-001", markdown: "# Block", rendered: false });
    expect(JSON.stringify(blockSourcePrompt)).not.toContain("# Surface");
    expect(blockPrompt).toMatchObject({ target: "block", blockRef: "T-001#I-001", markdown: "# Surface", rendered: true });
    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", undefined, "T-001", { promptMarkdown: "# Changed" });
    expect(gateway.updateProjectPrompt).toHaveBeenCalledWith("project-1", "# Project v2");
  });

  it("keeps prompt writing compatibility aliases wired to update tools", async () => {
    const gateway = createGateway();

    await handlePlanweaveTool("write_task_prompt", { projectId: "project-1", canvasId: "default", taskId: "T-001", markdown: "# Task v2" }, gateway);
    await handlePlanweaveTool("write_block_prompt", { projectId: "project-1", canvasId: "default", blockRef: "T-001#I-001", markdown: "# Block v2" }, gateway);
    await handlePlanweaveTool("write_prompt_source", { projectId: "project-1", canvasId: "default", target: "task", taskId: "T-001", markdown: "# Task v3" }, gateway);
    await handlePlanweaveTool("write_prompt_source", { projectId: "project-1", target: "project", markdown: "# Project v3" }, gateway);

    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", "default", "T-001", { promptMarkdown: "# Task v2" });
    expect(gateway.updateTask).toHaveBeenCalledWith("project-1", "default", "T-001", { promptMarkdown: "# Task v3" });
    expect(gateway.updateBlock).toHaveBeenCalledWith("project-1", "default", "T-001#I-001", { promptMarkdown: "# Block v2" });
    expect(gateway.updateProjectPrompt).toHaveBeenCalledWith("project-1", "# Project v3");
  });

  it("explains validation errors with repair suggestions", async () => {
    const gateway = createGateway();
    gateway.validateProject.mockResolvedValueOnce({
      ok: false,
      errors: [{ code: "missing_prompt", message: "Prompt is missing.", path: "nodes/T-001/prompt.md" }],
      warnings: [],
      summary: {
        errorCount: 1,
        warningCount: 0,
        groups: [{ code: "missing_prompt", message: "Prompt is missing.", count: 1, examples: ["nodes/T-001/prompt.md"] }]
      }
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

import { describe, expect, it } from "vitest";
import { createGateway, readJson } from "./toolTestHelpers.js";
import { planweaveToolDefinitions } from "../toolDefinitions.js";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import { defaultPlanweaveToolNames, handlePlanweaveTool, planweaveToolNames } from "../tools.js";

describe("MCP tools: meta and aliases", () => {
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
});

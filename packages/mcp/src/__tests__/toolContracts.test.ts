import { describe, expect, it } from "vitest";
import { defaultPlanweaveToolNames, planweaveToolNames } from "../tools.js";
import { planweaveToolDefinitionRegistries, planweaveToolDefinitions } from "../toolDefinitions.js";
import { buildToolContractRegistry } from "../toolContracts/registry.js";
import type { ToolDefinition } from "../toolContracts/types.js";
import { planweaveToolOutputSchemaRegistries, planweaveToolOutputSchemas } from "../toolSchemas.js";

function countRegisteredNames(registries: readonly Readonly<Record<string, unknown>>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const registry of registries) {
    for (const name of Object.keys(registry)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

describe("MCP tool contracts", () => {
  it("registers every tool definition exactly once", () => {
    const counts = countRegisteredNames(planweaveToolDefinitionRegistries);

    expect([...counts.keys()].sort()).toEqual([...planweaveToolNames].sort());
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([]);
    expect(Object.keys(planweaveToolDefinitions).sort()).toEqual([...planweaveToolNames].sort());
  });

  it("registers every output schema exactly once", () => {
    const counts = countRegisteredNames(planweaveToolOutputSchemaRegistries);

    expect([...counts.keys()].sort()).toEqual([...planweaveToolNames].sort());
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([]);
    expect(Object.keys(planweaveToolOutputSchemas).sort()).toEqual([...planweaveToolNames].sort());
  });

  it("keeps default discovery tools covered by output schemas", () => {
    expect(defaultPlanweaveToolNames.every((name) => Boolean(planweaveToolOutputSchemas[name]))).toBe(true);
  });

  it("rejects duplicate contract names", () => {
    const definition = planweaveToolDefinitions.get_schema;

    expect(() =>
      buildToolContractRegistry<ToolDefinition>(
        [
          { get_schema: definition },
          { get_schema: definition }
        ],
        ["get_schema"],
        "PlanWeave tool definition"
      )
    ).toThrow("Duplicate PlanWeave tool definition(s): get_schema");
  });

  it("rejects unknown contract names", () => {
    const definition = planweaveToolDefinitions.get_schema;

    expect(() =>
      buildToolContractRegistry<ToolDefinition>(
        [{ unknown_tool: definition }],
        ["get_schema"],
        "PlanWeave tool definition"
      )
    ).toThrow("Unexpected PlanWeave tool definition(s): unknown_tool");
  });

  it("rejects missing contract names", () => {
    expect(() => buildToolContractRegistry<ToolDefinition>([], ["get_schema"], "PlanWeave tool definition")).toThrow(
      "Missing PlanWeave tool definition(s): get_schema"
    );
  });
});

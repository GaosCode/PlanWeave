import { DEFAULT_MAX_BYTES, MAX_CONTENT_BYTES } from "@planweave-ai/runtime/content-read-policy";
import { createGateway } from "./toolTestHelpers.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  compatPlanweaveToolNames,
  debugPlanweaveToolNames,
  defaultPlanweaveToolNames,
  planweaveToolNames,
  type PlanweaveToolName
} from "../tools.js";
import { planweaveToolDefinitionRegistries, planweaveToolDefinitions } from "../toolDefinitions.js";
import { buildToolContractRegistry } from "../toolContracts/registry.js";
import type { ToolDefinition } from "../toolContracts/types.js";
import {
  createTaskToolInputSchema,
  updateBlockToolInputSchema,
  updateReviewPipelineToolInputSchema,
  updateTaskToolInputSchema
} from "../toolInputSchemas.js";
import {
  createBlockToolInputSchema,
  updateBlockPlanningToolInputSchema,
  updateCanvasExecutionPolicyToolInputSchema
} from "../toolStructuredEditSchemas.js";
import { planweaveToolHandlerRegistries, planweaveToolHandlers } from "../toolDispatcher.js";
import { planweaveToolOutputSchemaRegistries, planweaveToolOutputSchemas } from "../toolSchemas.js";

function countRegisteredNames(
  registries: readonly Readonly<Record<string, unknown>>[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const registry of registries) {
    for (const name of Object.keys(registry)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

function registryOwners(
  registries: readonly Readonly<Record<string, unknown>>[]
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  registries.forEach((registry, index) => {
    for (const name of Object.keys(registry)) {
      owners.set(name, [...(owners.get(name) ?? []), `registry[${index}]`]);
    }
  });
  return owners;
}

function missingNames(expected: readonly string[], actual: ReadonlySet<string>): string[] {
  return expected.filter((name) => !actual.has(name));
}

function unexpectedNames(actual: Iterable<string>, expected: ReadonlySet<string>): string[] {
  return [...actual].filter((name) => !expected.has(name)).sort();
}

function duplicateNames(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .filter(([, count]) => count !== 1)
    .map(([name, count]) => `${name} (${count})`)
    .sort();
}

const parserBackedInputSchemas = {
  create_task: { parser: "parseCreateTaskToolArgs", schema: createTaskToolInputSchema },
  update_task: { parser: "parseUpdateTaskToolArgs", schema: updateTaskToolInputSchema },
  update_block: { parser: "parseUpdateBlockToolArgs", schema: updateBlockToolInputSchema },
  update_review_pipeline: {
    parser: "parseUpdateReviewPipelineToolArgs",
    schema: updateReviewPipelineToolInputSchema
  },
  set_review_pipeline: {
    parser: "parseUpdateReviewPipelineToolArgs",
    schema: updateReviewPipelineToolInputSchema
  },
  create_block: { parser: "parseCreateBlockInput", schema: createBlockToolInputSchema },
  update_canvas_execution_policy: {
    parser: "parseCanvasExecutionPolicyInput",
    schema: updateCanvasExecutionPolicyToolInputSchema
  },
  update_block_planning: {
    parser: "parseBlockPlanningInput",
    schema: updateBlockPlanningToolInputSchema
  }
} satisfies Partial<
  Record<PlanweaveToolName, { parser: string; schema: ToolDefinition["inputSchema"] }>
>;

describe("MCP tool contracts", () => {
  it("keeps a complete matrix for every public tool contract", () => {
    const allTools = new Set<PlanweaveToolName>(planweaveToolNames);
    const defaultTools = new Set<PlanweaveToolName>(defaultPlanweaveToolNames);
    const compatTools = new Set<PlanweaveToolName>(compatPlanweaveToolNames);
    const debugTools = new Set<PlanweaveToolName>(debugPlanweaveToolNames);
    const definitionCounts = countRegisteredNames(planweaveToolDefinitionRegistries);
    const outputSchemaCounts = countRegisteredNames(planweaveToolOutputSchemaRegistries);
    const handlerCounts = countRegisteredNames(planweaveToolHandlerRegistries);
    const definitionOwners = registryOwners(planweaveToolDefinitionRegistries);
    const outputSchemaOwners = registryOwners(planweaveToolOutputSchemaRegistries);
    const handlerOwners = registryOwners(planweaveToolHandlerRegistries);

    const matrix = planweaveToolNames.map((name) => {
      const definition = planweaveToolDefinitions[name];
      const outputSchema = planweaveToolOutputSchemas[name];
      const handler = planweaveToolHandlers[name];
      const parserBackedInputSchema = parserBackedInputSchemas[name];
      const discovery = compatTools.has(name) ? "compat" : "default";
      return {
        name,
        definition,
        outputSchema,
        handler,
        discovery,
        debugHeavy: debugTools.has(name),
        definitionOwners: definitionOwners.get(name) ?? [],
        outputSchemaOwners: outputSchemaOwners.get(name) ?? [],
        handlerOwners: handlerOwners.get(name) ?? [],
        parserBackedInputSchema
      };
    });

    const failures: string[] = [];
    const definitionNames = new Set(Object.keys(planweaveToolDefinitions));
    const outputSchemaNames = new Set(Object.keys(planweaveToolOutputSchemas));
    const handlerNames = new Set(Object.keys(planweaveToolHandlers));

    for (const [label, names] of [
      ["tool definition", definitionNames],
      ["tool output schema", outputSchemaNames],
      ["tool handler", handlerNames]
    ] as const) {
      const missing = missingNames(planweaveToolNames, names);
      const unexpected = unexpectedNames(names, allTools);
      if (missing.length > 0) {
        failures.push(`Missing ${label}(s): ${missing.join(", ")}`);
      }
      if (unexpected.length > 0) {
        failures.push(`Unexpected ${label}(s): ${unexpected.join(", ")}`);
      }
    }

    for (const [label, counts] of [
      ["tool definition registry", definitionCounts],
      ["tool output schema registry", outputSchemaCounts],
      ["tool handler registry", handlerCounts]
    ] as const) {
      const duplicates = duplicateNames(counts);
      if (duplicates.length > 0) {
        failures.push(`Duplicate ${label} entries: ${duplicates.join(", ")}`);
      }
    }

    const unexpectedDefaultTools = unexpectedNames(defaultTools, allTools);
    const unexpectedCompatTools = unexpectedNames(compatTools, allTools);
    const unexpectedDebugTools = unexpectedNames(debugTools, allTools);
    if (unexpectedDefaultTools.length > 0) {
      failures.push(`Unexpected default-discovery tool(s): ${unexpectedDefaultTools.join(", ")}`);
    }
    if (unexpectedCompatTools.length > 0) {
      failures.push(`Unexpected compat-discovery tool(s): ${unexpectedCompatTools.join(", ")}`);
    }
    if (unexpectedDebugTools.length > 0) {
      failures.push(`Unexpected debug/heavy tool(s): ${unexpectedDebugTools.join(", ")}`);
    }

    const duplicateDiscoveryTools = [...defaultTools]
      .filter((name) => compatTools.has(name))
      .sort();
    if (duplicateDiscoveryTools.length > 0) {
      failures.push(
        `Tools cannot be both default and compat discovery: ${duplicateDiscoveryTools.join(", ")}`
      );
    }

    const missingDiscoveryTools = planweaveToolNames.filter(
      (name) => !defaultTools.has(name) && !compatTools.has(name)
    );
    if (missingDiscoveryTools.length > 0) {
      failures.push(
        `Tools missing default/compat discovery classification: ${missingDiscoveryTools.join(", ")}`
      );
    }

    const debugOutsideCompat = [...debugTools].filter((name) => !compatTools.has(name)).sort();
    if (debugOutsideCompat.length > 0) {
      failures.push(
        `Debug/heavy tools must be compat-discovery only: ${debugOutsideCompat.join(", ")}`
      );
    }

    for (const row of matrix) {
      if (!row.definition) {
        failures.push(`${row.name}: missing tool definition`);
        continue;
      }
      if (row.definitionOwners.length !== 1) {
        failures.push(
          `${row.name}: expected exactly one definition owner, found ${row.definitionOwners.join(", ") || "none"}`
        );
      }
      if (!row.outputSchema) {
        failures.push(`${row.name}: missing output schema`);
      }
      if (row.outputSchemaOwners.length !== 1) {
        failures.push(
          `${row.name}: expected exactly one output schema owner, found ${row.outputSchemaOwners.join(", ") || "none"}`
        );
      }
      if (!row.handler) {
        failures.push(`${row.name}: missing handler`);
      }
      if (row.handlerOwners.length !== 1) {
        failures.push(
          `${row.name}: expected exactly one handler owner, found ${row.handlerOwners.join(", ") || "none"}`
        );
      }
      if (!row.definition.title.trim()) {
        failures.push(`${row.name}: definition title must be non-empty`);
      }
      if (!row.definition.description.trim()) {
        failures.push(`${row.name}: definition description must be non-empty`);
      }
      if (!row.definition.annotations) {
        failures.push(`${row.name}: definition annotations must be present`);
      }
      if (
        row.parserBackedInputSchema &&
        row.definition.inputSchema !== row.parserBackedInputSchema.schema
      ) {
        failures.push(
          `${row.name}: definition inputSchema must use ${row.parserBackedInputSchema.parser} canonical input schema`
        );
      }
      if (row.debugHeavy && row.discovery !== "compat") {
        failures.push(`${row.name}: debug/heavy tool must not be default-discoverable`);
      }
      if (row.debugHeavy && !row.definition.description.includes("heavy/debug")) {
        failures.push(`${row.name}: debug/heavy definition description must include 'heavy/debug'`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("registers every tool definition exactly once", () => {
    const counts = countRegisteredNames(planweaveToolDefinitionRegistries);

    expect([...counts.keys()].sort()).toEqual([...planweaveToolNames].sort());
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([]);
    expect(Object.keys(planweaveToolDefinitions).sort()).toEqual([...planweaveToolNames].sort());
  });

  it("preserves canonical parser schema types through the aggregate registry", () => {
    expectTypeOf(planweaveToolDefinitions.update_review_pipeline.inputSchema).toEqualTypeOf<
      typeof updateReviewPipelineToolInputSchema
    >();
    expectTypeOf(planweaveToolDefinitions.set_review_pipeline.inputSchema).toEqualTypeOf<
      typeof updateReviewPipelineToolInputSchema
    >();
    expectTypeOf(planweaveToolDefinitions.update_task.inputSchema).toEqualTypeOf<
      typeof updateTaskToolInputSchema
    >();
  });

  it("registers every output schema exactly once", () => {
    const counts = countRegisteredNames(planweaveToolOutputSchemaRegistries);

    expect([...counts.keys()].sort()).toEqual([...planweaveToolNames].sort());
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([]);
    expect(Object.keys(planweaveToolOutputSchemas).sort()).toEqual([...planweaveToolNames].sort());
  });

  it("keeps default discovery tools covered by output schemas", () => {
    expect(
      defaultPlanweaveToolNames.every((name) => Boolean(planweaveToolOutputSchemas[name]))
    ).toBe(true);
  });

  it("rejects duplicate contract names", () => {
    const definition = planweaveToolDefinitions.get_schema;

    expect(() =>
      buildToolContractRegistry<ToolDefinition>(
        [{ get_schema: definition }, { get_schema: definition }],
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
    expect(() =>
      buildToolContractRegistry<ToolDefinition>([], ["get_schema"], "PlanWeave tool definition")
    ).toThrow("Missing PlanWeave tool definition(s): get_schema");
  });
});

describe("content byte budget contracts", () => {
  const cases = [
    ["read_package_file", { projectId: "project-1", path: "manifest.json" }],
    ["read_prompt_source", { projectId: "project-1", target: "project" }],
    ["get_rendered_prompt", { projectId: "project-1", ref: "T-001#B-001" }]
  ] as const;
  it.each(cases)("aligns schema and handler limits for %s", async (name, args) => {
    const schema = planweaveToolDefinitions[name].inputSchema;
    const gateway = createGateway();
    for (const maxBytes of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      MAX_CONTENT_BYTES + 1,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      "100"
    ]) {
      expect(schema.safeParse({ ...args, maxBytes }).success).toBe(false);
      await expect(
        planweaveToolHandlers[name]({ ...args, maxBytes }, gateway)
      ).rejects.toMatchObject({ code: "content_max_bytes_invalid" });
    }
    for (const maxBytes of [1, MAX_CONTENT_BYTES]) {
      expect(schema.safeParse({ ...args, maxBytes }).success).toBe(true);
      await planweaveToolHandlers[name]({ ...args, maxBytes }, gateway);
    }
    expect(schema.safeParse(args).success).toBe(true);
    await planweaveToolHandlers[name](args, gateway);
    const call =
      name === "read_package_file"
        ? gateway.readPackageFile.mock.lastCall
        : name === "get_rendered_prompt"
          ? gateway.readRenderedPrompt.mock.lastCall
          : gateway.readPromptSource.mock.lastCall;
    expect(call?.at(-1)).toEqual(
      name === "read_prompt_source"
        ? expect.objectContaining({ maxBytes: DEFAULT_MAX_BYTES })
        : DEFAULT_MAX_BYTES
    );
  });
});

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createGateway, readJson } from "./toolTestHelpers.js";
import {
  buildPlanweaveToolHandlerRegistry,
  planweaveToolHandlerRegistries,
  planweaveToolHandlers,
  type PlanweaveToolHandler
} from "../toolDispatcher.js";
import { jsonToolResult } from "../toolHelpers.js";
import { handlePlanweaveTool, planweaveToolNames } from "../tools.js";

const noopHandler: PlanweaveToolHandler = async (): Promise<CallToolResult> =>
  jsonToolResult({ ok: true });

describe("tool dispatcher", () => {
  it("registers every PlanWeave tool exactly once", () => {
    const counts = new Map<string, number>();
    for (const registry of planweaveToolHandlerRegistries) {
      for (const name of Object.keys(registry)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }

    expect([...counts.keys()].sort()).toEqual([...planweaveToolNames].sort());
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([]);
  });

  it("does not register handlers outside PlanweaveToolName", () => {
    const allowed = new Set<string>(planweaveToolNames);
    const registeredNames = planweaveToolHandlerRegistries.flatMap((registry) =>
      Object.keys(registry)
    );

    expect(registeredNames.every((name) => allowed.has(name))).toBe(true);
  });

  it("rejects duplicate handler names", () => {
    expect(() =>
      buildPlanweaveToolHandlerRegistry([{ get_schema: noopHandler }, { get_schema: noopHandler }])
    ).toThrow("Duplicate PlanWeave tool handler(s): get_schema");
  });

  it("rejects handlers outside PlanweaveToolName", () => {
    expect(() => buildPlanweaveToolHandlerRegistry([{ unknown_tool: noopHandler }])).toThrow(
      "Unexpected PlanWeave tool handler(s): unknown_tool"
    );
  });

  it("rejects incomplete handler registries", () => {
    expect(() => buildPlanweaveToolHandlerRegistry([])).toThrow(
      "Missing PlanWeave tool handler(s):"
    );
  });

  it("handlePlanweaveTool delegates to the registered handler", async () => {
    const gateway = createGateway();
    const original = planweaveToolHandlers.get_planweave_guide;
    let delegatedArgs: unknown;
    let delegatedGateway: unknown;
    planweaveToolHandlers.get_planweave_guide = async (args, receivedGateway) => {
      delegatedArgs = args;
      delegatedGateway = receivedGateway;
      return jsonToolResult({ delegated: true });
    };

    try {
      const result = await handlePlanweaveTool("get_planweave_guide", { trace: true }, gateway);

      expect(readJson(result)).toEqual({ delegated: true });
      expect(delegatedArgs).toEqual({ trace: true });
      expect(delegatedGateway).toBe(gateway);
    } finally {
      planweaveToolHandlers.get_planweave_guide = original;
    }
  });
});

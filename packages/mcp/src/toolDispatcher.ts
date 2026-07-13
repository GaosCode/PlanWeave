import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authoringToolHandlers } from "./toolHandlers/authoringTools.js";
import { contentToolHandlers } from "./toolHandlers/contentTools.js";
import { exportToolHandlers } from "./toolHandlers/exportTools.js";
import { githubToolHandlers } from "./toolHandlers/githubTools.js";
import { graphEditToolHandlers } from "./toolHandlers/graphEditTools.js";
import { graphReadToolHandlers } from "./toolHandlers/graphReadTools.js";
import { packageImportToolHandlers } from "./toolHandlers/packageImportTools.js";
import { projectReadToolHandlers } from "./toolHandlers/projectReadTools.js";
import { runtimeGateway } from "./toolRuntime.js";
import { planweaveToolNames, type PlanweaveToolName, type RuntimeGateway } from "./toolTypes.js";

export type PlanweaveToolHandler = (args: unknown, gateway: RuntimeGateway) => Promise<CallToolResult>;

export type PlanweaveToolHandlerRegistry = Record<PlanweaveToolName, PlanweaveToolHandler>;

export type PlanweavePartialToolHandlerRegistry = Partial<Record<PlanweaveToolName, PlanweaveToolHandler>>;

export const planweaveToolHandlerRegistries = [
  authoringToolHandlers,
  projectReadToolHandlers,
  graphReadToolHandlers,
  graphEditToolHandlers,
  contentToolHandlers,
  exportToolHandlers,
  packageImportToolHandlers,
  githubToolHandlers
] as const;

export const planweaveToolHandlers = buildPlanweaveToolHandlerRegistry(planweaveToolHandlerRegistries);

export function buildPlanweaveToolHandlerRegistry(
  registries: readonly Readonly<Record<string, PlanweaveToolHandler | undefined>>[]
): PlanweaveToolHandlerRegistry {
  const allowedNames = new Set<string>(planweaveToolNames);
  const handlers: Partial<Record<PlanweaveToolName, PlanweaveToolHandler>> = {};
  const duplicates: string[] = [];
  const unexpected: string[] = [];

  for (const registry of registries) {
    for (const [name, handler] of Object.entries(registry)) {
      if (!handler) {
        continue;
      }
      if (!allowedNames.has(name)) {
        unexpected.push(name);
        continue;
      }
      const toolName = name as PlanweaveToolName;
      if (handlers[toolName]) {
        duplicates.push(name);
        continue;
      }
      handlers[toolName] = handler;
    }
  }

  if (unexpected.length > 0) {
    throw new Error(`Unexpected PlanWeave tool handler(s): ${unexpected.join(", ")}`);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate PlanWeave tool handler(s): ${duplicates.join(", ")}`);
  }

  const missing = planweaveToolNames.filter((name) => !handlers[name]);
  if (missing.length > 0) {
    throw new Error(`Missing PlanWeave tool handler(s): ${missing.join(", ")}`);
  }

  return handlers as PlanweaveToolHandlerRegistry;
}

export async function dispatchPlanweaveTool(
  name: PlanweaveToolName,
  args: unknown,
  gateway: RuntimeGateway = runtimeGateway
): Promise<CallToolResult> {
  return planweaveToolHandlers[name](args, gateway);
}

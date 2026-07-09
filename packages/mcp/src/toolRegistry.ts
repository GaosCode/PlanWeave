import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { planweaveToolDefinitions } from "./toolDefinitions.js";
import { planweaveToolOutputSchemas } from "./toolSchemas.js";
import {
  defaultPlanweaveToolNames,
  handlePlanweaveTool,
  planweaveToolNames,
  type PlanweaveToolName
} from "./tools.js";

export type PlanweaveToolDiscoveryMode = "default" | "compat";

function toolNamesForDiscoveryMode(mode: PlanweaveToolDiscoveryMode): readonly PlanweaveToolName[] {
  return mode === "compat" ? planweaveToolNames : defaultPlanweaveToolNames;
}

export function registerPlanweaveTools(
  server: McpServer,
  options: { discoveryMode?: PlanweaveToolDiscoveryMode } = {}
): void {
  for (const name of toolNamesForDiscoveryMode(options.discoveryMode ?? "default")) {
    const definition = planweaveToolDefinitions[name];
    server.registerTool(
      name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: planweaveToolOutputSchemas[name],
        annotations: definition.annotations
      },
      async (args) => handlePlanweaveTool(name, args)
    );
  }
}

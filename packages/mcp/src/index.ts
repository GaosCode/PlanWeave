#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readMcpConfig } from "./config.js";
import { listenPlanweaveMcpServer } from "./server.js";

export { readMcpConfig, type McpConfig, type McpOAuthConfig } from "./config.js";
export { createHealthPayload, type HealthPayload } from "./health.js";
export { createPlanweaveMcpHttpServer, listenPlanweaveMcpServer } from "./server.js";
export { handlePlanweaveTool, isPlanweaveToolName, planweaveToolNames, type PlanweaveToolName, type RuntimeGateway } from "./tools.js";

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
}

if (isCliEntrypoint()) {
  try {
    const config = readMcpConfig();
    await listenPlanweaveMcpServer(config);
    console.log(`PlanWeave MCP server listening on http://${config.host}:${config.port}/mcp`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

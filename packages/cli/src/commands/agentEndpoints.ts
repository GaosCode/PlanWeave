import type { Command } from "commander";
import { resolveCliCanvasId, resolveCliPackageWorkspace } from "../cliWorkspace.js";
import {
  CliWorkspaceConnectionProvider,
  ProcessMemoryWorkspaceCredentialProvider
} from "../workspaceExecution/connection.js";
import { createCliWorkspaceExecutionHttpPorts } from "../workspaceExecution/httpPorts.js";
import { createWorkspaceJsonTransport } from "../workspaceExecution/httpTransport.js";

export function registerAgentEndpointsCommand(program: Command): void {
  const endpoints = program
    .command("agent-endpoints")
    .description("Inspect Remote Agent endpoints for a preconfigured Workspace connection");
  endpoints
    .command("list")
    .option("--canvas <canvasId>", "select a task canvas")
    .option("--connection-profile <profileId>", "select a preconfigured Workspace connection")
    .option("--json", "print JSON output")
    .action(async (options: { canvas?: string; connectionProfile?: string; json?: boolean }) => {
      const workspace = await resolveCliPackageWorkspace(options);
      const connection = await new CliWorkspaceConnectionProvider().resolve(
        options.connectionProfile
      );
      const credential = new ProcessMemoryWorkspaceCredentialProvider().get();
      const ports = createCliWorkspaceExecutionHttpPorts({
        connection,
        packageWorkspace: typeof workspace === "string" ? workspace : workspace.packageDir,
        transport: createWorkspaceJsonTransport({
          serverOrigin: connection.serverOrigin,
          credential
        })
      });
      const result = await ports.listAgentEndpoints(resolveCliCanvasId(options) ?? "default");
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.items.length === 0) {
        console.log("No Remote Agent endpoints.");
        return;
      }
      for (const endpoint of result.items) {
        const suffix = endpoint.status === "available" ? "" : ` (${endpoint.unavailableReason})`;
        console.log(
          `${endpoint.endpointId}\t${endpoint.profileId}\t${endpoint.agentId}\t${endpoint.status}${suffix}`
        );
      }
    });
}

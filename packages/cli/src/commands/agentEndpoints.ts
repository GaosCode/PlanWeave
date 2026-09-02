import type { Command } from "commander";
import { loadPlanGraphPackage } from "@planweave-ai/runtime";
import { resolveCliCanvasId, resolveCliPackageWorkspace } from "../cliWorkspace.js";
import {
  CliWorkspaceConnectionProvider,
  ProcessMemoryWorkspaceCredentialProvider
} from "../workspaceExecution/connection.js";
import { resolveCliRemoteCanvasId } from "../workspaceExecution/canvasBinding.js";
import { createCliWorkspaceExecutionHttpPorts } from "../workspaceExecution/httpPorts.js";
import { createWorkspaceJsonTransport } from "../workspaceExecution/httpTransport.js";
import {
  CliOwnerConnectionProvider,
  ProcessMemoryOwnerCredentialProvider
} from "../workspaceExecution/ownerConnection.js";
import { createCliOwnerCanvasExecutionHttpPorts } from "../workspaceExecution/ownerHttpPorts.js";
import { parseCliExecutionAuthority } from "../workspaceExecution/preflight.js";

export function registerAgentEndpointsCommand(program: Command): void {
  const endpoints = program
    .command("agent-endpoints")
    .description("Inspect Remote Agent endpoints for a preconfigured Workspace connection");
  endpoints
    .command("list")
    .option("--canvas <canvasId>", "select a task canvas")
    .option("--connection-profile <profileId>", "select a preconfigured Workspace connection")
    .option(
      "--authority <kind>",
      "remote authority: owner_canvas or workspace_canvas (default workspace_canvas)"
    )
    .option("--json", "print JSON output")
    .action(
      async (options: {
        canvas?: string;
        connectionProfile?: string;
        authority?: string;
        json?: boolean;
      }) => {
        const packageWorkspace = await resolveCliPackageWorkspace(options);
        const authority = parseCliExecutionAuthority(options.authority);
        if (authority === "owner_canvas") {
          const credentials = new ProcessMemoryOwnerCredentialProvider().get();
          const connection = await new CliOwnerConnectionProvider().resolve(
            options.connectionProfile
          );
          const canvasId = resolveCliCanvasId(options) ?? "default";
          const loaded = await loadPlanGraphPackage(packageWorkspace);
          const transport = createWorkspaceJsonTransport({
            serverOrigin: connection.serverOrigin,
            credential: credentials.operatorToken,
            identityCredential: credentials.humanIdentityToken
          });
          const ports = createCliOwnerCanvasExecutionHttpPorts({ transport, credentials });
          const result = await ports.listAgentEndpoints({
            projectId: loaded.workspace.id,
            canvasId
          });
          printAgentEndpoints(result, options.json === true);
          return;
        }
        const connection = await new CliWorkspaceConnectionProvider().resolve(
          options.connectionProfile
        );
        const credential = new ProcessMemoryWorkspaceCredentialProvider().get();
        const transport = createWorkspaceJsonTransport({
          serverOrigin: connection.serverOrigin,
          credential
        });
        const canvasId = await resolveCliRemoteCanvasId({
          packageWorkspace,
          localCanvasId: resolveCliCanvasId(options) ?? "default",
          connection,
          transport
        });
        const ports = createCliWorkspaceExecutionHttpPorts({ connection, transport });
        printAgentEndpoints(await ports.listAgentEndpoints(canvasId), options.json === true);
      }
    );
}

function printAgentEndpoints(
  result: {
    items: Array<{
      endpointId: string;
      profileId: string;
      agentId: string;
      status: string;
      unavailableReason?: string;
    }>;
  },
  asJson: boolean
): void {
  if (asJson) {
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
}

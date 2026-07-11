import type { PackageWorkspaceRef } from "../types.js";
import {
  isCommandTrusted,
  untrustedExecutorCommandError
} from "../taskManager/hookTrustStore.js";
import type { AcpLaunchMetadata, AgentDefinition } from "./agentRunner.js";

export function requireAcpLaunch(definition: AgentDefinition): AcpLaunchMetadata {
  const launch = definition.acp.launch;
  if (!launch) {
    throw new Error(`ACP launch metadata for agent '${definition.agent}' is unavailable.`);
  }
  return launch;
}

export async function assertAcpLaunchTrusted(options: {
  projectRoot: PackageWorkspaceRef;
  executorName: string;
  definition: AgentDefinition;
}): Promise<AcpLaunchMetadata> {
  const launch = requireAcpLaunch(options.definition);
  if (!(await isCommandTrusted(options.projectRoot, launch.command, [...launch.args]))) {
    throw untrustedExecutorCommandError(launch.command, options.executorName);
  }
  return launch;
}

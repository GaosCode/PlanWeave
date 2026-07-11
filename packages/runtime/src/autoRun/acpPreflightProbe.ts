import { createAcpConnection } from "./acpConnection.js";
import type { AcpPreflightProbe } from "./acpRunner.js";
import type { RunnerCapability } from "./runnerContractSchemas.js";
import type { InitializeResponse } from "@agentclientprotocol/sdk";

export function capabilitiesFromInitialize(initialized: InitializeResponse): RunnerCapability[] {
  const capabilities: RunnerCapability[] = [
    "session",
    "prompt",
    "cancel",
    "streaming",
    "tool-updates"
  ];
  const advertised = initialized.agentCapabilities;
  if (advertised?.promptCapabilities?.image === true) capabilities.push("image");
  if (advertised?.promptCapabilities?.embeddedContext === true) {
    capabilities.push("embedded-context");
  }
  if (advertised?.sessionCapabilities?.close != null) capabilities.push("session-close");
  if (advertised?.loadSession === true) capabilities.push("history-load");
  if (advertised?.auth?.logout != null) capabilities.push("authentication");
  return capabilities;
}

export const probeInstalledAcpAgent: AcpPreflightProbe = async ({ definition, cwd, signal }) => {
  const launch = definition.acp.launch;
  if (!launch) return { kind: "failed", message: "ACP launch metadata is unavailable." };
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const connection = createAcpConnection({
    launch: { trusted: true, command: launch.command, args: launch.args },
    cwd,
    env,
    clientInfo: { name: "PlanWeave", version: "0.1.0" }
  });
  try {
    const initialized = await connection.initialize({ signal });
    if ((initialized.authMethods?.length ?? 0) > 0) {
      return {
        kind: "auth_required",
        message: "ACP agent requires authentication using an advertised agent-owned method. Authenticate with the agent, then retry."
      };
    }
    return { kind: "ready", authenticated: true, capabilities: capabilitiesFromInitialize(initialized) };
  } finally {
    await connection.dispose();
  }
};

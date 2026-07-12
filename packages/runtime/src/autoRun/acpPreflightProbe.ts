import { createAcpConnection } from "./acpConnection.js";
import type { AcpPreflightProbe } from "./acpRunner.js";
import type { RunnerCapability } from "./runnerContractSchemas.js";
import { RequestError, type InitializeResponse } from "@agentclientprotocol/sdk";

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

function isAuthRequiredError(error: unknown): error is RequestError {
  if (!(error instanceof RequestError) || error.code !== -32000) return false;
  const message = error.message.trim();
  return message === "Authentication required" || message.startsWith("Authentication required:");
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
    let session;
    try {
      session = await connection.newSession({ cwd, mcpServers: [] }, { signal });
    } catch (error) {
      if (!isAuthRequiredError(error)) throw error;
      return {
        kind: "auth_required",
        message: "ACP agent requires authentication. Authenticate with the agent, then retry."
      };
    }
    if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
      await connection.closeSession(session.sessionId, { signal });
    }
    return { kind: "ready", authenticated: true, capabilities: capabilitiesFromInitialize(initialized) };
  } finally {
    await connection.dispose();
  }
};

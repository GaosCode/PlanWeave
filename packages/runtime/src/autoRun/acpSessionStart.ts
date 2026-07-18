import type { AgentCapabilities, NewSessionResponse } from "@agentclientprotocol/sdk";
import type { AcpConnection, AcpOperationOptions } from "./acpConnection.js";
import { acpSessionStartSchema, type AcpSessionStart } from "./acpRunRecovery.js";

export async function startAcpSession(options: {
  connection: AcpConnection;
  initializedCapabilities: AgentCapabilities | undefined;
  sessionStart: AcpSessionStart;
  cwd: string;
  operation: AcpOperationOptions;
  agentId: string;
  onRecoveryLoaded?: (sessionId: string) => void | Promise<void>;
}): Promise<NewSessionResponse> {
  const sessionStart = acpSessionStartSchema.parse(options.sessionStart);
  if (sessionStart.kind === "new") {
    return options.connection.newSession({ cwd: options.cwd, mcpServers: [] }, options.operation);
  }
  if (options.initializedCapabilities?.loadSession !== true) {
    throw new Error(
      `ACP agent '${options.agentId}' no longer advertises session/load for recovery.`
    );
  }
  const loaded = await options.connection.loadSession(
    { sessionId: sessionStart.sessionId, cwd: options.cwd, mcpServers: [] },
    options.operation
  );
  await options.onRecoveryLoaded?.(sessionStart.sessionId);
  return { sessionId: sessionStart.sessionId, ...loaded };
}

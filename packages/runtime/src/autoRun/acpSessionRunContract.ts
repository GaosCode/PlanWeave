import type { TerminalOutputRequest, TerminalOutputResponse } from "@agentclientprotocol/sdk";
import type {
  AcpCapabilityPolicy,
  AcpConnectionMode,
  AcpShutdownPolicy
} from "../acpProfile/schema.js";
import type { ResolvedAgentEnvironment } from "../process/agentProcessEnv.js";
import type { ExecutionHost } from "../types.js";
import type { AcpAuthenticationHints } from "./acpAuthentication.js";
import type { ActiveAgentRunIdentity } from "./activeAgentRunRegistry.js";
import type { AcpSessionStart } from "./acpRunRecovery.js";

export type AcpSessionRunKind = "implementation" | "review" | "feedback";

export type AcpSessionRun = {
  kind: AcpSessionRunKind;
  identity: Omit<ActiveAgentRunIdentity, "sessionId">;
  runDir: string;
  metadataPath: string;
  prompt: string;
  cwd: string;
  launch: { command: string; args: readonly string[] };
  host?: ExecutionHost;
  profileIdentity: {
    profileId: string;
    fingerprint: string;
    source: "builtin" | "local-user";
    environmentNames: readonly string[];
  };
  environment: ResolvedAgentEnvironment;
  shutdown: AcpShutdownPolicy;
  capabilityPolicy: AcpCapabilityPolicy;
  authenticationHints?: AcpAuthenticationHints;
  executorName: string;
  agentId: string;
  taskId: string;
  metadataIdentity: Record<string, string>;
  projectId?: string;
  canvasId?: string;
  projectRoot?: string;
  connectionMode?: AcpConnectionMode;
  sessionStart?: AcpSessionStart;
  terminalOutputHandler?: (
    request: TerminalOutputRequest
  ) => TerminalOutputResponse | Promise<TerminalOutputResponse>;
};

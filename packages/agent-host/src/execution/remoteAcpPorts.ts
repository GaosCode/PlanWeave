import type {
  AcpConnectionMode,
  AcpEngineElicitationRequest,
  AcpEngineInteractionBroker,
  AcpEngineInteractionContext,
  AcpEnginePermissionRequest,
  ExecuteAcpOptions,
  ExecutionHost
} from "@planweave-ai/runtime";
import type { CanvasRuntimeLogicalScope } from "@planweave-ai/agent-host-protocol";
import type {
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteExecutionRecord
} from "./remoteExecutionRecordSchema.js";
export {
  agentHostRemoteExecutionIdentitySchema,
  agentHostRemoteEngineEventSchema,
  agentHostRemoteExecutionRecordSchema,
  type AgentHostRemoteExecutionIdentity,
  type AgentHostRemoteExecutionRecord
} from "./remoteExecutionRecordSchema.js";

/** Append-only durable boundary. Implementations must commit before resolving append(). */
export interface AgentHostRemoteExecutionOutbox {
  append(record: AgentHostRemoteExecutionRecord): Promise<void> | void;
}

export interface AgentHostRemoteInteractionResponder {
  requestPermission(
    identity: AgentHostRemoteExecutionIdentity,
    request: AcpEnginePermissionRequest,
    context: AcpEngineInteractionContext
  ): ReturnType<AcpEngineInteractionBroker["requestPermission"]>;
  requestElicitation(
    identity: AgentHostRemoteExecutionIdentity,
    request: AcpEngineElicitationRequest,
    context: AcpEngineInteractionContext
  ): ReturnType<AcpEngineInteractionBroker["requestElicitation"]>;
}

export type ResolvedAgentHostWorkspace = { cwd: string };

export interface AgentHostWorkspaceResolver {
  resolve(
    workspaceId: string,
    ownerPackageLocator?: import("@planweave-ai/agent-host-protocol").OwnerPackageLocator
  ): Promise<ResolvedAgentHostWorkspace> | ResolvedAgentHostWorkspace;
}

export interface AgentHostRuntimeWorkspaceResolver {
  resolve(
    scope: CanvasRuntimeLogicalScope,
    expected: { sourceRevision: string; graphFingerprint: string }
  ): Promise<ResolvedAgentHostWorkspace> | ResolvedAgentHostWorkspace;
}

export type AgentHostAcpSessionProfile = {
  modes?: Readonly<Record<string, string>>;
  configOptions?: Readonly<
    Record<
      string,
      {
        configId: string;
        values: Readonly<Record<string, string | boolean>>;
      }
    >
  >;
};

export type ResolvedAgentHostAcpProfile = {
  agentId: string;
  capabilityPolicy: ExecuteAcpOptions["capabilityPolicy"];
  launch: Omit<ExecuteAcpOptions["launch"], "trusted">;
  env: Readonly<Record<string, string>>;
  shutdown: ExecuteAcpOptions["shutdown"];
  authentication?: ExecuteAcpOptions["authentication"];
  session?: AgentHostAcpSessionProfile;
  connection?: { mode: AcpConnectionMode };
  fingerprint?: string;
  host?: ExecutionHost;
};

export interface AgentHostAcpProfileResolver {
  resolve(
    agentProfileId: string,
    agentId: string
  ): Promise<ResolvedAgentHostAcpProfile> | ResolvedAgentHostAcpProfile;
}

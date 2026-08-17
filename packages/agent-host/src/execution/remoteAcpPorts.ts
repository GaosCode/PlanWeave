import type {
  AcpConnectionMode,
  AcpEngineElicitationRequest,
  AcpEngineInteractionBroker,
  AcpEngineInteractionContext,
  AcpEnginePermissionRequest,
  ExecuteAcpOptions,
  ExecutionHost
} from "@planweave-ai/runtime";
import { acpCapabilitySnapshotSchema } from "@planweave-ai/runtime";
import { z } from "zod";

export const agentHostRemoteExecutionIdentitySchema = z
  .object({
    dispatchId: z.string().min(1),
    leaseId: z.string().min(1),
    executionAttemptId: z.string().min(1)
  })
  .strict();
export type AgentHostRemoteExecutionIdentity = z.infer<
  typeof agentHostRemoteExecutionIdentitySchema
>;

const terminalSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("succeeded"), stopReason: z.string() }).strict(),
  z.object({ state: z.literal("cancelled"), message: z.string() }).strict(),
  z
    .object({
      state: z.literal("failed"),
      reason: z.enum([
        "authentication_required",
        "capability_missing",
        "interaction_failed",
        "interaction_timeout",
        "limit_exceeded",
        "operation_timeout",
        "process_error",
        "protocol_error",
        "event_sink_failed",
        "incomplete_response",
        "cleanup_failed",
        "unknown_error"
      ]),
      message: z.string()
    })
    .strict()
]);

const usageSchema = z
  .object({
    totalTokens: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    thoughtTokens: z.number().nullable(),
    cachedReadTokens: z.number().nullable(),
    cachedWriteTokens: z.number().nullable()
  })
  .strict();

const eventBase = { sequence: z.number().int().positive(), timestamp: z.string().datetime() };
export const agentHostRemoteEngineEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...eventBase,
      kind: z.literal("lifecycle"),
      state: z.enum(["connecting", "running", "cleanup"])
    })
    .strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal("capability_snapshot"),
      snapshot: acpCapabilitySnapshotSchema
    })
    .strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal("capabilities"),
      capabilities: z
        .object({
          loadSession: z.boolean(),
          closeSession: z.boolean(),
          prompt: z
            .object({ image: z.boolean(), audio: z.boolean(), embeddedContext: z.boolean() })
            .strict(),
          mcp: z.object({ http: z.boolean(), sse: z.boolean() }).strict(),
          client: z.object({ permission: z.literal(true), elicitation: z.boolean() }).strict()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal("session_started"),
      sessionId: z.string(),
      loaded: z.boolean()
    })
    .strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal("session_update"),
      sessionId: z.string(),
      body: z.object({ kind: z.string() }).loose()
    })
    .strict(),
  z.object({ ...eventBase, kind: z.literal("usage"), usage: usageSchema }).strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal("interaction"),
      requestId: z.string(),
      interaction: z.enum(["permission", "elicitation"]),
      state: z.enum(["requested", "resolved"]),
      outcome: z.enum(["selected", "cancelled", "accepted", "declined"]).optional()
    })
    .strict(),
  z.object({ ...eventBase, kind: z.literal("terminal"), terminal: terminalSchema }).strict()
]);

const permissionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    summary: z.string(),
    options: z.array(
      z
        .object({
          optionId: z.string().min(1),
          label: z.string(),
          decision: z.enum(["approve", "deny"])
        })
        .strict()
    )
  })
  .strict();

const elicitationRequestSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().nullable(),
    message: z.string(),
    requestedSchema: z.unknown()
  })
  .strict();

export const agentHostRemoteExecutionRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("engine_event"),
      identity: agentHostRemoteExecutionIdentitySchema,
      event: agentHostRemoteEngineEventSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("permission_request"),
      identity: agentHostRemoteExecutionIdentitySchema,
      request: permissionRequestSchema,
      deadline: z.string().datetime()
    })
    .strict(),
  z
    .object({
      kind: z.literal("elicitation_request"),
      identity: agentHostRemoteExecutionIdentitySchema,
      request: elicitationRequestSchema,
      deadline: z.string().datetime()
    })
    .strict()
]);
export type AgentHostRemoteExecutionRecord = z.infer<typeof agentHostRemoteExecutionRecordSchema>;

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

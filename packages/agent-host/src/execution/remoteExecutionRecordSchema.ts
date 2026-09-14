import { acpCapabilitySnapshotSchema } from "@planweave-ai/runtime";
import {
  acpPermissionOptionsSchema,
  engineTerminalLeafSchema,
  runnerBodyFragmentSchema
} from "@planweave-ai/agent-host-protocol";
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
      body: runnerBodyFragmentSchema
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
  z
    .object({ ...eventBase, kind: z.literal("terminal"), terminal: engineTerminalLeafSchema })
    .strict()
]);

export const legacyRemotePermissionRequestSchema = z
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

export const legacyAgentHostRemoteExecutionRecordSchema = z.discriminatedUnion("kind", [
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
      request: legacyRemotePermissionRequestSchema,
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
export const agentHostRemoteExecutionRecordSchema = z.discriminatedUnion("kind", [
  legacyAgentHostRemoteExecutionRecordSchema.options[0],
  legacyAgentHostRemoteExecutionRecordSchema.options[1].extend({
    request: legacyRemotePermissionRequestSchema.extend({ options: acpPermissionOptionsSchema })
  }),
  legacyAgentHostRemoteExecutionRecordSchema.options[2]
]);
export const historicalAgentHostRemoteExecutionRecordSchema = z.union([
  agentHostRemoteExecutionRecordSchema,
  legacyAgentHostRemoteExecutionRecordSchema
]);
export type AgentHostRemoteExecutionRecord = z.infer<typeof agentHostRemoteExecutionRecordSchema>;
export type HistoricalAgentHostRemoteExecutionRecord = z.infer<
  typeof historicalAgentHostRemoteExecutionRecordSchema
>;

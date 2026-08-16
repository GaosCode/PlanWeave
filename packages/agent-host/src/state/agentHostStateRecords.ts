import { z } from "zod";
import { acpCapabilitySnapshotSchema, type AcpCapabilitySnapshot } from "@planweave-ai/runtime";
import { parseAgentHostMailboxCommand, type MailboxCommand } from "../protocol.js";

export type ExecuteBlockCommand = Extract<MailboxCommand, { type: "execute_block" }>;
export type CancelExecutionCommand = Extract<MailboxCommand, { type: "cancel_execution" }>;
export type ResumeExecutionCommand = Extract<MailboxCommand, { type: "resume_execution" }>;

export const agentHostExecutionStatusSchema = z.enum([
  "accepted",
  "preparing",
  "running",
  "interaction_wait",
  "interrupted",
  "completed",
  "failed",
  "cancelled"
]);
export type AgentHostExecutionStatus = z.infer<typeof agentHostExecutionStatusSchema>;
const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;

export type AgentHostExecution = {
  sequence: number;
  messageId: string;
  command: ExecuteBlockCommand;
  status: AgentHostExecutionStatus;
  receivedAt: string;
  startedAt?: string;
  interruptedAt?: string;
  finishedAt?: string;
};

export type AgentHostExecutionEvidence = {
  sequence: number;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
  protocolVersion: number;
  envelopeDigest: string;
  envelopeVersion: number;
  workspaceId: string;
  agentProfileId: string;
  sourceRevision: string;
  status: AgentHostExecutionStatus;
  acpSessionId?: string;
  acpCapabilitySnapshot?: AcpCapabilitySnapshot;
  legacyAcpCapabilities?: JsonValue;
  recoveryId?: string;
  eventCursor: number;
  actionCursor: number;
  cancellationIntent?: JsonValue;
  recoveryIntent?: JsonValue;
  terminalKind?: "completed" | "failed" | "cancelled";
  terminalPayloadDigest?: string;
  terminalEventMessageId?: string;
  terminalAcknowledgedAt?: string;
};

export const executionRowSchema = z.object({
  sequence: z.number().int().positive(),
  message_id: z.string(),
  command_json: z.string(),
  lease_id: z.string().min(1),
  lease_expires_at: z.string().datetime(),
  status: agentHostExecutionStatusSchema,
  received_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  interrupted_at: z.string().datetime().nullable(),
  finished_at: z.string().datetime().nullable()
});

export const executionEvidenceRowSchema = z.object({
  inbox_sequence: z.number().int().positive(),
  dispatch_id: z.string().min(1),
  lease_id: z.string().min(1),
  execution_attempt_id: z.string().min(1),
  protocol_version: z.number().int().positive(),
  envelope_digest: z.string().min(1),
  envelope_version: z.number().int().positive(),
  workspace_id: z.string().min(1),
  agent_profile_id: z.string().min(1),
  source_revision: z.string().min(1),
  status: agentHostExecutionStatusSchema,
  acp_session_id: z.string().nullable(),
  acp_capabilities_json: z.string().nullable(),
  recovery_id: z.string().nullable(),
  event_cursor: z.number().int().nonnegative(),
  action_cursor: z.number().int().nonnegative(),
  cancellation_intent_json: z.string().nullable(),
  recovery_intent_json: z.string().nullable(),
  terminal_kind: z.enum(["completed", "failed", "cancelled"]).nullable(),
  terminal_payload_digest: z.string().nullable(),
  terminal_event_message_id: z.string().nullable(),
  terminal_acknowledged_at: z.string().datetime().nullable()
});

export const outboxRowSchema = z.object({ event_json: z.string() });

function parseJson(value: string | null): JsonValue | undefined {
  return value === null ? undefined : jsonValueSchema.parse(JSON.parse(value));
}

export function toExecution(raw: Record<string, unknown>): AgentHostExecution {
  const row = executionRowSchema.parse(raw);
  const command = parseAgentHostMailboxCommand(JSON.parse(row.command_json));
  if (command.type !== "execute_block") throw new Error("execute_block_record_required");
  const effectiveCommand = parseAgentHostMailboxCommand({
    ...command,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at
  });
  if (effectiveCommand.type !== "execute_block") throw new Error("execute_block_record_required");
  return {
    sequence: row.sequence,
    messageId: row.message_id,
    command: effectiveCommand,
    status: row.status,
    receivedAt: row.received_at,
    startedAt: row.started_at ?? undefined,
    interruptedAt: row.interrupted_at ?? undefined,
    finishedAt: row.finished_at ?? undefined
  };
}

export function toExecutionEvidence(raw: Record<string, unknown>): AgentHostExecutionEvidence {
  const row = executionEvidenceRowSchema.parse(raw);
  const storedCapabilities = parseJson(row.acp_capabilities_json);
  const capabilitySnapshot = acpCapabilitySnapshotSchema.safeParse(storedCapabilities);
  return {
    sequence: row.inbox_sequence,
    dispatchId: row.dispatch_id,
    leaseId: row.lease_id,
    executionAttemptId: row.execution_attempt_id,
    protocolVersion: row.protocol_version,
    envelopeDigest: row.envelope_digest,
    envelopeVersion: row.envelope_version,
    workspaceId: row.workspace_id,
    agentProfileId: row.agent_profile_id,
    sourceRevision: row.source_revision,
    status: row.status,
    acpSessionId: row.acp_session_id ?? undefined,
    ...(capabilitySnapshot.success
      ? { acpCapabilitySnapshot: capabilitySnapshot.data }
      : storedCapabilities === undefined
        ? {}
        : { legacyAcpCapabilities: storedCapabilities }),
    recoveryId: row.recovery_id ?? undefined,
    eventCursor: row.event_cursor,
    actionCursor: row.action_cursor,
    cancellationIntent: parseJson(row.cancellation_intent_json),
    recoveryIntent: parseJson(row.recovery_intent_json),
    terminalKind: row.terminal_kind ?? undefined,
    terminalPayloadDigest: row.terminal_payload_digest ?? undefined,
    terminalEventMessageId: row.terminal_event_message_id ?? undefined,
    terminalAcknowledgedAt: row.terminal_acknowledged_at ?? undefined
  };
}

import { acpConversationEventSchema } from "./acpConversationProtocol.js";

export const DEFAULT_HOST_EVENT_MAX_PAYLOAD_BYTES = 256 * 1024;
export const HOST_EVENT_PAYLOAD_BUDGET_VERSION_HEADER =
  "x-planweave-host-event-payload-budget-version";
export const HOST_EVENT_MAX_PAYLOAD_BYTES_HEADER = "x-planweave-host-event-max-payload-bytes";

export function hostEventPayloadBytes(payload: string, maxPayloadBytes: number): number {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1)
    throw new Error("agent_host_outbound_payload_budget_invalid");
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (bytes > maxPayloadBytes) throw new Error("agent_host_outbound_payload_too_large");
  return bytes;
}

export function requireHostEventPayloadBudget(input: string | string[] | undefined): number {
  if (typeof input !== "string" || !/^[1-9][0-9]*$/.test(input))
    throw new Error("agent_host_outbound_payload_budget_unsupported");
  const bytes = Number(input);
  if (!Number.isSafeInteger(bytes))
    throw new Error("agent_host_outbound_payload_budget_unsupported");
  return bytes;
}

export const ACP_CONVERSATION_FAILURE_CODE_MAX_LENGTH = 128;
export const ACP_CONVERSATION_MIN_HOST_EVENT_PAYLOAD_BYTES = new TextEncoder().encode(
  JSON.stringify(
    acpConversationEventSchema.parse({
      type: "acp_conversation.event",
      protocolVersion: 1,
      operationId: "\u0000".repeat(256),
      turnId: "\u0000".repeat(256),
      executionAttemptId: "\u0000".repeat(256),
      sessionId: "\u0000".repeat(1024),
      messageId: "00000000-0000-0000-0000-000000000000",
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: "9999-12-31T23:59:59.999Z",
      payload: {
        kind: "status",
        status: "failed",
        error: "acp_conversation_" + "x".repeat(ACP_CONVERSATION_FAILURE_CODE_MAX_LENGTH - 17)
      }
    })
  )
).byteLength;

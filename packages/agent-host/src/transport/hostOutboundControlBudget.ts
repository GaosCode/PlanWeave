import type { HostReadinessObservation } from "@planweave-ai/agent-host-protocol";
import { encodeAgentHostEvent, serializeAgentHostHello } from "../protocol.js";
import { hostEventPayloadBytes } from "@planweave-ai/agent-host-protocol";

export function assertHostOutboundControlBudget(
  maxPayloadBytes: number,
  capabilities: readonly string[],
  capacity: number,
  readiness: HostReadinessObservation
): void {
  const identity = {
    dispatchId: "d".repeat(128),
    leaseId: "l".repeat(128),
    executionAttemptId: "e".repeat(128)
  };
  const common = { protocolVersion: 1, messageId: "00000000-0000-0000-0000-000000000000" };
  try {
    hostEventPayloadBytes(
      serializeAgentHostHello({
        type: "host.hello",
        protocolVersion: 1,
        supportedExecutionEnvelopeVersions: [1, 2],
        lastAcknowledgedSequence: Number.MAX_SAFE_INTEGER,
        capabilities,
        capacity,
        readiness
      }),
      maxPayloadBytes
    );
    encodeAgentHostEvent(
      { ...common, type: "host.heartbeat", activeLeases: [], readiness },
      maxPayloadBytes
    );
    encodeAgentHostEvent(
      { ...common, type: "host.heartbeat", activeLeases: [identity] },
      maxPayloadBytes
    );
    encodeAgentHostEvent(
      {
        ...common,
        ...identity,
        type: "dispatch.failed",
        failure: {
          code: "agent_host_outbound_payload_too_large",
          message: "The execution result exceeds the negotiated Host event payload budget.",
          retryable: false
        }
      },
      maxPayloadBytes
    );
    encodeAgentHostEvent(
      {
        ...common,
        ...identity,
        type: "dispatch.interrupted",
        reason: "acp_session_lost",
        resumable: true,
        recovery: { acpSessionId: "s".repeat(128), recoveryId: "r".repeat(128) }
      },
      maxPayloadBytes
    );
    encodeAgentHostEvent(
      {
        ...common,
        type: "canvas_runtime.response",
        requestId: "r".repeat(128),
        response: {
          outcome: "error",
          operation: "resolve_work_items",
          error: {
            code: "agent_host_outbound_payload_too_large",
            message:
              "The Canvas Runtime response exceeds the negotiated Host event payload budget.",
            retryable: false,
            reconcileRequired: true
          }
        }
      },
      maxPayloadBytes
    );
  } catch (cause) {
    if (cause instanceof Error && cause.message === "agent_host_outbound_payload_too_large")
      throw new Error("agent_host_control_payload_budget_too_small", { cause });
    throw cause;
  }
}

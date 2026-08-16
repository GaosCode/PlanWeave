import { randomUUID } from "node:crypto";
import { parseAgentHostEvent, type HostEvent } from "../protocol.js";
import type { AgentHostExecutionEvidence } from "./agentHostStateRecords.js";

function advertisesSessionLoad(evidence: AgentHostExecutionEvidence): boolean {
  return evidence.acpCapabilitySnapshot?.negotiated.includes("history-load") === true;
}

export function createInterruptedEvent(
  evidence: AgentHostExecutionEvidence,
  reason: "host_restart" | "lease_lost" | "acp_session_lost",
  forceNonResumable = false
): HostEvent {
  const resumable =
    !forceNonResumable &&
    evidence.acpSessionId !== undefined &&
    evidence.recoveryId !== undefined &&
    advertisesSessionLoad(evidence);
  return parseAgentHostEvent({
    type: "dispatch.interrupted",
    protocolVersion: 1,
    messageId: randomUUID(),
    dispatchId: evidence.dispatchId,
    leaseId: evidence.leaseId,
    executionAttemptId: evidence.executionAttemptId,
    reason,
    resumable,
    ...(resumable
      ? {
          recovery: {
            acpSessionId: evidence.acpSessionId,
            recoveryId: evidence.recoveryId
          }
        }
      : {})
  });
}

import { z } from "zod";
import { AGENT_RUN_CONTROL_PROTOCOL_VERSION } from "./agentRunControlContract.js";

export const agentRunControlUnavailableReasonSchema = z.enum([
  "initializing",
  "identity_unavailable",
  "endpoint_start_failed",
  "owner_terminal"
]);

export const agentRunControlAvailabilitySummarySchema = z
  .object({
    controlAvailable: z.boolean(),
    controlProtocolVersion: z.literal(AGENT_RUN_CONTROL_PROTOCOL_VERSION),
    controlOwnerPid: z.number().int().positive().safe(),
    controlUnavailableReason: agentRunControlUnavailableReasonSchema.nullable()
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.controlAvailable === (summary.controlUnavailableReason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["controlUnavailableReason"],
        message: "Available control has no unavailable reason; unavailable control requires one."
      });
    }
  });

export type AgentRunControlAvailabilitySummary = z.infer<
  typeof agentRunControlAvailabilitySummarySchema
>;
export type AgentRunControlUnavailableReason = z.infer<
  typeof agentRunControlUnavailableReasonSchema
>;

export function availableAgentRunControlSummary(
  ownerPid = process.pid
): AgentRunControlAvailabilitySummary {
  return agentRunControlAvailabilitySummarySchema.parse({
    controlAvailable: true,
    controlProtocolVersion: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    controlOwnerPid: ownerPid,
    controlUnavailableReason: null
  });
}

export function unavailableAgentRunControlSummary(
  reason: AgentRunControlUnavailableReason,
  ownerPid = process.pid
): AgentRunControlAvailabilitySummary {
  return agentRunControlAvailabilitySummarySchema.parse({
    controlAvailable: false,
    controlProtocolVersion: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    controlOwnerPid: ownerPid,
    controlUnavailableReason: reason
  });
}

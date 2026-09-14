import { randomUUID } from "node:crypto";
import {
  historicalInteractionSettlementSchema,
  type HistoricalInteractionSettlement,
  type InteractionSettlement
} from "@planweave-ai/agent-host-protocol";
import { parseAgentHostEvent } from "../protocol.js";
import { AgentHostEventOutbox } from "./agentHostEventOutbox.js";
import { AgentHostExecutionRepository } from "./agentHostExecutionRepository.js";

export type AgentHostInteractionIdentity = {
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
  acpSessionId: string;
  actionId: string;
};

export class AgentHostInteractionSettlements {
  constructor(
    private readonly executions: AgentHostExecutionRepository,
    private readonly events: AgentHostEventOutbox
  ) {}

  get(identity: AgentHostInteractionIdentity): HistoricalInteractionSettlement | undefined {
    const execution = this.executions.findByIdentity(identity);
    if (!execution) return undefined;
    const settlement = this.executions.actionSettlement(
      execution.sequence,
      identity.acpSessionId,
      identity.actionId
    );
    return settlement === undefined
      ? undefined
      : historicalInteractionSettlementSchema.parse(settlement);
  }

  settle(command: InteractionSettlement, settledAt: string): void {
    const execution = this.executions.findByIdentity(command);
    if (!execution) throw new Error("execution_action_identity_stale");
    this.executions.settleAction(
      execution.sequence,
      {
        leaseId: command.leaseId,
        sessionId: command.acpSessionId,
        actionId: command.actionId,
        response: command
      },
      settledAt,
      command.type === "interaction.authentication_action" &&
        command.action === "retry_after_host_login"
    );
    if (command.type !== "interaction.authentication_action") return;
    if (command.action === "cancel") {
      this.executions.setIntent(execution.sequence, "cancellation", {
        kind: "authentication_cancelled",
        actionId: command.actionId
      });
      return;
    }
    const failure = {
      code: "agent_host_authentication_retry_unsupported",
      message: "This Agent Host cannot retry authentication for the current ACP process.",
      retryable: false
    } as const;
    const event = this.events.queue(
      `dispatch.failed:${command.dispatchId}:${command.leaseId}:${command.executionAttemptId}`,
      parseAgentHostEvent({
        type: "dispatch.failed",
        protocolVersion: 1,
        messageId: randomUUID(),
        dispatchId: command.dispatchId,
        leaseId: command.leaseId,
        executionAttemptId: command.executionAttemptId,
        failure
      })
    );
    this.executions.finish(execution.sequence, "failed", failure, event.messageId);
  }
}

import {
  assertInteractionIdentityMatches,
  exactPermissionSettlementSchema,
  interactionIdentitySchema,
  selectedAcpPermissionOptionId,
  type HistoricalInteractionSettlement,
  type InteractionSettlement,
  type MailboxCommand
} from "@planweave-ai/agent-host-protocol";
import type {
  AcpEngineElicitationRequest,
  AcpEngineInteractionContext,
  AcpEnginePermissionRequest
} from "@planweave-ai/runtime";
import type {
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteInteractionResponder
} from "./remoteAcpPorts.js";

type SettlementState = {
  interactionSettlement(command: InteractionSettlement): unknown | undefined;
  interactionSettlementByIdentity(identity: {
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
    acpSessionId: string;
    actionId: string;
  }): HistoricalInteractionSettlement | undefined;
};

type PendingSettlement = {
  resolve(command: HistoricalInteractionSettlement): void;
};

function key(
  identity: AgentHostRemoteExecutionIdentity,
  sessionId: string,
  actionId: string
): string {
  return [
    identity.dispatchId,
    identity.leaseId,
    identity.executionAttemptId,
    sessionId,
    actionId
  ].join("\0");
}

export class DurableAcpInteractionRelay implements AgentHostRemoteInteractionResponder {
  private readonly pending = new Map<string, PendingSettlement>();

  constructor(private readonly state: SettlementState) {}

  accept(command: MailboxCommand): AgentHostRemoteExecutionIdentity | undefined {
    if (
      command.type !== "interaction.permission_response" &&
      command.type !== "interaction.elicitation_response" &&
      command.type !== "interaction.authentication_action"
    ) {
      return undefined;
    }
    const settlement = this.state.interactionSettlement(command);
    if (settlement === undefined) throw new Error("interaction_settlement_not_durable");
    const pending = this.pending.get(key(command, command.acpSessionId, command.actionId));
    pending?.resolve(command);
    return command.type === "interaction.authentication_action" && command.action === "cancel"
      ? {
          dispatchId: command.dispatchId,
          leaseId: command.leaseId,
          executionAttemptId: command.executionAttemptId
        }
      : undefined;
  }

  async requestPermission(
    identity: AgentHostRemoteExecutionIdentity,
    request: AcpEnginePermissionRequest,
    context: AcpEngineInteractionContext
  ) {
    const settlement = await this.wait(identity, request.sessionId, request.requestId, context);
    if (settlement.type !== "interaction.permission_response") {
      throw new Error("interaction_response_type_mismatch");
    }
    if (settlement.decision === "allow_once") {
      throw new Error("legacy_permission_selection_unsupported");
    }
    if (context.signal.aborted) throw new Error("interaction_execution_aborted");
    if (context.deadline.getTime() <= Date.now()) throw new Error("interaction_deadline_expired");
    const exact = exactPermissionSettlementSchema.parse(settlement);
    assertInteractionIdentityMatches(
      interactionIdentitySchema.parse({
        ...identity,
        acpSessionId: request.sessionId,
        actionId: request.requestId
      }),
      exact
    );
    const optionId = selectedAcpPermissionOptionId(
      request.options,
      exact.decision === "deny"
        ? { decision: exact.decision }
        : { decision: exact.decision, optionId: exact.optionId }
    );
    return optionId === null ? { kind: "cancel" as const } : { kind: "select" as const, optionId };
  }

  async requestElicitation(
    identity: AgentHostRemoteExecutionIdentity,
    request: AcpEngineElicitationRequest,
    context: AcpEngineInteractionContext
  ) {
    if (!request.sessionId) return { action: "cancel" as const };
    const settlement = await this.wait(identity, request.sessionId, request.requestId, context);
    if (settlement.type !== "interaction.elicitation_response") {
      throw new Error("interaction_response_type_mismatch");
    }
    if (settlement.outcome === "cancelled") return { action: "cancel" as const };
    const text = settlement.response;
    if (text === undefined) throw new Error("interaction_elicitation_response_missing");
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch {
      content = { response: text };
    }
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      throw new Error("interaction_elicitation_response_invalid");
    }
    return { action: "accept" as const, content };
  }

  private wait(
    identity: AgentHostRemoteExecutionIdentity,
    sessionId: string,
    actionId: string,
    context: AcpEngineInteractionContext
  ): Promise<HistoricalInteractionSettlement> {
    if (context.signal.aborted) return Promise.reject(new Error("interaction_execution_aborted"));
    if (context.deadline.getTime() <= Date.now()) {
      return Promise.reject(new Error("interaction_deadline_expired"));
    }
    const settlementKey = key(identity, sessionId, actionId);
    const durableIdentity = {
      ...identity,
      acpSessionId: sessionId,
      actionId
    };
    const existing = this.state.interactionSettlementByIdentity(durableIdentity);
    if (existing) return Promise.resolve(existing);
    if (this.pending.has(settlementKey)) {
      return Promise.reject(new Error("interaction_waiter_conflict"));
    }
    return new Promise<HistoricalInteractionSettlement>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
        this.pending.delete(settlementKey);
      };
      const abort = (): void => {
        cleanup();
        reject(new Error("interaction_execution_aborted"));
      };
      const timeout = (): void => {
        cleanup();
        reject(new Error("interaction_deadline_expired"));
      };
      const timer = setTimeout(
        timeout,
        Math.min(2_147_483_647, Math.max(0, context.deadline.getTime() - Date.now()))
      );
      context.signal.addEventListener("abort", abort, { once: true });
      this.pending.set(settlementKey, {
        resolve: (command) => {
          cleanup();
          resolve(command);
        }
      });
      const raced = this.state.interactionSettlementByIdentity(durableIdentity);
      if (raced) this.pending.get(settlementKey)?.resolve(raced);
      if (context.signal.aborted) abort();
    });
  }
}

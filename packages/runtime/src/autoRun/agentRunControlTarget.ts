import {
  type ActiveAgentRunHandle,
  type ActiveAgentRunRegistry
} from "./activeAgentRunRegistry.js";
import type {
  AgentRunControlErrorCode,
  AgentRunControlReceiptResult,
  AgentRunControlRespondOutcome
} from "./agentRunControlContract.js";
import {
  runnerRequestActionIdentitySchema,
  runnerSessionActionIdentitySchema,
  type RunnerRequestActionIdentity,
  type RunnerSessionActionIdentity
} from "./runnerContractSchemas.js";

export type AgentRunControlTarget = {
  cancel(identity: RunnerSessionActionIdentity): Promise<AgentRunControlReceiptResult>;
  respond(
    identity: RunnerRequestActionIdentity,
    outcome: AgentRunControlRespondOutcome
  ): Promise<AgentRunControlReceiptResult>;
  followUp(
    identity: RunnerSessionActionIdentity,
    prompt: string
  ): Promise<AgentRunControlReceiptResult>;
};

export class AgentRunControlTargetError extends Error {
  constructor(
    readonly code: AgentRunControlErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentRunControlTargetError";
  }
}

const sessionIdentityFields = [
  "scope",
  "executorRunId",
  "desktopRunId",
  "runSessionId",
  "claimRef",
  "sessionId"
] as const satisfies readonly (keyof RunnerSessionActionIdentity)[];

function invalidIdentity(): AgentRunControlTargetError {
  return new AgentRunControlTargetError(
    "invalid_identity",
    "Control command identity does not match the endpoint owner."
  );
}

function sameSessionIdentity(
  expected: RunnerSessionActionIdentity,
  actual: RunnerSessionActionIdentity
): boolean {
  return sessionIdentityFields.every((field) => expected[field] === actual[field]);
}

export function createActiveAgentRunControlTarget(options: {
  registry: ActiveAgentRunRegistry;
  handle: ActiveAgentRunHandle;
  identity: RunnerSessionActionIdentity;
  now?: () => Date;
}): AgentRunControlTarget {
  const expectedIdentity = runnerSessionActionIdentitySchema.parse(options.identity);
  const now = options.now ?? (() => new Date());

  const currentHandle = (): ActiveAgentRunHandle => {
    let current: ActiveAgentRunHandle | null;
    try {
      current = options.registry.lookupExact(expectedIdentity);
    } catch {
      throw new AgentRunControlTargetError(
        "not_owner",
        "Control endpoint no longer owns the requested runner identity."
      );
    }
    if (current === null) {
      throw new AgentRunControlTargetError(
        "not_active",
        "Control endpoint owner is no longer active."
      );
    }
    if (current !== options.handle || current.ownership !== options.handle.ownership) {
      throw new AgentRunControlTargetError(
        "not_owner",
        "Control endpoint owner was replaced by a different live owner."
      );
    }
    if (current.lifecycleState !== "running" && current.lifecycleState !== "waiting_interaction") {
      throw new AgentRunControlTargetError(
        "not_active",
        "Control endpoint owner is not in an actionable lifecycle state."
      );
    }
    return current;
  };

  const assertSessionIdentity = (
    rawIdentity: RunnerSessionActionIdentity
  ): RunnerSessionActionIdentity => {
    const parsed = runnerSessionActionIdentitySchema.safeParse(rawIdentity);
    if (!parsed.success || !sameSessionIdentity(expectedIdentity, parsed.data)) {
      throw invalidIdentity();
    }
    return parsed.data;
  };

  const deliveryFailure = (message: string): AgentRunControlTargetError =>
    new AgentRunControlTargetError("delivery_failed", message);

  const delivered = (): AgentRunControlReceiptResult => ({
    status: "delivered",
    deliveredAt: now().toISOString()
  });

  return {
    async cancel(rawIdentity) {
      const identity = assertSessionIdentity(rawIdentity);
      const handle = currentHandle();
      if (!handle.control.interventionCapabilities.cancel) {
        throw new AgentRunControlTargetError(
          "capability_denied",
          "Live owner did not negotiate session cancellation."
        );
      }
      try {
        await options.registry.cancel(identity);
        return delivered();
      } catch (error) {
        if (error instanceof AgentRunControlTargetError) throw error;
        throw deliveryFailure("Live owner could not deliver session cancellation.");
      }
    },

    async respond(rawIdentity, outcome) {
      const parsed = runnerRequestActionIdentitySchema.safeParse(rawIdentity);
      if (!parsed.success || !sameSessionIdentity(expectedIdentity, parsed.data)) {
        throw invalidIdentity();
      }
      const handle = currentHandle();
      const request = handle.control.pendingRequests.get(parsed.data.requestId);
      if (!request) {
        throw new AgentRunControlTargetError(
          "request_not_pending",
          "Live owner no longer has the requested pending interaction."
        );
      }
      if (request.kind === "authentication") {
        throw new AgentRunControlTargetError(
          "capability_denied",
          "Authentication interactions cannot be answered through runner control."
        );
      }
      if (request.kind === "permission" && !handle.control.interventionCapabilities.permission) {
        throw new AgentRunControlTargetError(
          "capability_denied",
          "Live owner did not negotiate permission intervention."
        );
      }
      if (
        request.kind === "elicitation" &&
        !handle.control.interventionCapabilities.elicitationPreview
      ) {
        throw new AgentRunControlTargetError(
          "capability_denied",
          "Live owner did not negotiate elicitation intervention."
        );
      }
      try {
        await options.registry.respond(parsed.data, outcome);
        return delivered();
      } catch (error) {
        if (error instanceof AgentRunControlTargetError) throw error;
        if (!handle.control.pendingRequests.has(parsed.data.requestId)) {
          throw new AgentRunControlTargetError(
            "request_not_pending",
            "Live owner no longer has the requested pending interaction."
          );
        }
        throw deliveryFailure("Live owner could not deliver the interaction response.");
      }
    },

    async followUp(rawIdentity, prompt) {
      const identity = assertSessionIdentity(rawIdentity);
      const handle = currentHandle();
      if (handle.control.pendingRequests.size > 0) {
        throw new AgentRunControlTargetError(
          "request_not_pending",
          "Follow-up delivery is blocked by a pending interaction."
        );
      }
      try {
        await options.registry.queuePrompt(identity, prompt);
        return delivered();
      } catch (error) {
        if (error instanceof AgentRunControlTargetError) throw error;
        throw deliveryFailure("Live owner could not deliver the follow-up prompt.");
      }
    }
  };
}

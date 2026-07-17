import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  type ActiveAgentRunRegistry,
  activeAgentRunRegistry,
  type ActiveAgentRunHandle
} from "./activeAgentRunRegistry.js";
import {
  AgentRunControlClient,
  type AgentRunControlClientOptions
} from "./agentRunControlClient.js";
import {
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlActionSchema,
  agentRunControlCommandSchema,
  agentRunControlLeaseIdSchema,
  type AgentRunControlAction,
  type AgentRunControlCommand,
  type AgentRunControlEndpointDescriptor,
  type AgentRunControlResponse
} from "./agentRunControlContract.js";
import { readAgentRunControlDescriptor } from "./agentRunControlEndpoint.js";
import {
  agentRunControlErrorResponse,
  dispatchAgentRunControlCommand
} from "./agentRunControlExecution.js";
import { createActiveAgentRunControlTarget } from "./agentRunControlTarget.js";
import { runnerSessionActionIdentitySchema } from "./runnerContractSchemas.js";

export type AgentRunControlLocatorOptions = {
  registry?: ActiveAgentRunRegistry;
  now?: () => Date;
  randomUUID?: () => string;
  clientOptions?: AgentRunControlClientOptions;
  clientFactory?: (descriptor: AgentRunControlEndpointDescriptor) => AgentRunControlClient;
};

function commandFor(
  action: AgentRunControlAction,
  leaseId: AgentRunControlCommand["leaseId"],
  nextUuid: () => string
): AgentRunControlCommand {
  return agentRunControlCommandSchema.parse({
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    commandId: nextUuid(),
    leaseId,
    ...action
  });
}

export class AgentRunControlLocator {
  private readonly registry: ActiveAgentRunRegistry;
  private readonly now: () => Date;
  private readonly nextUUID: () => string;
  private readonly clientFactory: (
    descriptor: AgentRunControlEndpointDescriptor
  ) => AgentRunControlClient;

  constructor(options: AgentRunControlLocatorOptions = {}) {
    this.registry = options.registry ?? activeAgentRunRegistry;
    this.now = options.now ?? (() => new Date());
    this.nextUUID = options.randomUUID ?? randomUUID;
    this.clientFactory =
      options.clientFactory ??
      ((descriptor) => new AgentRunControlClient(descriptor, options.clientOptions));
  }

  async execute(
    runDir: string,
    rawAction: AgentRunControlAction
  ): Promise<AgentRunControlResponse> {
    const parsed = agentRunControlActionSchema.safeParse(rawAction);
    if (!parsed.success) {
      return agentRunControlErrorResponse(
        null,
        parsed.error.issues.some((issue) => issue.path[0] === "identity")
          ? "invalid_identity"
          : "protocol_mismatch",
        "Control action does not match the application contract."
      );
    }
    const action = parsed.data;
    const sessionIdentity = runnerSessionActionIdentitySchema.parse(
      action.kind === "respond"
        ? {
            scope: action.identity.scope,
            executorRunId: action.identity.executorRunId,
            desktopRunId: action.identity.desktopRunId,
            runSessionId: action.identity.runSessionId,
            claimRef: action.identity.claimRef,
            sessionId: action.identity.sessionId
          }
        : action.identity
    );
    let handle: ActiveAgentRunHandle | null;
    try {
      handle = this.registry.lookupExact(sessionIdentity);
    } catch {
      return agentRunControlErrorResponse(
        null,
        "invalid_identity",
        "Control action identity conflicts with the current live owner."
      );
    }

    if (handle) return this.executeInProcess(handle, action, sessionIdentity);

    let descriptor: AgentRunControlEndpointDescriptor | null;
    try {
      descriptor = await readAgentRunControlDescriptor(runDir);
    } catch (error) {
      return agentRunControlErrorResponse(
        null,
        error instanceof SyntaxError || error instanceof ZodError
          ? "protocol_mismatch"
          : "delivery_failed",
        "Persisted control endpoint descriptor could not be read."
      );
    }
    if (!descriptor) {
      return agentRunControlErrorResponse(
        null,
        "not_active",
        "No active control owner is published for this run."
      );
    }
    const command = commandFor(action, descriptor.leaseId, this.nextUUID);
    return this.clientFactory(descriptor).execute(command);
  }

  private executeInProcess(
    handle: ActiveAgentRunHandle,
    action: AgentRunControlAction,
    identity: ReturnType<typeof runnerSessionActionIdentitySchema.parse>
  ): Promise<AgentRunControlResponse> {
    const leaseId = agentRunControlLeaseIdSchema.safeParse(handle.agentRunControlLeaseId);
    if (!leaseId.success) {
      return Promise.resolve(
        agentRunControlErrorResponse(
          null,
          "not_active",
          "Current live owner has no active control lease."
        )
      );
    }
    const command = commandFor(action, leaseId.data, this.nextUUID);
    return dispatchAgentRunControlCommand({
      command,
      target: createActiveAgentRunControlTarget({
        registry: this.registry,
        handle,
        identity,
        now: this.now
      }),
      leaseId: leaseId.data,
      ownerPid: process.pid,
      acceptedAt: this.now().toISOString()
    });
  }
}

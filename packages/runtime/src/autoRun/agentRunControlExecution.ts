import {
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlCommandIdSchema,
  agentRunControlCommandSchema,
  agentRunControlErrorResponseSchema,
  agentRunControlSuccessReceiptSchema,
  type AgentRunControlCommand,
  type AgentRunControlCommandId,
  type AgentRunControlErrorCode,
  type AgentRunControlLeaseId,
  type AgentRunControlResponse
} from "./agentRunControlContract.js";
import { AgentRunControlTargetError, type AgentRunControlTarget } from "./agentRunControlTarget.js";

export type AgentRunControlCommandParseResult =
  | { success: true; command: AgentRunControlCommand }
  | { success: false; response: AgentRunControlResponse };

export function agentRunControlErrorResponse(
  commandId: AgentRunControlCommandId | null,
  code: AgentRunControlErrorCode,
  message: string
): AgentRunControlResponse {
  return agentRunControlErrorResponseSchema.parse({
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    ok: false,
    commandId,
    code,
    message
  });
}

function parsedCommandId(value: unknown): AgentRunControlCommandId | null {
  if (typeof value !== "object" || value === null || !("commandId" in value)) return null;
  const parsed = agentRunControlCommandIdSchema.safeParse(value.commandId);
  return parsed.success ? parsed.data : null;
}

export function parseAgentRunControlCommand(value: unknown): AgentRunControlCommandParseResult {
  const commandId = parsedCommandId(value);
  const parsed = agentRunControlCommandSchema.safeParse(value);
  if (parsed.success) return { success: true, command: parsed.data };
  const code = parsed.error.issues.some((issue) => issue.path[0] === "identity")
    ? "invalid_identity"
    : "protocol_mismatch";
  return {
    success: false,
    response: agentRunControlErrorResponse(
      commandId,
      code,
      "Control command does not match the protocol contract."
    )
  };
}

export function validateAgentRunControlLease(
  command: AgentRunControlCommand,
  leaseId: AgentRunControlLeaseId
): AgentRunControlResponse | null {
  return command.leaseId === leaseId
    ? null
    : agentRunControlErrorResponse(
        command.commandId,
        "stale_lease",
        "Control command lease is not owned by this endpoint."
      );
}

export async function dispatchAgentRunControlCommand(options: {
  command: AgentRunControlCommand;
  target: AgentRunControlTarget;
  leaseId: AgentRunControlLeaseId;
  ownerPid: number;
  acceptedAt: string;
}): Promise<AgentRunControlResponse> {
  try {
    const result =
      options.command.kind === "cancel"
        ? await options.target.cancel(options.command.identity)
        : options.command.kind === "respond"
          ? await options.target.respond(options.command.identity, options.command.outcome)
          : await options.target.followUp(options.command.identity, options.command.prompt);
    return agentRunControlSuccessReceiptSchema.parse({
      version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
      ok: true,
      commandId: options.command.commandId,
      acceptedAt: options.acceptedAt,
      ownerPid: options.ownerPid,
      leaseId: options.leaseId,
      result
    });
  } catch (error) {
    if (error instanceof AgentRunControlTargetError) {
      return agentRunControlErrorResponse(options.command.commandId, error.code, error.message);
    }
    return agentRunControlErrorResponse(
      options.command.commandId,
      "delivery_failed",
      "Live owner failed while delivering the control command."
    );
  }
}

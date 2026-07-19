import { createConnection } from "node:net";
import {
  AGENT_RUN_CONTROL_MAX_FRAME_BYTES,
  agentRunControlEndpointDescriptorSchema,
  agentRunControlResponseSchema,
  type AgentRunControlCommand,
  type AgentRunControlEndpointDescriptor,
  type AgentRunControlResponse
} from "./agentRunControlContract.js";
import {
  agentRunControlErrorResponse,
  parseAgentRunControlCommand,
  validateAgentRunControlLease
} from "./agentRunControlExecution.js";

export const AGENT_RUN_CONTROL_DEFAULT_CLIENT_TIMEOUT_MS = 15_000;

const FRAME_HEADER_BYTES = 4;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type AgentRunControlClientOptions = {
  timeoutMs?: number;
};

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function commandFrame(command: AgentRunControlCommand): Buffer {
  const payload = Buffer.from(JSON.stringify(command), "utf8");
  const result = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, FRAME_HEADER_BYTES);
  return result;
}

export class AgentRunControlClient {
  private readonly descriptor: AgentRunControlEndpointDescriptor;
  private readonly timeoutMs: number;

  constructor(
    descriptor: AgentRunControlEndpointDescriptor,
    options: AgentRunControlClientOptions = {}
  ) {
    this.descriptor = agentRunControlEndpointDescriptorSchema.parse(descriptor);
    this.timeoutMs = positiveSafeInteger(
      options.timeoutMs ?? AGENT_RUN_CONTROL_DEFAULT_CLIENT_TIMEOUT_MS,
      "timeoutMs"
    );
  }

  execute(rawCommand: AgentRunControlCommand): Promise<AgentRunControlResponse> {
    const parsed = parseAgentRunControlCommand(rawCommand);
    if (!parsed.success) return Promise.resolve(parsed.response);
    const command = parsed.command;
    const leaseError = validateAgentRunControlLease(command, this.descriptor.leaseId);
    if (leaseError) return Promise.resolve(leaseError);

    return new Promise((resolve) => {
      const socket = createConnection(this.descriptor.address);
      let buffered = Buffer.alloc(0);
      let settled = false;

      const settle = (response: AgentRunControlResponse): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(response);
      };
      const fail = (code: "delivery_failed" | "protocol_mismatch", message: string): void => {
        settle(agentRunControlErrorResponse(command.commandId, code, message));
      };

      socket.setNoDelay(true);
      socket.setTimeout(this.timeoutMs);
      socket.once("connect", () => socket.write(commandFrame(command)));
      socket.on("data", (chunk) => {
        if (settled) return;
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > FRAME_HEADER_BYTES + AGENT_RUN_CONTROL_MAX_FRAME_BYTES) {
          fail("protocol_mismatch", "Control response frame exceeds the protocol limit.");
          return;
        }
        if (buffered.byteLength < FRAME_HEADER_BYTES) return;
        const payloadLength = buffered.readUInt32BE(0);
        if (payloadLength < 1 || payloadLength > AGENT_RUN_CONTROL_MAX_FRAME_BYTES) {
          fail("protocol_mismatch", "Control response frame length is outside the protocol limit.");
          return;
        }
        if (buffered.byteLength < FRAME_HEADER_BYTES + payloadLength) return;
        if (buffered.byteLength !== FRAME_HEADER_BYTES + payloadLength) {
          fail("protocol_mismatch", "Control response contains unexpected trailing bytes.");
          return;
        }
        try {
          const response = agentRunControlResponseSchema.parse(
            JSON.parse(utf8Decoder.decode(buffered.subarray(FRAME_HEADER_BYTES))) as unknown
          );
          if (response.commandId !== command.commandId) {
            fail(
              "protocol_mismatch",
              "Control response command identity does not match the request."
            );
            return;
          }
          if (
            response.ok &&
            (response.leaseId !== this.descriptor.leaseId ||
              response.ownerPid !== this.descriptor.ownerPid)
          ) {
            fail(
              "protocol_mismatch",
              "Control response owner identity does not match the endpoint."
            );
            return;
          }
          settle(response);
        } catch {
          fail("protocol_mismatch", "Control response is not valid UTF-8 protocol JSON.");
        }
      });
      socket.once("timeout", () => {
        fail("delivery_failed", "Control endpoint response timed out.");
      });
      socket.once("error", () => {
        fail("delivery_failed", "Control endpoint could not deliver the command.");
      });
      socket.once("close", () => {
        if (!settled) fail("delivery_failed", "Control endpoint closed before responding.");
      });
    });
  }
}

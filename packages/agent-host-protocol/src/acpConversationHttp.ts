import type { AcpConversationAction } from "./acpConversationProtocol.js";

export const REMOTE_CONTROL_HTTP_BODY_MAX_BYTES = 64 * 1024;

export function acpConversationHttpBodyBytes(action: AcpConversationAction): number {
  return new TextEncoder().encode(JSON.stringify(action)).byteLength;
}

import { ZodError } from "zod";
import {
  OPAQUE_IDENTIFIER_MAX_LENGTH,
  PROTOCOL_ERROR_MESSAGE_MAX_LENGTH
} from "@planweave-ai/agent-host-protocol";

/** Wire-safe rejection details for protocol.error (never include free-form paths or secrets). */
export type PublicHostProtocolRejection = {
  code: string;
  message: string;
};

const STABLE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERIC_CODE = "event_rejected";
const GENERIC_MESSAGE = "The server rejected the host event.";
const OPERATOR_LOG_MESSAGE_MAX_LENGTH = 240;

function truncateMessage(value: string): string {
  if (value.length <= PROTOCOL_ERROR_MESSAGE_MAX_LENGTH) return value;
  return `${value.slice(0, PROTOCOL_ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}

function redactOperatorText(value: string): string {
  return value
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/(?:\/(?:Users|home)\/[^\s"']+|C:\\Users\\[^\s"']+)/gi, "<redacted-user-path>");
}

function clampOperatorText(value: string): string {
  const redacted = redactOperatorText(value);
  if (redacted.length <= OPERATOR_LOG_MESSAGE_MAX_LENGTH) return redacted;
  return `${redacted.slice(0, OPERATOR_LOG_MESSAGE_MAX_LENGTH - 1)}…`;
}

function operatorRejectionDetail(error: unknown): { name: string; summary: string } {
  if (error instanceof ZodError) {
    return { name: "ZodError", summary: clampOperatorText(zodIssueSummary(error)) };
  }
  if (error instanceof Error) {
    return { name: error.name, summary: clampOperatorText(error.message) };
  }
  return { name: "unknown", summary: clampOperatorText(String(error)) };
}

function clampCode(value: string): string {
  if (value.length <= OPAQUE_IDENTIFIER_MAX_LENGTH && STABLE_ERROR_CODE.test(value)) return value;
  return GENERIC_CODE;
}

function zodIssueSummary(error: ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      // Codes and paths only — never include received values that may hold secrets.
      return `${path}:${issue.code}`;
    })
    .join("; ");
}

/**
 * Map an internal host-event failure into a redacted protocol.error payload.
 * Operator logs keep a compact, redacted summary; the wire message is intentionally limited.
 */
export function publicHostProtocolRejection(error: unknown): PublicHostProtocolRejection {
  if (error instanceof ZodError) {
    const summary = zodIssueSummary(error);
    return {
      code: "schema_invalid",
      message: truncateMessage(
        summary.length > 0
          ? `Host event failed schema validation: ${summary}`
          : "Host event failed schema validation."
      )
    };
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message === "invalid_json" || message === "binary_messages_not_supported") {
      return { code: message, message };
    }
    if (message === "mailbox_cursor_not_acknowledged") {
      return {
        code: message,
        message:
          "Host hello lastAcknowledgedSequence is ahead of the Server mailbox cursor; reset Host durable state or re-enroll."
      };
    }
    if (message.startsWith("host_event_unsupported:")) {
      const eventType = message.slice("host_event_unsupported:".length);
      const code = clampCode(`host_event_unsupported:${eventType || "unknown"}`);
      return {
        code,
        message: truncateMessage(
          `Host event type is not supported by this Server: ${eventType || "unknown"}`
        )
      };
    }
    // Stable machine codes (snake_case / dotted) may be returned as-is.
    if (STABLE_ERROR_CODE.test(message) && !/[\\/]/.test(message) && !/\s/.test(message)) {
      return { code: clampCode(message), message: truncateMessage(message) };
    }
  }
  return { code: GENERIC_CODE, message: GENERIC_MESSAGE };
}

export function logHostProtocolRejection(input: {
  hostId: string;
  phase: "hello" | "event";
  error: unknown;
  publicRejection: PublicHostProtocolRejection;
}): void {
  console.error(
    JSON.stringify({
      scope: "agent-host-ws",
      event: "host_event_rejected",
      hostId: input.hostId,
      phase: input.phase,
      publicCode: input.publicRejection.code,
      publicMessage: input.publicRejection.message,
      error: operatorRejectionDetail(input.error)
    })
  );
}
